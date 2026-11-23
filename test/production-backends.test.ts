import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createAwsBackend } from '../src/execution/aws.ts';
import {
  acquireLeases,
  deploymentScope,
  encryptionContext,
  openStoredJournal,
  readStoredJournal,
  readUnfinishedPlan,
  scopeKey,
} from '../src/execution/backends.ts';
import { applyPlan } from '../src/execution/index.ts';
import { signEnvelope } from '../src/execution/transactions.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, deployerB, fixture, fixtureMany, startAnvil } from './execution/chain.ts';

const chainIdentity = { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` };
const scope = deploymentScope({ project: 'test', environment: 'dev', label: 'one' }, chainIdentity);
const planHash = `0x${'bb'.repeat(32)}`;

import { memoryBackend as createMemoryBackend } from './execution/memory-backend.ts';
const memoryBackend = () => createMemoryBackend(scope);

test('scope keys change for every deployment identity field', () => {
  const variants = [
    { ...scope, project: 'other' },
    { ...scope, environment: 'prod' },
    { ...scope, chainId: 1 },
    { ...scope, genesisHash: `0x${'cc'.repeat(32)}` },
    { ...scope, label: 'two' },
  ];
  for (const variant of variants) assert.notEqual(scopeKey(scope), scopeKey(variant));
});

test('a signer lease blocks another label and old fencing tokens cannot write', async () => {
  const backend = memoryBackend();
  const addresses = [deployerA.address];
  const first = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses,
    planHash,
    principal: 'runner-a',
  });
  const otherLabel = { ...scope, label: 'two' };
  await assert.rejects(
    acquireLeases({
      lockProvider: backend.lockProvider,
      scope: otherLabel,
      addresses,
      planHash,
      principal: 'runner-b',
    }),
    /Writer lock is held/,
  );
  await first.release();
  const second = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope: otherLabel,
    addresses,
    planHash,
    principal: 'runner-b',
  });
  try {
    assert.ok(second.fence[1].token > first.fence[1].token);
    await assert.rejects(first.assertHeld(), /Writer lease is lost/);
    await assert.rejects(
      backend.stateStore.compareAndSwap(scope, null, { sample: true }, { fence: first.fence }),
      /fence/,
    );
    await assert.rejects(
      backend.journalStore.append(
        scope,
        { sequence: 1, previousHash: null },
        { expectedSequence: 1, expectedPreviousHash: null, fence: first.fence },
      ),
      /fence/,
    );
  } finally {
    await second.release();
  }
});

test('a queued remote append checks its lease when it runs, not when it was requested', async () => {
  const backend = memoryBackend();
  const leases = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses: [deployerA.address],
    planHash,
    principal: 'runner-a',
  });
  let lost = false;
  let firstWriteStored;
  let finishFirstWrite;
  const stored = new Promise((resolve) => (firstWriteStored = resolve));
  const finish = new Promise((resolve) => (finishFirstWrite = resolve));
  try {
    const journal = await openStoredJournal({
      ...backend,
      journalStore: {
        ...backend.journalStore,
        async append(...args) {
          await backend.journalStore.append(...args);
          firstWriteStored();
          await finish;
        },
      },
      scope,
      fence: leases.fence,
      async assertHeld() {
        if (lost) throw Object.assign(new Error('Writer lease is lost.'), { code: 'lease-lost' });
      },
    });
    const intent = (actionId) =>
      journal.append({
        planHash,
        chain: chainIdentity,
        actionId,
        phase: 'intent',
        signer: deployerA.address,
        nonce: '0',
        principal: 'runner-a',
      });
    const first = intent('contract:alpha');
    const queued = intent('contract:beta');
    await stored;
    lost = true;
    finishFirstWrite();
    await first;
    await assert.rejects(queued, { code: 'lease-lost' });
    assert.deepEqual(
      backend.records.map((record) => record.actionId),
      ['contract:alpha'],
    );
  } finally {
    await leases.release();
  }
});

test('a rejected stored append writes nothing and keeps the journal position', async () => {
  const backend = memoryBackend();
  const leases = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses: [deployerA.address],
    planHash,
    principal: 'runner-a',
  });
  let writes = 0;
  let storeFails = false;
  const stored = {
    ...backend,
    journalStore: {
      ...backend.journalStore,
      async append(...args) {
        writes++;
        if (storeFails) throw new Error('store unavailable');
        return backend.journalStore.append(...args);
      },
    },
    scope,
    fence: leases.fence,
    assertHeld: async () => {},
  };
  const intent = {
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    phase: 'intent',
    signer: deployerA.address,
    nonce: '0',
    principal: 'runner-a',
  };
  try {
    const journal = await openStoredJournal(stored);
    const first = await journal.append(intent);
    await assert.rejects(journal.append({ ...intent, principal: '' }), /lacks audit metadata/);
    await assert.rejects(journal.append({ ...intent, phase: 'unknown' }), /invalid identity/);
    assert.equal(writes, 1, 'an invalid record does not reach the store');
    storeFails = true;
    await assert.rejects(journal.append(intent), /store unavailable/);
    storeFails = false;
    const second = await journal.append({ ...intent, actionId: 'contract:beta' });
    assert.deepEqual([second.sequence, second.previousHash], [2, first.recordHash]);
    assert.deepEqual(
      journal.records.map((record) => record.actionId),
      ['contract:alpha', 'contract:beta'],
    );
    // Opening validates the complete chain that the appends validated one record at a time.
    assert.equal((await openStoredJournal(stored)).records.length, 2);
  } finally {
    await leases.release();
  }
});

/** A store that writes at most `limit` records of a run in one write, as one atomic step. */
function batchingStore(backend, limit) {
  const batches = [];
  let failAt = null;
  return {
    batches,
    failOn(call) {
      failAt = call;
    },
    journalStore: {
      ...backend.journalStore,
      async appendBatch(deployment, records, { fence }) {
        if (batches.length + 1 === failAt) {
          failAt = null;
          throw new Error('store unavailable');
        }
        const batch = records.slice(0, limit);
        for (const record of batch)
          await backend.journalStore.append(deployment, record, {
            expectedSequence: record.sequence,
            expectedPreviousHash: record.previousHash,
            fence,
          });
        batches.push(batch.map((record) => record.actionId));
        return batch.length;
      },
    },
  };
}

test('a stored journal writes a run of records in chunks that are always a valid stored prefix', async () => {
  const backend = memoryBackend();
  const leases = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses: [deployerA.address],
    planHash,
    principal: 'runner-a',
  });
  const store = batchingStore(backend, 2);
  const options = { ...backend, scope, fence: leases.fence, assertHeld: async () => {} };
  const intents = (...names) =>
    names.map((name) => ({
      planHash,
      chain: chainIdentity,
      actionId: `contract:${name}`,
      phase: 'intent',
      signer: deployerA.address,
      nonce: '0',
      principal: 'runner-a',
    }));
  const stored = () => backend.records.map((record) => record.actionId);
  try {
    assert.equal((await openStoredJournal(options)).appendAll, undefined, 'no batch support');
    const journal = await openStoredJournal({ ...options, journalStore: store.journalStore });
    const written = await journal.appendAll(intents('a', 'b', 'c', 'd', 'e'));
    assert.deepEqual(store.batches, [
      ['contract:a', 'contract:b'],
      ['contract:c', 'contract:d'],
      ['contract:e'],
    ]);
    assert.deepEqual(
      written.map((record) => record.sequence),
      [1, 2, 3, 4, 5],
    );

    // The second chunk of the next run fails. The first chunk stays, and the journal agrees with the store.
    store.failOn(5);
    await assert.rejects(journal.appendAll(intents('f', 'g', 'h')), /store unavailable/);
    assert.deepEqual(stored().slice(5), ['contract:f', 'contract:g']);
    assert.deepEqual(
      journal.records.map((record) => record.actionId),
      stored(),
    );
    const next = await journal.append(intents('i')[0]);
    assert.deepEqual([next.sequence, next.previousHash], [8, backend.records[6].recordHash]);
    await assert.rejects(
      journal.appendAll([{ ...intents('j')[0], phase: 'signed' }]),
      /no signed record/,
    );
    // Opening validates the complete chain that the chunks wrote.
    assert.equal((await openStoredJournal(options)).records.length, 8);
  } finally {
    await leases.release();
  }
});

test('stored journal detects a changed record and a missing tail', async () => {
  const backend = memoryBackend();
  const journal = await openStoredJournal({
    ...backend,
    scope,
    fence: [],
    assertHeld: async () => {},
  });
  const record = await journal
    .append({
      planHash,
      chain: chainIdentity,
      actionId: 'contract:alpha',
      phase: 'intent',
      signer: deployerA.address,
      nonce: '0',
      principal: 'test-runner',
    })
    .catch(() => null);
  assert.equal(record, null, 'the store rejects writes without a fence');

  const original = {
    formatVersion: 2,
    sequence: 1,
    previousHash: null,
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    phase: 'intent',
    signer: deployerA.address,
    nonce: '0',
    principal: 'test-runner',
    at: new Date().toISOString(),
  };
  const { hashJson } = await import('../src/identity.ts');
  backend.records.push({ ...original, recordHash: hashJson(original) });
  backend.records[0].nonce = '1';
  await assert.rejects(
    openStoredJournal({ ...backend, scope, fence: [], assertHeld: async () => {} }),
    /Journal integrity failure/,
  );
  backend.records[0].nonce = '0';
  const savedHead = backend.journalStore.head;
  backend.journalStore.head = async () => ({ sequence: 2, recordHash: `0x${'dd'.repeat(32)}` });
  await assert.rejects(
    openStoredJournal({ ...backend, scope, fence: [], assertHeld: async () => {} }),
    /Journal head differs/,
  );
  backend.journalStore.head = savedHead;
});

test('AWS journal rejects an invalid first predecessor before any write', async () => {
  let writes = 0;
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send() {
        writes++;
      },
    },
    kms: {},
    s3: {},
  });
  const record = { sequence: 1, previousHash: planHash };
  await assert.rejects(
    backend.journalStore.append(scope, record, {
      expectedSequence: 1,
      expectedPreviousHash: planHash,
      fence: [],
    }),
    /exact expected sequence/,
  );
  assert.equal(writes, 0);
});

test('AWS state and journal writes check both leases transactionally', async () => {
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
      },
    },
    kms: {},
    s3: {},
  });
  const fence = [
    {
      scope: { ...scope, kind: 'deployment' },
      token: 4,
      holderId: 'runner',
      principal: 'test-runner',
    },
    {
      scope: { ...scope, kind: 'signer', address: deployerA.address },
      token: 9,
      holderId: 'runner',
      principal: 'test-runner',
    },
  ];
  await backend.stateStore.compareAndSwap(scope, null, { sample: true }, { fence });
  await backend.journalStore.append(
    scope,
    { sequence: 1, previousHash: null, recordHash: planHash, at: new Date().toISOString() },
    { expectedSequence: 1, expectedPreviousHash: null, fence },
  );
  assert.equal(commands.length, 2);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    const items = command.input.TransactItems;
    assert.equal(items.length, index === 0 ? 3 : 4);
    assert.deepEqual(
      items.slice(0, 2).map((item) => item.ConditionCheck.ExpressionAttributeValues[':token']),
      [4, 9],
    );
    for (const item of items.slice(0, 2))
      assert.match(
        item.ConditionCheck.ConditionExpression,
        /#token = :token AND #holderId = :holderId AND #expiresAt > :now/,
      );
  }
});

test('AWS writes a run of records in one fenced transaction with one head update', async () => {
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
      },
    },
    kms: {},
    s3: {},
  });
  const fence = ['deployment', 'signer'].map((kind, index) => ({
    scope: { ...scope, kind, address: deployerA.address },
    token: index + 4,
    holderId: 'runner',
    principal: 'test-runner',
  }));
  const hashOf = (sequence) => `0x${sequence.toString(16).padStart(64, '0')}`;
  const run = (first, count) =>
    Array.from({ length: count }, (_, index) => ({
      sequence: first + index,
      previousHash: first + index === 1 ? null : hashOf(first + index - 1),
      recordHash: hashOf(first + index),
      phase: 'intent',
      at: new Date().toISOString(),
    }));
  const from = (records) => ({
    expectedSequence: records[0].sequence,
    expectedPreviousHash: records[0].previousHash,
    fence,
  });

  const three = run(8, 3);
  assert.equal(await backend.journalStore.appendBatch(scope, three, from(three)), 3);
  const items = commands[0].input.TransactItems;
  assert.deepEqual(
    items.map((item) => Object.keys(item)[0]),
    ['ConditionCheck', 'ConditionCheck', 'Update', 'Put', 'Put', 'Put'],
  );
  const head = items[2].Update.ExpressionAttributeValues;
  assert.deepEqual(
    [head[':previous'], head[':previousHash'], head[':sequence'], head[':recordHash']],
    [7, hashOf(7), 10, hashOf(10)],
  );
  assert.deepEqual(
    items.slice(3).map((item) => item.Put.Item.SK),
    ['J#000000000008', 'J#000000000009', 'J#000000000010'],
  );

  // A transaction takes 100 actions, so a long run is stored in part, and the caller sends the rest.
  const long = run(1, 120);
  assert.equal(await backend.journalStore.appendBatch(scope, long, from(long)), 97);
  assert.equal(commands[1].input.TransactItems.length, 100);

  const broken = run(1, 3);
  broken[2].previousHash = hashOf(9);
  await assert.rejects(backend.journalStore.appendBatch(scope, broken, from(broken)), /contiguous/);
  const signed = run(1, 2);
  signed[1].phase = 'signed';
  await assert.rejects(backend.journalStore.appendBatch(scope, signed, from(signed)), /signed/);
  assert.equal(commands.length, 2, 'a rejected run sends no write');
});

test('AWS saves the signer index in the same fenced transaction as a signature', async () => {
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
        return { Items: [] };
      },
    },
    kms: {},
    s3: {},
  });
  const fence = [
    { scope: { ...scope, kind: 'deployment' }, token: 4, holderId: 'runner' },
    {
      scope: { ...scope, kind: 'signer', address: deployerA.address },
      token: 9,
      holderId: 'runner',
    },
  ];
  const transactionHash = `0x${'34'.repeat(32)}`;
  await backend.journalStore.append(
    scope,
    {
      phase: 'signed',
      sequence: 1,
      previousHash: null,
      recordHash: planHash,
      at: new Date().toISOString(),
      planHash,
      actionId: 'contract:alpha',
      signer: deployerA.address,
      nonce: '0',
      transactionHash,
    },
    { expectedSequence: 1, expectedPreviousHash: null, fence },
  );
  const items = commands[0].input.TransactItems;
  assert.equal(items.length, 5);
  assert.equal(items[4].Put.Item.SK, `TX#${transactionHash}`);
  assert.equal(items[4].Put.Item.signed.label, scope.label);
  for await (const _ of backend.journalStore.signedForSigner(scope, deployerA.address)) {
  }
  assert.equal(commands[1].input.ConsistentRead, true);
  assert.equal(commands[1].input.ExpressionAttributeValues[':pk'], items[4].Put.Item.PK);
});

test('AWS planning reads verified creation evidence without decrypting journal signatures', async () => {
  const { hashJson } = await import('../src/identity.ts');
  const hash = (digit) => `0x${digit.repeat(64)}`;
  const proof = {
    kind: 'create2',
    chain: chainIdentity,
    transactionHash: hash('1'),
    creator: deployerA.address,
    blockNumber: '7',
    blockHash: hash('2'),
    address: deployerA.address,
    initcodeHash: hash('3'),
    codeHash: hash('4'),
    factory: { address: deployerB.address, codeHash: hash('5') },
    salt: hash('6'),
  };
  const fields = {
    formatVersion: 2,
    sequence: 1,
    previousHash: null,
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    phase: 'verified',
    address: proof.address,
    codeHash: proof.codeHash,
    proofHash: hash('7'),
    verification: { status: 'verified' },
    creationProof: proof,
    outcome: 'applied',
    transactionHash: proof.transactionHash,
    principal: 'planner-test',
    at: new Date().toISOString(),
  };
  const record = { ...fields, recordHash: hashJson(fields) };
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
        if (command.constructor.name === 'QueryCommand')
          return { Items: [{ SK: 'J#HEAD' }, { SK: 'J#000000000001', record }] };
        if (command.constructor.name === 'GetCommand')
          return { Item: { sequence: 1, recordHash: record.recordHash } };
        throw new Error('Unexpected DynamoDB command.');
      },
    },
    kms: {
      async send() {
        throw new Error('Planning must not decrypt journal bytes.');
      },
    },
    s3: {},
  });
  assert.deepEqual(await readStoredJournal(backend.journalStore, scope), [record]);
  assert.deepEqual(
    commands.map((command) => command.constructor.name),
    ['QueryCommand', 'GetCommand'],
  );
  assert.ok(commands.every((command) => command.input.ConsistentRead === true));
});

test('AWS envelope encryption binds every signed transaction identity field', async () => {
  const key = randomBytes(32);
  const kms = {
    async send(command) {
      if (command.constructor.name === 'GenerateDataKeyCommand')
        return { Plaintext: Buffer.from(key), CiphertextBlob: Buffer.from('wrapped-key') };
      if (command.constructor.name === 'DecryptCommand') {
        if (
          JSON.stringify(command.input.EncryptionContext) !==
          JSON.stringify(
            Object.fromEntries(
              Object.entries(context).map(([name, value]) => [name, String(value)]),
            ),
          )
        )
          throw new Error('KMS encryption context mismatch.');
        return { Plaintext: Buffer.from(key) };
      }
      throw new Error('Unexpected KMS command.');
    },
  };
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {},
    kms,
    s3: {},
  });
  const context = encryptionContext({
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    signer: deployerA.address,
    nonce: '7',
  });
  const raw = Buffer.from('signed transaction bytes');
  const encrypted = await backend.journalCipher.encrypt(raw, context);
  assert.deepEqual(await backend.journalCipher.decrypt(encrypted, context), raw);
  assert.ok(!JSON.stringify(encrypted).includes(raw.toString()));
  for (const field of Object.keys(context)) {
    await assert.rejects(
      backend.journalCipher.decrypt(encrypted, {
        ...context,
        [field]: `${context[field]}-changed`,
      }),
      /KMS encryption context mismatch/,
    );
  }
  const changed = { ...encrypted, ciphertext: Buffer.from('changed').toString('base64') };
  await assert.rejects(backend.journalCipher.decrypt(changed, context));
});

test('signed envelopes reject changed chain, sender, nonce, payload, gas, and fees', async () => {
  const envelope = {
    chainId: 31337,
    nonce: 0,
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 1n,
  };
  const changes = [
    ['chainId', 1],
    ['nonce', 1],
    ['to', '0x0000000000000000000000000000000000000002'],
    ['data', '0x01'],
    ['value', 1n],
    ['gas', 21_001n],
    ['maxFeePerGas', 101n],
    ['maxPriorityFeePerGas', 2n],
  ];
  for (const [field, value] of changes) {
    await assert.rejects(
      signEnvelope(
        {
          address: deployerA.address,
          signTransaction: (request) => deployerA.signTransaction({ ...request, [field]: value }),
        },
        envelope,
      ),
      /Signed transaction differs/,
      field,
    );
  }
  await assert.rejects(
    signEnvelope(
      {
        address: deployerA.address,
        signTransaction: (request) => deployerB.signTransaction(request),
      },
      envelope,
    ),
    /sender/,
    'sender',
  );
});

let chain;
before(async () => {
  chain = await startAnvil();
});
after(async () => chain?.stop());

test('a new runner recovers encrypted signed bytes without a file or a second signature', async () => {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.slice(0, 1);
  input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
  const plan = await createPlan({
    ...input,
    client: chain.client,
    signers: { deployers: [deployerA.address] },
    maxSpendWei: '100000000000000000000',
  });
  const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
  const deployment = deploymentScope(
    { project: 'test', environment: 'dev', label: 'recover' },
    { id: 31337, genesisHash },
  );
  const backend = memoryBackend();
  let signatures = 0;
  const signerProvider = {
    async address() {
      return deployerA.address;
    },
    async signTransaction(_role, transaction) {
      signatures++;
      return deployerA.signTransaction(transaction);
    },
  };
  const options = {
    plan,
    ...input,
    client: chain.client,
    ...backend,
    scope: deployment,
    signerProvider,
    confirmations: 1,
    pollIntervalMs: 10,
  };
  let stopped = false;
  await assert.rejects(
    applyPlan({
      ...options,
      hooks: {
        afterRecord(record) {
          if (!stopped && record.phase === 'signed') {
            stopped = true;
            throw new Error('simulate runner loss');
          }
        },
      },
    }),
    /simulate runner loss/,
  );
  assert.equal(signatures, 1);
  const saved = backend.recordsFor(deployment).find((record) => record.phase === 'signed');
  assert.ok(saved.encryptedRawTransaction);
  assert.equal(Object.hasOwn(saved, 'rawTransaction'), false);
  assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);

  const events = [];
  const result = await applyPlan({ ...options, reporter: (event) => events.push(event) });
  assert.equal(result.status, 'applied');
  assert.equal(signatures, 1);
  assert.equal(result.rebroadcasts.length, 1);
  assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 1);
  assert.equal(
    backend.recordsFor(deployment).filter((record) => record.phase === 'signed').length,
    1,
  );
  assert.ok(
    backend
      .recordsFor(deployment)
      .every((record) => record.principal && Number.isFinite(Date.parse(record.at))),
  );
  assert.ok((await backend.stateStore.read(deployment)).value.resources['contract:alpha']);
  assert.ok(events.some((event) => event.type === 'recovery'));
  assert.ok(events.some((event) => event.type === 'verification' || event.type === 'verified'));
  assert.ok(events.every((event) => !JSON.stringify(event).includes('rawTransaction')));
});

test('a new runner finds the unfinished saved plan from the journal alone and resumes it', async () => {
  const localChain = await startAnvil();
  try {
    const input = fixture({ withCall: false });
    input.spec.contracts = input.spec.contracts.slice(0, 1);
    input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
    const plan = await createPlan({
      ...input,
      client: localChain.client,
      signers: { deployers: [deployerA.address] },
      maxSpendWei: '100000000000000000000',
    });
    const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
    const deployment = deploymentScope(
      { project: 'test', environment: 'dev', label: 'unfinished' },
      { id: 31337, genesisHash },
    );
    const backend = memoryBackend();
    const plans = new Map([[plan.planHash, plan]]);
    const reads = [];
    const planStore = {
      async put() {
        throw new Error('The lookup must not save a plan.');
      },
      async read(_scope, hash) {
        reads.push(hash);
        const saved = plans.get(hash);
        if (!saved) throw new Error(`No saved plan ${hash}.`);
        return structuredClone(saved);
      },
    };
    // No journal cipher: the lookup cannot decrypt signed bytes.
    const lookup = { scope: deployment, journalStore: backend.journalStore, planStore };
    assert.equal(await readUnfinishedPlan(lookup), null);

    const options = {
      plan,
      ...input,
      client: localChain.client,
      ...backend,
      scope: deployment,
      signerProvider: {
        async address() {
          return deployerA.address;
        },
        async signTransaction(_role, transaction) {
          return deployerA.signTransaction(transaction);
        },
      },
      confirmations: 1,
      pollIntervalMs: 10,
    };
    // An apply that stops before its first signature leaves nothing to resume.
    await assert.rejects(
      applyPlan({
        ...options,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'intent') throw new Error('stop before the signature');
          },
        },
      }),
      /stop before the signature/,
    );
    assert.equal(await readUnfinishedPlan(lookup), null);

    let stopped = false;
    await assert.rejects(
      applyPlan({
        ...options,
        hooks: {
          afterRecord(record) {
            if (!stopped && record.phase === 'signed') {
              stopped = true;
              throw new Error('simulate runner loss');
            }
          },
        },
      }),
      /simulate runner loss/,
    );
    const signed = backend.recordsFor(deployment).find((record) => record.phase === 'signed');
    const found = await readUnfinishedPlan(lookup);
    assert.equal(found.planHash, plan.planHash);
    assert.deepEqual(found.plan, plan);
    assert.deepEqual(found.transactions, [
      {
        actionId: 'contract:alpha',
        phase: 'signed',
        transactionHash: signed.transactionHash,
        signer: signed.signer,
        nonce: signed.nonce,
      },
    ]);
    assert.deepEqual(reads, [plan.planHash]);

    // A second plan with an unfinished transaction has no safe order to resume in.
    const other = `0x${'cc'.repeat(32)}`;
    const records = backend.recordsFor(deployment);
    const foreign = [
      ...records,
      ...records
        .filter((record) => record.sequence >= signed.sequence - 1)
        .map((record) => ({ ...record, planHash: other })),
    ];
    await assert.rejects(
      readUnfinishedPlan({
        ...lookup,
        journalStore: {
          async *read() {
            let previousHash = null;
            for (const [index, record] of foreign.entries()) {
              const { recordHash: _, ...fields } = { ...record, sequence: index + 1, previousHash };
              const { hashJson } = await import('../src/identity.ts');
              previousHash = hashJson(fields);
              yield { ...fields, recordHash: previousHash };
            }
          },
        },
      }),
      /each have an unfinished transaction/,
    );

    const result = await applyPlan({ ...options, plan: found.plan });
    assert.equal(result.status, 'applied');
    assert.equal(await readUnfinishedPlan(lookup), null);
  } finally {
    await localChain.stop();
  }
});

test('another label cannot spend a signer nonce while its saved signature is unresolved', async () => {
  const localChain = await startAnvil();
  try {
    const backend = memoryBackend();
    const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
    const makeInput = async (name, label) => {
      const input = fixture({ withCall: false });
      input.spec.contracts = input.spec.contracts.filter((contract) => contract.id === name);
      input.artifacts = new Map([[name, input.artifacts.get(name)]]);
      const plan = await createPlan({
        ...input,
        client: localChain.client,
        signers: { deployers: [deployerA.address] },
        maxSpendWei: '100000000000000000000',
      });
      return {
        ...input,
        plan,
        client: localChain.client,
        ...backend,
        scope: deploymentScope({ project: 'test', environment: 'dev', label }, plan.chain),
        signers: { deployer: [deployerA] },
        confirmations: 1,
        pollIntervalMs: 10,
      };
    };
    const first = await makeInput('alpha', 'alpha');
    const second = await makeInput('beta', 'beta');
    await assert.rejects(
      applyPlan({
        ...first,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed') throw new Error('runner stopped after signature');
          },
        },
      }),
      /runner stopped after signature/,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
    await assert.rejects(applyPlan(second), (error) => error.code === 'foreign-outstanding');
    assert.equal(
      backend.recordsFor(second.scope).filter((record) => record.phase === 'signed').length,
      0,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
    await applyPlan(first);
    await applyPlan(second);
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 2);
  } finally {
    await localChain.stop();
  }
});

test('an external signer cannot change the destination before journal persistence', async () => {
  const localChain = await startAnvil();
  try {
    const input = fixture({ withCall: false });
    input.spec.contracts = input.spec.contracts.slice(0, 1);
    input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
    const plan = await createPlan({
      ...input,
      client: localChain.client,
      signers: { deployers: [deployerA.address] },
      maxSpendWei: '100000000000000000000',
    });
    const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
    const deployment = deploymentScope(
      { project: 'test', environment: 'dev', label: 'bad-signer' },
      { id: 31337, genesisHash },
    );
    const backend = memoryBackend();
    const signerProvider = {
      async address() {
        return deployerA.address;
      },
      async signTransaction(_role, request) {
        return deployerA.signTransaction({
          ...request,
          to: '0x0000000000000000000000000000000000000001',
        });
      },
    };
    await assert.rejects(
      applyPlan({
        plan,
        ...input,
        client: localChain.client,
        ...backend,
        scope: deployment,
        signerProvider,
        confirmations: 1,
      }),
      (error) => error.code === 'signer',
    );
    assert.equal(
      backend.recordsFor(deployment).filter((record) => record.phase === 'signed').length,
      0,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
  } finally {
    await localChain.stop();
  }
});

async function pipelineRun(localChain, label, count = 3) {
  const input = fixtureMany(count);
  const plan = await createPlan({
    ...input,
    client: localChain.client,
    pipeline: { deployers: [deployerA.address], parallel: false },
    maxSpendWei: '100000000000000000000',
  });
  const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
  const deployment = deploymentScope(
    { project: 'test', environment: 'dev', label },
    { id: 31337, genesisHash },
  );
  const backend = memoryBackend();
  const signer = { signatures: 0 };
  const signerProvider = {
    async address() {
      return deployerA.address;
    },
    async signTransaction(_role, transaction) {
      signer.signatures++;
      return deployerA.signTransaction(transaction);
    },
  };
  const options = {
    plan,
    ...input,
    client: localChain.client,
    ...backend,
    scope: deployment,
    signerProvider,
    pipeline: true,
    confirmations: 1,
    pollIntervalMs: 10,
  };
  return { plan, backend, signer, options };
}

test('a new runner resumes an encrypted pipeline reservation without a second signature', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, signer, options } = await pipelineRun(localChain, 'pipeline-recover');
    const lastId = plan.resources.at(-1).id;
    await assert.rejects(
      applyPlan({
        ...options,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed' && record.actionId === lastId)
              throw new Error('simulate runner loss');
          },
        },
      }),
      /simulate runner loss/,
    );
    const saved = backend.recordsFor(options.scope).filter((record) => record.phase === 'signed');
    assert.equal(signer.signatures, 3);
    assert.equal(new Set(saved.map((record) => record.reservationId)).size, 1);
    assert.ok(
      saved.every(
        (record) => record.encryptedRawTransaction && !Object.hasOwn(record, 'rawTransaction'),
      ),
    );
    assert.equal(
      await localChain.client.getTransactionCount({
        address: deployerA.address,
        blockTag: 'pending',
      }),
      0,
    );

    const events = [];
    const result = await applyPlan({ ...options, reporter: (event) => events.push(event) });
    assert.equal(result.status, 'applied');
    assert.equal(signer.signatures, 3);
    assert.deepEqual(
      result.rebroadcasts.map((entry) => entry.transactionHash).sort(),
      saved.map((record) => record.transactionHash).sort(),
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 3);
    assert.equal(
      Object.keys((await backend.stateStore.read(options.scope)).value.resources).length,
      3,
    );
    for (const type of ['recovery', 'broadcast-result', 'receipt-observed'])
      assert.equal(events.filter((event) => event.type === type).length, 3, type);
    assert.ok(events.every((event) => !JSON.stringify(event).includes('rawTransaction')));
  } finally {
    await localChain.stop();
  }
});

test('a pipelined group signs only after its complete intent set is stored in batches', async () => {
  const localChain = await startAnvil();
  try {
    const { backend, signer, options } = await pipelineRun(localChain, 'pipeline-batch');
    const store = batchingStore(backend, 2);
    const intentsAtFirstSignature = [];
    const signerProvider = {
      address: options.signerProvider.address,
      async signTransaction(...args) {
        intentsAtFirstSignature.push(
          backend.recordsFor(options.scope).filter((record) => record.phase === 'intent').length,
        );
        return options.signerProvider.signTransaction(...args);
      },
    };
    const batched = { ...options, journalStore: store.journalStore, signerProvider };

    // The second chunk of the three intents fails: a partial intent group, and no signature.
    store.failOn(2);
    await assert.rejects(applyPlan(batched), /store unavailable/);
    assert.equal(signer.signatures, 0);
    assert.equal(backend.recordsFor(options.scope).length, 2);

    const result = await applyPlan(batched);
    assert.equal(result.status, 'applied');
    assert.equal(store.batches.filter((batch) => batch.length === 2).length, 2);
    assert.equal(intentsAtFirstSignature[0], 5, 'the abandoned intents and the complete new group');
    assert.equal(signer.signatures, 3);
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 3);
  } finally {
    await localChain.stop();
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('signatures and encryptions that finish out of order keep their nonces and journal order', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, options } = await pipelineRun(localChain, 'pipeline-overlap', 4);
    let encryptions = 0;
    const result = await applyPlan({
      ...options,
      // A later transaction is signed and encrypted sooner.
      signerProvider: {
        address: options.signerProvider.address,
        async signTransaction(role, transaction) {
          await sleep(20 * (4 - transaction.nonce));
          return options.signerProvider.signTransaction(role, transaction);
        },
      },
      journalCipher: {
        ...backend.journalCipher,
        async encrypt(bytes, context) {
          encryptions++;
          await sleep(15 * (4 - Number(context.nonce)));
          return backend.journalCipher.encrypt(bytes, context);
        },
      },
    });
    assert.equal(result.status, 'applied');
    const records = backend.recordsFor(options.scope);
    const signed = records.filter((record) => record.phase === 'signed');
    assert.deepEqual(
      signed.map((record) => [record.actionId, record.nonce]),
      plan.resources.map((resource, index) => [resource.id, String(index)]),
    );
    assert.ok(
      signed.at(-1).sequence <
        records.find((record) => record.phase === 'broadcast-attempt').sequence,
      'every signed record is stored before the first broadcast',
    );
    assert.equal(encryptions, 4, 'each signed record is encrypted one time');
    // A new runner decrypts each record with the context of its own transaction.
    const reopened = await openStoredJournal({
      ...backend,
      scope: options.scope,
      fence: [],
      assertHeld: async () => {},
    });
    assert.equal(reopened.records.filter((record) => record.rawTransaction).length, 4);
  } finally {
    await localChain.stop();
  }
});

test('a failed signature keeps the earlier signed records, and a rerun signs only the others', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, options } = await pipelineRun(localChain, 'pipeline-sign-failure');
    const requests = [];
    let healthy = false;
    const flaky = {
      ...options,
      signerProvider: {
        address: options.signerProvider.address,
        async signTransaction(role, transaction) {
          requests.push(transaction.nonce);
          // The second signature fails after the third one is made.
          if (transaction.nonce === 1 && !healthy) {
            await sleep(40);
            throw new Error('signer unavailable');
          }
          return options.signerProvider.signTransaction(role, transaction);
        },
      },
    };
    let failure;
    await applyPlan(flaky).catch((error) => (failure = error));
    assert.equal(failure?.code, 'signer', failure?.message);
    assert.equal(failure.actionId, plan.resources[1].id);
    const phases = () =>
      backend
        .recordsFor(options.scope)
        .filter((record) => record.phase !== 'intent')
        .map((record) => [record.phase, record.actionId]);
    assert.deepEqual(phases(), [['signed', plan.resources[0].id]]);

    healthy = true;
    const result = await applyPlan(flaky);
    assert.equal(result.status, 'applied');
    assert.equal(requests.filter((nonce) => nonce === 0).length, 1, 'no second signature');
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 3);
  } finally {
    await localChain.stop();
  }
});

test('a lease lost during signing stores no signed record and starts no other signature', async () => {
  const localChain = await startAnvil();
  try {
    const { backend, signer, options } = await pipelineRun(localChain, 'pipeline-sign-lease', 10);
    let lost = false;
    await assert.rejects(
      applyPlan({
        ...options,
        lockProvider: {
          async acquire(...args) {
            const lease = await backend.lockProvider.acquire(...args);
            return {
              ...lease,
              async assertHeld() {
                if (lost) throw new Error('Writer lease is lost.');
                return lease.assertHeld();
              },
            };
          },
        },
        signerProvider: {
          address: options.signerProvider.address,
          async signTransaction(...args) {
            lost = true;
            return options.signerProvider.signTransaction(...args);
          },
        },
      }),
      /Writer lease is lost/,
    );
    assert.ok(signer.signatures < 10, `${signer.signatures} signatures`);
    assert.deepEqual(
      [...new Set(backend.recordsFor(options.scope).map((record) => record.phase))],
      ['intent'],
    );
  } finally {
    await localChain.stop();
  }
});

test('a lost lease stops a pipelined group before its first broadcast', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, signer, options } = await pipelineRun(localChain, 'pipeline-lease');
    let lost = false;
    const lockProvider = {
      async acquire(...args) {
        const lease = await backend.lockProvider.acquire(...args);
        return {
          ...lease,
          async assertHeld() {
            if (lost) throw new Error('Writer lease is lost.');
            return lease.assertHeld();
          },
        };
      },
    };
    const lastId = plan.resources.at(-1).id;
    await assert.rejects(
      applyPlan({
        ...options,
        lockProvider,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed' && record.actionId === lastId) lost = true;
          },
        },
      }),
      /Writer lease is lost/,
    );
    assert.equal(signer.signatures, 3);
    assert.equal(
      backend.recordsFor(options.scope).filter((record) => record.phase === 'broadcast-attempt')
        .length,
      0,
    );
    assert.equal(
      await localChain.client.getTransactionCount({
        address: deployerA.address,
        blockTag: 'pending',
      }),
      0,
    );
  } finally {
    await localChain.stop();
  }
});
