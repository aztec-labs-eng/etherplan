import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InternalRpcError, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { createPlan } from '../src/planning/index.ts';
import { readState } from '../src/state/index.ts';
import { deployerA, fixture, owner, startAnvil } from './execution/chain.ts';

async function setup(chain) {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.filter((contract) =>
    ['alpha', 'gamma'].includes(contract.id),
  );
  input.artifacts = new Map(
    [...input.artifacts].filter(([name]) => ['alpha', 'gamma'].includes(name)),
  );
  const plan = await createPlan({
    ...input,
    client: chain.client,
    signers: { deployers: [deployerA.address] },
    maxSpendWei: '100000000000000000000',
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-finality-'));
  const journalFile = path.join(dir, 'journal.jsonl');
  return {
    ...input,
    plan,
    client: chain.client,
    signers: { deployer: [deployerA] },
    stateFile: path.join(dir, 'state.json'),
    journalFile,
    pollIntervalMs: 10,
    receiptTimeoutMs: 2_000,
  };
}

async function records(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('dependent waves advance on receipts while state and success require finality', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    await assert.rejects(
      applyPlan({ ...input, confirmations: 2, receiptTimeoutMs: 500 }),
      (error) => error.code === 'finality' && error.retryable === true,
    );
    const before = await records(input.journalFile);
    assert.equal(before.filter((record) => record.phase === 'verified').length, 2);
    assert.equal(
      before.filter((record) => record.phase === 'signed' && record.actionId === 'contract:gamma')
        .length,
      1,
    );
    assert.equal(await readState(input.stateFile), null);

    await chain.rpc('evm_mine');
    const result = await applyPlan({ ...input, confirmations: 2 });
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, 0);
    assert.equal(Object.keys((await readState(input.stateFile)).resources).length, 2);
  } finally {
    await chain.stop();
  }
});

for (const phase of ['receipt', 'verified']) {
  test(`an orphaned receipt at ${phase} stops before its dependent is signed`, async () => {
    const chain = await startAnvil();
    try {
      const input = await setup(chain);
      const snapshot = await chain.rpc('evm_snapshot');
      let reverted = false;
      await assert.rejects(
        applyPlan({
          ...input,
          confirmations: phase === 'receipt' ? 2 : 1,
          hooks: {
            async afterRecord(record) {
              if (!reverted && record.phase === phase && record.actionId === 'contract:alpha') {
                reverted = true;
                await chain.rpc('evm_revert', [snapshot]);
                await chain.rpc('evm_mine');
              }
            },
          },
        }),
        (error) => error.code === 'reorg',
      );
      const saved = await records(input.journalFile);
      assert.equal(
        saved.filter((record) => record.phase === 'signed' && record.actionId === 'contract:gamma')
          .length,
        0,
      );
      assert.equal(
        saved.filter(
          (record) => record.phase === 'verified' && record.actionId === 'contract:gamma',
        ).length,
        0,
      );
    } finally {
      await chain.stop();
    }
  });
}

const signedActions = async (file) =>
  (await records(file)).filter((record) => record.phase === 'signed').map((r) => r.actionId);
const unavailable = () => new InternalRpcError(new Error('unavailable'));
const faults = {
  'block reads fail': ['getBlock', unavailable],
  'the receipt is missing': [
    'getTransactionReceipt',
    (request) => new TransactionReceiptNotFoundError({ hash: request.hash }),
  ],
  'a getter read fails': ['readContract', unavailable],
  'the creation transaction is missing': [
    'getTransaction',
    (request) => new TransactionNotFoundError({ hash: request.hash }),
  ],
};
const afterAlpha = (phase) => (record) =>
  record.phase === phase && record.actionId === 'contract:alpha';

// Fails `times` calls once armed. By default it arms when alpha's receipt is recorded, so the
// fault meets alpha's anchor check and verification.
function faulty(chain, [method, error], { times = Infinity, armed = false, armOn } = {}) {
  let remaining = times;
  const client = Object.assign(Object.create(chain.client), {
    async [method](request) {
      if (armed && remaining > 0) {
        remaining--;
        throw error(request);
      }
      return chain.client[method](request);
    },
  });
  const arm = armOn ?? afterAlpha('receipt');
  const afterRecord = (record) => {
    armed ||= arm(record);
  };
  return { client, hooks: { afterRecord }, injected: () => remaining < times };
}

async function completesOnce(chain, input, fault) {
  const result = await applyPlan({ ...input, client: fault.client, hooks: fault.hooks });
  assert.equal(fault.injected(), true);
  assert.equal(result.status, 'applied');
  assert.deepEqual(await signedActions(input.journalFile), ['contract:alpha', 'contract:gamma']);
  assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 2);
}

for (const name of [
  'the receipt is missing',
  'a getter read fails',
  'the creation transaction is missing',
]) {
  test(`when ${name} once after the receipt, apply completes without another transaction`, async () => {
    const chain = await startAnvil();
    try {
      const input = await setup(chain);
      await completesOnce(chain, input, faulty(chain, faults[name], { times: 1 }));
    } finally {
      await chain.stop();
    }
  });
}

// Each boundary verifies alpha again after it was deployed; one getter read fails there.
const boundaries = {
  async dependency(chain, input) {
    return { input, armOn: afterAlpha('verified') };
  },
  async resumed(chain, input) {
    const interruption = new Error('interrupted');
    await assert.rejects(
      applyPlan({
        ...input,
        hooks: {
          afterRecord(record) {
            if (afterAlpha('verified')(record)) throw interruption;
          },
        },
      }),
      (error) => error === interruption,
    );
    return { input, armed: true };
  },
  async reused(chain, input) {
    assert.equal((await applyPlan(input)).status, 'applied');
    const plan = await createPlan({
      spec: input.spec,
      artifacts: input.artifacts,
      client: chain.client,
      state: await readState(input.stateFile),
      signers: { deployers: [deployerA.address] },
      maxSpendWei: '100000000000000000000',
    });
    return { input: { ...input, plan }, armed: true };
  },
};

for (const [boundary, prepare] of Object.entries(boundaries)) {
  test(`${boundary} verification survives a getter RPC failure without another transaction`, async () => {
    const chain = await startAnvil();
    try {
      const { input, ...arming } = await prepare(chain, await setup(chain));
      const fault = faulty(chain, faults['a getter read fails'], { times: 1, ...arming });
      await completesOnce(chain, input, fault);
    } finally {
      await chain.stop();
    }
  });
}

for (const [name, code] of [
  ['block reads fail'],
  ['the receipt is missing', 'receipt-timeout'],
  ['a getter read fails'],
]) {
  test(`when ${name} past its timeout, apply stops before the dependent and a rerun reuses the signature`, async () => {
    const chain = await startAnvil();
    try {
      const input = await setup(chain);
      const { client, hooks } = faulty(chain, faults[name]);
      await assert.rejects(
        applyPlan({ ...input, client, hooks, receiptTimeoutMs: 100, verificationTimeoutMs: 100 }),
        (error) =>
          error.retryable === true && error.code !== 'reorg' && (!code || error.code === code),
      );
      assert.deepEqual(await signedActions(input.journalFile), ['contract:alpha']);
      assert.equal((await applyPlan(input)).status, 'applied');
      assert.deepEqual(await signedActions(input.journalFile), [
        'contract:alpha',
        'contract:gamma',
      ]);
    } finally {
      await chain.stop();
    }
  });
}

test('a getter that returns a wrong value once its RPC recovers still fails the deployment', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    let armed = false;
    let failed = false;
    const client = Object.assign(Object.create(chain.client), {
      async readContract(request) {
        if (!armed) return chain.client.readContract(request);
        if (!failed) {
          failed = true;
          throw unavailable();
        }
        return '0x000000000000000000000000000000000000dEaD';
      },
    });
    const hooks = {
      afterRecord(record) {
        armed ||= afterAlpha('receipt')(record);
      },
    };
    await assert.rejects(
      applyPlan({ ...input, client, hooks }),
      (error) => error.code === 'postcondition' && error.retryable === false,
    );
    assert.equal(failed, true);
    assert.deepEqual(await signedActions(input.journalFile), ['contract:alpha']);
  } finally {
    await chain.stop();
  }
});

test('an alternate RPC at the same canonical block verifies while primary getters fail', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const { client, hooks } = faulty(chain, faults['a getter read fails']);
    const result = await applyPlan({
      ...input,
      client,
      hooks,
      verificationClient: chain.client,
      verificationTimeoutMs: 1_000,
    });
    assert.equal(result.status, 'applied');
    assert.deepEqual(await signedActions(input.journalFile), ['contract:alpha', 'contract:gamma']);
  } finally {
    await chain.stop();
  }
});

test('an alternate RPC on a different block cannot verify, and the dependent stays unsigned', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const { client, hooks } = faulty(chain, faults['a getter read fails']);
    const forked = Object.assign(Object.create(chain.client), {
      async getBlock(request) {
        const block = await chain.client.getBlock(request);
        return request?.blockNumber ? { ...block, hash: `0x${'ee'.repeat(32)}` } : block;
      },
    });
    await assert.rejects(
      applyPlan({
        ...input,
        client,
        hooks,
        verificationClient: forked,
        verificationTimeoutMs: 100,
      }),
      (error) => error.retryable === true && error.code !== 'reorg',
    );
    assert.deepEqual(await signedActions(input.journalFile), ['contract:alpha']);
  } finally {
    await chain.stop();
  }
});

test('an outage while checking a reverted call stops resumably, and the rerun reuses its signature', async () => {
  const chain = await startAnvil();
  try {
    const { spec, artifacts } = fixture();
    const plan = await createPlan({
      spec,
      artifacts,
      client: chain.client,
      signers: { deployers: [deployerA.address], owner: owner.address },
      maxSpendWei: '100000000000000000000',
    });
    const registry = plan.resources.find((resource) => resource.id === 'contract:registry');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-finality-'));
    const input = {
      spec,
      artifacts,
      plan,
      signers: { deployer: [deployerA], owner },
      stateFile: path.join(dir, 'state.json'),
      journalFile: path.join(dir, 'journal.jsonl'),
      pollIntervalMs: 10,
      gasMultiplier: 1,
    };
    // Too little gas makes the call revert; then every state read for it fails.
    let armed = false;
    const client = Object.assign(Object.create(chain.client), {
      async estimateGas(request) {
        const estimate = await chain.client.estimateGas(request);
        return request.to?.toLowerCase() === registry.address.toLowerCase()
          ? (estimate * 60n) / 100n
          : estimate;
      },
      async readContract(request) {
        if (armed) throw unavailable();
        return chain.client.readContract(request);
      },
    });
    const hooks = {
      afterRecord(record) {
        armed ||= record.phase === 'receipt' && record.actionId === 'call:bindGamma';
      },
    };
    await assert.rejects(
      applyPlan({ ...input, client, hooks, verificationTimeoutMs: 100 }),
      (error) => error.retryable === true && error.code !== 'reverted',
    );
    const callRecords = async () =>
      (await records(input.journalFile)).filter((record) => record.actionId === 'call:bindGamma');
    assert.equal(armed, true);
    assert.equal(
      (await callRecords()).some((record) => record.phase === 'failed'),
      false,
    );
    await assert.rejects(
      applyPlan({ ...input, client: chain.client }),
      (error) => error.code === 'reverted',
    );
    assert.equal((await callRecords()).filter((record) => record.phase === 'signed').length, 1);
  } finally {
    await chain.stop();
  }
});

test('restart rejects an earlier verified action whose receipt was orphaned', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const snapshot = await chain.rpc('evm_snapshot');
    assert.equal((await applyPlan(input)).status, 'applied');
    await chain.rpc('evm_revert', [snapshot]);
    await chain.rpc('evm_mine');
    await assert.rejects(applyPlan(input), (error) => error.code === 'reorg');
    assert.equal(
      (await records(input.journalFile)).filter((record) => record.phase === 'signed').length,
      2,
    );
  } finally {
    await chain.stop();
  }
});
