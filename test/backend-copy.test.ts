import assert from 'node:assert/strict';
import test from 'node:test';
import { getContractAddress, keccak256 } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { copyDeploymentScope } from '../src/execution/backend-copy.ts';
import { acquireLeases, readStoredJournal } from '../src/execution/backends.ts';
import { hashJson } from '../src/identity.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { graph, parseSpec } from '../src/spec/index.ts';
import { deployerA, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

// Same constructor-creates-a-child artifact as pinned-runtime.test.ts.
const RUNTIME = `0x7f${'00'.repeat(32)}60005260206000f3`;
const CHILD_INITCODE = '6002600c60003960026000f36000';
const INITCODE = `0x6029601d600039600e6046604039600e60406000f060015260296000f3${RUNTIME.slice(2)}${CHILD_INITCODE}`;
const fields = {
  abi: [
    { type: 'constructor', stateMutability: 'nonpayable', inputs: [] },
    {
      type: 'function',
      name: 'implementation',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
  ],
  bytecode: { object: INITCODE, linkReferences: {} },
  deployedBytecode: {
    object: RUNTIME,
    linkReferences: {},
    immutableReferences: { '1': [{ start: 1, length: 32 }] },
  },
  buildIdentity: {},
};
const artifact = { ...fields, artifactHash: hashJson(fields) };

function pinned(spec, artifacts, id) {
  const resource = prepareResources(spec, graph(parseSpec(spec)), artifacts).resources.find(
    (r) => r.id === `contract:${id}`,
  );
  const child = getContractAddress({ from: resource.address, nonce: 1n }).toLowerCase();
  const contract = spec.contracts.find((c) => c.id === id);
  contract.creationProofMode = 'pinned-runtime';
  contract.codeHash = keccak256(`0x7f${child.slice(2).padStart(64, '0')}60005260206000f3`);
  contract.createdCode = [
    { getter: 'implementation', createNonce: 1, codeHash: keccak256('0x6000') },
  ];
}

async function setup() {
  const chain = await startAnvil();
  const factoryAddress = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const factoryCode = await chain.client.getCode({ address: factoryAddress });
  const spec = {
    schema: 1,
    chainId: 31337,
    values: {},
    factory: { address: factoryAddress, codeHash: keccak256(factoryCode) },
    contracts: [{ id: 'parent', artifact: 'Parent.json', salt: `0x${'37'.repeat(32)}`, args: [] }],
    calls: [],
  };
  const artifacts = new Map([['parent', artifact]]);
  pinned(spec, artifacts, 'parent');
  const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
  const scope = {
    project: 'name-core',
    environment: 'v6-staging__nc-v6',
    label: 'main',
    chainId: 31337,
    genesisHash,
  };
  const input = {
    spec,
    artifacts,
    client: chain.client,
    signers: { deployers: [deployerA.address] },
    maxSpendWei: '1000000000000000000',
  };
  const apply = (backend, plan, extra = {}) =>
    applyPlan({
      plan,
      spec,
      artifacts,
      client: chain.client,
      signers: { deployer: [deployerA] },
      ...backend,
      scope,
      confirmations: 1,
      pollIntervalMs: 20,
      ...extra,
    });
  return { chain, spec, artifacts, scope, input, apply };
}

// What a backend copy does: the state value and every journal record verbatim, in a backend with its own key.
async function copyScope(source, target, scope) {
  const state = await source.stateStore.read(scope);
  const records = await readStoredJournal(source.journalStore, scope);
  target.recordsFor(scope).push(...structuredClone(records));
  const leases = await acquireLeases({
    lockProvider: target.lockProvider,
    scope,
    addresses: [deployerA.address],
    planHash: `0x${'00'.repeat(32)}`,
    principal: 'backend-copy',
  });
  try {
    await target.stateStore.compareAndSwap(scope, null, state.value, { fence: leases.fence });
  } finally {
    await leases.release();
  }
  return records;
}

test('a copied pinned-runtime scope plans reuse in a backend with another key', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    assert.equal((await ws.apply(source, await createPlan(ws.input))).status, 'applied');
    const target = memoryBackend(ws.scope);
    await copyScope(source, target, ws.scope);
    const state = (await target.stateStore.read(ws.scope)).value;
    const records = await readStoredJournal(target.journalStore, ws.scope);
    const plan = await createPlan({ ...ws.input, state, journalRecords: records });
    assert.equal(plan.resources[0].action, 'reuse');
    assert.equal(plan.resources[0].observation.creationProof.method, 'pinned-runtime');
    const withoutJournal = await createPlan({ ...ws.input, state });
    assert.equal(withoutJournal.resources[0].action, 'unverified');
  } finally {
    await ws.chain.stop();
  }
});

test('the copied scope applies, deploys a new pinned contract, and extends the copied journal', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    await ws.apply(source, await createPlan(ws.input));
    const target = memoryBackend(ws.scope);
    const copied = await copyScope(source, target, ws.scope);
    const read = async () => ({
      state: (await target.stateStore.read(ws.scope)).value,
      journalRecords: await readStoredJournal(target.journalStore, ws.scope),
    });
    const reusePlan = await createPlan({ ...ws.input, ...(await read()) });
    const first = await ws.apply(target, reusePlan);
    assert.equal(first.status, 'applied');
    assert.equal(first.transactionsSigned, 0);
    ws.spec.contracts.push({
      id: 'parent2',
      artifact: 'Parent.json',
      salt: `0x${'38'.repeat(32)}`,
      args: [],
    });
    ws.artifacts.set('parent2', artifact);
    pinned(ws.spec, ws.artifacts, 'parent2');
    const grow = await createPlan({ ...ws.input, ...(await read()) });
    assert.deepEqual(
      grow.resources.map((r) => [r.id, r.action]),
      [
        ['contract:parent', 'reuse'],
        ['contract:parent2', 'deploy'],
      ],
    );
    const second = await ws.apply(target, grow);
    assert.equal(second.status, 'applied');
    assert.equal(second.transactionsSigned, 1);
    const after = await read();
    assert.deepEqual(after.journalRecords.slice(0, copied.length), copied);
    assert.ok(after.journalRecords.length > copied.length);
    assert.equal(after.state.resources['contract:parent2'].creationProof.method, 'pinned-runtime');
    const again = await createPlan({ ...ws.input, ...after });
    assert.deepEqual(
      again.resources.map((r) => r.action),
      ['reuse', 'reuse'],
    );
  } finally {
    await ws.chain.stop();
  }
});

test('a copy taken while a signed transaction is unresolved cannot resume in the new backend', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    let stopped = false;
    await assert.rejects(
      ws.apply(source, await createPlan(ws.input), {
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
    const target = memoryBackend(ws.scope);
    const records = await readStoredJournal(source.journalStore, ws.scope);
    target.recordsFor(ws.scope).push(...structuredClone(records));
    const plan = await createPlan({ ...ws.input, journalRecords: records });
    await assert.rejects(ws.apply(target, plan));
  } finally {
    await ws.chain.stop();
  }
});

test('a resource subset of a scope, with its whole journal, plans reuse and applies under another scope in another backend', async () => {
  const ws = await setup();
  try {
    ws.spec.contracts.push({
      id: 'gadget',
      artifact: 'Parent.json',
      salt: `0x${'39'.repeat(32)}`,
      args: [],
    });
    ws.artifacts.set('gadget', artifact);
    pinned(ws.spec, ws.artifacts, 'gadget');
    const source = memoryBackend(ws.scope);
    assert.equal((await ws.apply(source, await createPlan(ws.input))).status, 'applied');
    const scope = {
      ...ws.scope,
      project: 'bridge-gadgets',
      environment: 'v6-staging__bgd-susds-v6',
    };
    const target = memoryBackend(scope);
    const sourceState = (await source.stateStore.read(ws.scope)).value;
    const records = await readStoredJournal(source.journalStore, ws.scope);
    target.recordsFor(scope).push(...structuredClone(records));
    const subset = {
      ...sourceState,
      resources: { 'contract:gadget': sourceState.resources['contract:gadget'] },
    };
    const leases = await acquireLeases({
      lockProvider: target.lockProvider,
      scope,
      addresses: [deployerA.address],
      planHash: `0x${'00'.repeat(32)}`,
      principal: 'backend-copy',
    });
    await target.stateStore.compareAndSwap(scope, null, subset, { fence: leases.fence });
    await leases.release();
    ws.spec.contracts = ws.spec.contracts.filter((c) => c.id === 'gadget');
    ws.artifacts.delete('parent');
    const read = async () => ({
      state: (await target.stateStore.read(scope)).value,
      journalRecords: await readStoredJournal(target.journalStore, scope),
    });
    const plan = await createPlan({ ...ws.input, ...(await read()) });
    assert.deepEqual(
      plan.resources.map((r) => [r.id, r.action, r.observation.creationProof?.method]),
      [['contract:gadget', 'reuse', 'pinned-runtime']],
    );
    const result = await ws.apply(target, plan, { scope });
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, 0);
    const again = await createPlan({ ...ws.input, ...(await read()) });
    assert.equal(again.resources[0].action, 'reuse');
  } finally {
    await ws.chain.stop();
  }
});

test('copyDeploymentScope copies a settled scope, a resource subset under a new scope, and refuses unsafe copies', async () => {
  const ws = await setup();
  try {
    ws.spec.contracts.push({
      id: 'gadget',
      artifact: 'Parent.json',
      salt: `0x${'39'.repeat(32)}`,
      args: [],
    });
    ws.artifacts.set('gadget', artifact);
    pinned(ws.spec, ws.artifacts, 'gadget');
    const source = memoryBackend(ws.scope);
    await ws.apply(source, await createPlan(ws.input));
    const target = memoryBackend(ws.scope);
    const report = await copyDeploymentScope({ source, target, sourceScope: ws.scope });
    assert.equal(report.records, (await readStoredJournal(source.journalStore, ws.scope)).length);
    assert.deepEqual(report.resources.sort(), ['contract:gadget', 'contract:parent']);
    await assert.rejects(
      copyDeploymentScope({ source, target, sourceScope: ws.scope }),
      /already has state/,
    );
    const whole = await createPlan({
      ...ws.input,
      state: (await target.stateStore.read(ws.scope)).value,
      journalRecords: await readStoredJournal(target.journalStore, ws.scope),
    });
    assert.deepEqual(
      whole.resources.map((r) => r.action),
      ['reuse', 'reuse'],
    );
    assert.equal((await ws.apply(target, whole)).status, 'applied');

    const gadgetsScope = {
      ...ws.scope,
      project: 'bridge-gadgets',
      environment: 'v6-staging__bgd-susds-v6',
    };
    const gadgets = memoryBackend(gadgetsScope);
    const subset = await copyDeploymentScope({
      source,
      target: gadgets,
      sourceScope: ws.scope,
      targetScope: gadgetsScope,
      resources: ['contract:gadget'],
    });
    assert.deepEqual(subset.resources, ['contract:gadget']);
    await assert.rejects(
      copyDeploymentScope({
        source,
        target: memoryBackend(ws.scope),
        sourceScope: ws.scope,
        resources: ['contract:nope'],
      }),
      /has no contract:nope/,
    );
    await assert.rejects(
      copyDeploymentScope({
        source,
        target: memoryBackend(ws.scope),
        sourceScope: ws.scope,
        targetScope: { ...ws.scope, chainId: 1 },
      }),
      /keeps the chain/,
    );
    ws.spec.contracts = ws.spec.contracts.filter((c) => c.id === 'gadget');
    const only = await createPlan({
      ...ws.input,
      state: (await gadgets.stateStore.read(gadgetsScope)).value,
      journalRecords: await readStoredJournal(gadgets.journalStore, gadgetsScope),
    });
    assert.deepEqual(
      only.resources.map((r) => [r.id, r.action, r.observation.creationProof?.method]),
      [['contract:gadget', 'reuse', 'pinned-runtime']],
    );
    assert.equal((await ws.apply(gadgets, only, { scope: gadgetsScope })).status, 'applied');
  } finally {
    await ws.chain.stop();
  }
});

test('copyDeploymentScope refuses a scope with an unresolved transaction', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    let stopped = false;
    await assert.rejects(
      ws.apply(source, await createPlan(ws.input), {
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
    const target = memoryBackend(ws.scope);
    await assert.rejects(
      copyDeploymentScope({ source, target, sourceScope: ws.scope }),
      /unresolved transactions/,
    );
    assert.equal(target.recordsFor(ws.scope).length, 0);
  } finally {
    await ws.chain.stop();
  }
});

test('copyDeploymentScope resumes an interrupted copy from the prefix it wrote', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    await ws.apply(source, await createPlan(ws.input));
    const records = await readStoredJournal(source.journalStore, ws.scope);
    const target = memoryBackend(ws.scope);
    target.recordsFor(ws.scope).push(...structuredClone(records.slice(0, 2)));
    const report = await copyDeploymentScope({ source, target, sourceScope: ws.scope });
    assert.equal(report.resumedAt, 2);
    assert.equal(report.records, records.length);
    const forged = memoryBackend(ws.scope);
    forged
      .recordsFor(ws.scope)
      .push({ ...structuredClone(records[0]), recordHash: `0x${'ee'.repeat(32)}` });
    await assert.rejects(copyDeploymentScope({ source, target: forged, sourceScope: ws.scope }));
  } finally {
    await ws.chain.stop();
  }
});
test('copyDeploymentScope copies a hand-repaired journal that signs one transaction under two actions', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    await ws.apply(source, await createPlan(ws.input));
    const journal = source.recordsFor(ws.scope);
    for (const record of journal.filter((r) => r.actionId === 'contract:parent')) {
      const { recordHash: _hash, ...fields } = structuredClone(record);
      const relabeled = {
        ...fields,
        actionId: 'contract:renamed',
        sequence: journal.length + 1,
        previousHash: journal.at(-1).recordHash,
      };
      journal.push({ ...relabeled, recordHash: hashJson(relabeled) });
    }
    const signed = journal.filter((r) => r.phase === 'signed');
    assert.equal(signed.length, 2);
    assert.equal(signed[0].transactionHash, signed[1].transactionHash);
    const target = memoryBackend(ws.scope);
    const report = await copyDeploymentScope({ source, target, sourceScope: ws.scope });
    assert.equal(report.signedRecords, 2);
    assert.deepEqual(await readStoredJournal(target.journalStore, ws.scope), journal);
    const rows = [];
    for await (const row of target.journalStore.signedForSigner(ws.scope, signed[0].signer))
      rows.push(row);
    assert.deepEqual(
      rows.map((row) => [row.actionId, row.transactionHash]),
      [['contract:parent', signed[0].transactionHash.toLowerCase()]],
    );
  } finally {
    await ws.chain.stop();
  }
});
