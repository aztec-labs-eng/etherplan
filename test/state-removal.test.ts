import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPlan } from '../src/execution/index.ts';
import { deploymentScope, readStoredJournal } from '../src/execution/backends.ts';
import { removeFromStoredState } from '../src/execution/state-removal.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixture, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

const maxSpendWei = '100000000000000000000';

// The ids state rm takes as declared: every resource of the spec.
const declaredBy = (spec) =>
  new Set([
    ...spec.contracts.map((item) => `contract:${item.id}`),
    ...spec.calls.map((item) => `call:${item.id}`),
  ]);

// The fixture's independent contracts, without the owner call.
function withContracts(ids) {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.filter((contract) => ids.includes(contract.id));
  input.artifacts = new Map(ids.map((id) => [id, input.artifacts.get(id)]));
  return input;
}

async function setup() {
  const chain = await startAnvil();
  const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
  const scope = deploymentScope(
    { project: 'root', environment: 'dev', label: 'main' },
    { id: 31337, genesisHash },
  );
  const backend = memoryBackend(scope);
  const plan = (input, state = null, journalRecords = []) =>
    createPlan({
      ...input,
      client: chain.client,
      state,
      journalRecords,
      signers: { deployers: [deployerA.address] },
      maxSpendWei,
    });
  const apply = async (input, hooks) =>
    applyPlan({
      ...input,
      plan: await plan(
        input,
        (await backend.stateStore.read(scope))?.value ?? null,
        await readStoredJournal(backend.journalStore, scope),
      ),
      client: chain.client,
      signers: { deployer: [deployerA] },
      ...backend,
      scope,
      confirmations: 1,
      pollIntervalMs: 20,
      ...(hooks ? { hooks } : {}),
    });
  return { chain, scope, backend, plan, apply };
}

test('state rm removes a contract from a stored scope, and the spec without it plans reuse', async () => {
  const ws = await setup();
  try {
    assert.equal((await ws.apply(withContracts(['alpha', 'beta']))).status, 'applied');
    const journal = await readStoredJournal(ws.backend.journalStore, ws.scope);
    const before = await ws.backend.stateStore.read(ws.scope);
    assert.ok(before.value.lastPlanHash);
    const kept = withContracts(['alpha']);
    await removeFromStoredState({
      backend: ws.backend,
      scope: ws.scope,
      ids: ['contract:beta'],
      declared: declaredBy(kept.spec),
    });
    const after = await ws.backend.stateStore.read(ws.scope);
    assert.notEqual(after.version, before.version);
    assert.deepEqual(Object.keys(after.value.resources), ['contract:alpha']);
    assert.deepEqual(
      after.value.resources['contract:alpha'],
      before.value.resources['contract:alpha'],
    );
    assert.equal(after.value.lastPlanHash, undefined);
    assert.deepEqual(await readStoredJournal(ws.backend.journalStore, ws.scope), journal);
    const plan = await ws.plan(kept, after.value, journal);
    assert.deepEqual(
      plan.resources.map((resource) => [resource.id, resource.action]),
      [['contract:alpha', 'reuse']],
    );
    await assert.rejects(
      removeFromStoredState({
        backend: ws.backend,
        scope: ws.scope,
        ids: ['contract:beta'],
        declared: declaredBy(kept.spec),
      }),
      /State has no contract:beta\./,
    );
  } finally {
    await ws.chain.stop();
  }
});

test('state rm refuses a declared resource, a missing state and an unresolved transaction, and leaves state alone', async () => {
  const ws = await setup();
  try {
    const remove = (ids, declared = new Set()) =>
      removeFromStoredState({ backend: ws.backend, scope: ws.scope, ids, declared });
    await assert.rejects(remove(['contract:alpha']), /The backend scope has no state\./);
    assert.equal((await ws.apply(withContracts(['alpha']))).status, 'applied');
    await assert.rejects(
      remove(['contract:alpha'], new Set(['contract:alpha'])),
      /The project still declares contract:alpha\. Remove them from the project first/,
    );
    let stopped = false;
    await assert.rejects(
      ws.apply(withContracts(['alpha', 'beta']), {
        afterRecord(record) {
          if (!stopped && record.phase === 'signed') {
            stopped = true;
            throw new Error('simulate runner loss');
          }
        },
      }),
      /simulate runner loss/,
    );
    const before = await ws.backend.stateStore.read(ws.scope);
    await assert.rejects(
      remove(['contract:alpha']),
      /has an unresolved transaction for contract:beta\. Resume it with apply/,
    );
    assert.deepEqual(await ws.backend.stateStore.read(ws.scope), before);
  } finally {
    await ws.chain.stop();
  }
});
