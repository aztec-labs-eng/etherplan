import assert from 'node:assert/strict';
import test from 'node:test';
import { getContractAddress, keccak256 } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { acquireLeases, readStoredJournal, scopeKey } from '../src/execution/backends.ts';
import { pullDeploymentScope, pushDeploymentScope } from '../src/execution/scope-transfer.ts';
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

// The pulled scope goes through a file between state pull and state push.
const throughFile = (value) => JSON.parse(JSON.stringify(value));

// Pulls a scope from one backend and pushes it into another with its own key.
async function copyScope(source, target, scope) {
  const pulled = throughFile(await pullDeploymentScope({ backend: source, scope }));
  await pushDeploymentScope({ backend: target, pulled });
  return pulled.journal;
}

function planStore() {
  const plans = new Map();
  return {
    async put(scope, plan) {
      plans.set(`${scopeKey(scope)}/${plan.planHash}`, structuredClone(plan));
      return { bucket: 'memory', key: plan.planHash, planHash: plan.planHash };
    },
    async read(scope, planHash) {
      const plan = plans.get(`${scopeKey(scope)}/${planHash}`);
      if (!plan)
        throw Object.assign(new Error(`No saved plan ${planHash}.`), { name: 'NoSuchKey' });
      return structuredClone(plan);
    },
  };
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
      principal: 'state-push',
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

test('state pull and push move a settled scope, a resource subset under a new scope, and refuse unsafe pushes', async () => {
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
    const pulled = throughFile(await pullDeploymentScope({ backend: source, scope: ws.scope }));
    const target = memoryBackend(ws.scope);
    const report = await pushDeploymentScope({ backend: target, pulled });
    assert.equal(report.records, (await readStoredJournal(source.journalStore, ws.scope)).length);
    assert.deepEqual(report.resources.sort(), ['contract:gadget', 'contract:parent']);
    assert.equal(report.resumedAt, 0);
    await assert.rejects(pushDeploymentScope({ backend: target, pulled }), /already has state/);
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
    const subset = await pushDeploymentScope({
      backend: gadgets,
      pulled,
      scope: gadgetsScope,
      resources: ['contract:gadget'],
    });
    assert.deepEqual(subset.resources, ['contract:gadget']);
    assert.equal(subset.pulledScope, report.scope);
    await assert.rejects(
      pushDeploymentScope({
        backend: memoryBackend(ws.scope),
        pulled,
        resources: ['contract:nope'],
      }),
      /has no contract:nope/,
    );
    await assert.rejects(
      pushDeploymentScope({
        backend: memoryBackend(ws.scope),
        pulled,
        scope: { ...ws.scope, chainId: 1 },
      }),
      /keeps the chain/,
    );
    await assert.rejects(
      pushDeploymentScope({
        backend: memoryBackend(ws.scope),
        pulled: { ...pulled, formatVersion: 2 },
      }),
      /not a scope from etherplan state pull/,
    );
    const tampered = throughFile(pulled);
    tampered.journal[0].actionId = 'contract:other';
    await assert.rejects(
      pushDeploymentScope({ backend: memoryBackend(ws.scope), pulled: tampered }),
      /integrity failure/,
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

test('state pull and push refuse a scope with an unresolved transaction', async () => {
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
    await assert.rejects(
      pullDeploymentScope({ backend: source, scope: ws.scope }),
      /unresolved transactions/,
    );
    const target = memoryBackend(ws.scope);
    const pulled = {
      format: 'etherplan-scope',
      formatVersion: 1,
      scope: ws.scope,
      state: null,
      journal: await readStoredJournal(source.journalStore, ws.scope),
      plans: [],
      plansMissing: [],
    };
    await assert.rejects(
      pushDeploymentScope({ backend: target, pulled }),
      /unresolved transactions/,
    );
    assert.equal(target.recordsFor(ws.scope).length, 0);
  } finally {
    await ws.chain.stop();
  }
});

test('state push resumes an interrupted push from the prefix it wrote', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    await ws.apply(source, await createPlan(ws.input));
    const pulled = throughFile(await pullDeploymentScope({ backend: source, scope: ws.scope }));
    const target = memoryBackend(ws.scope);
    target.recordsFor(ws.scope).push(...structuredClone(pulled.journal.slice(0, 2)));
    const report = await pushDeploymentScope({ backend: target, pulled });
    assert.equal(report.resumedAt, 2);
    assert.equal(report.records, pulled.journal.length);
    const forged = memoryBackend(ws.scope);
    forged
      .recordsFor(ws.scope)
      .push({ ...structuredClone(pulled.journal[0]), recordHash: `0x${'ee'.repeat(32)}` });
    await assert.rejects(pushDeploymentScope({ backend: forged, pulled }));
  } finally {
    await ws.chain.stop();
  }
});

test('state pull carries the saved plans, and state push needs a plan bucket for them', async () => {
  const ws = await setup();
  try {
    const source = memoryBackend(ws.scope);
    const plan = await createPlan(ws.input);
    await ws.apply(source, plan);
    source.planStore = planStore();
    const without = await pullDeploymentScope({ backend: source, scope: ws.scope });
    assert.deepEqual(without.plansMissing, [plan.planHash]);
    await source.planStore.put(ws.scope, plan);
    const pulled = throughFile(await pullDeploymentScope({ backend: source, scope: ws.scope }));
    assert.deepEqual(pulled.plans, throughFile([plan]));
    assert.deepEqual(pulled.plansMissing, []);
    const bare = memoryBackend(ws.scope);
    await assert.rejects(pushDeploymentScope({ backend: bare, pulled }), /no plan bucket/);
    assert.equal(bare.recordsFor(ws.scope).length, 0);
    const target = memoryBackend(ws.scope);
    target.planStore = planStore();
    assert.equal((await pushDeploymentScope({ backend: target, pulled })).plans, 1);
    assert.deepEqual(await target.planStore.read(ws.scope, plan.planHash), pulled.plans[0]);
    const read = source.planStore.read;
    source.planStore.read = async (scope, planHash) => {
      const journal = source.recordsFor(scope);
      journal.push({ ...structuredClone(journal.at(-1)), recordHash: `0x${'ab'.repeat(32)}` });
      return read(scope, planHash);
    };
    await assert.rejects(
      pullDeploymentScope({ backend: source, scope: ws.scope }),
      /changed during the pull/,
    );
  } finally {
    await ws.chain.stop();
  }
});

test('state push of a hand-repaired journal that signs one transaction under two actions indexes it once', async () => {
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
    const pulled = throughFile(await pullDeploymentScope({ backend: source, scope: ws.scope }));
    const report = await pushDeploymentScope({ backend: target, pulled });
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
