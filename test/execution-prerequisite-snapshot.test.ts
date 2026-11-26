import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExecutionDependencies, revalidateDesiredState } from '../src/execution/outcome.ts';
import { shareReads } from '../src/verification/shared-reads.ts';
import type { ApplyContext } from '../src/execution/context.ts';

const hash = (block) => `0x${block.toString(16).padStart(64, '0')}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const SHARED = address('f');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resource = (id) => ({
  planned: { id, action: 'deploy', dependencies: [] },
  resource: { id, kind: 'external', address: address(id.at(-1)) },
});
const dependent = (id, dependencies) => ({
  item: { planned: { id, action: 'deploy', dependencies }, resource: { id } },
});

/**
 * A chain whose latest block advances on each read. The verifier reads the code of its resource and
 * of one shared address, then gives the status that `check` returns for the resource.
 */
function fixture({
  canonical = true,
  ids = ['contract:a', 'contract:b'],
  check = async () => 'verified',
} = {}) {
  const calls = [];
  let latest = 9n;
  const client = {
    async getBlock(args) {
      calls.push(['getBlock', args.blockTag ?? args.blockNumber]);
      if (args.blockTag === 'latest') return { number: ++latest, hash: hash(latest) };
      return { number: args.blockNumber, hash: canonical ? hash(args.blockNumber) : hash(0n) };
    },
    async getCode(args) {
      calls.push(['getCode', args.address, args.blockNumber]);
      await pause(5);
      return '0x00';
    },
  };
  const verified = [];
  const state = { active: 0, maxActive: 0 };
  const ctx = {
    plan: {
      planHash: hash(1n),
      chain: { id: 1, genesisHash: hash(2n) },
      resources: ids.map((id) => ({ id })),
    },
    config: { receiptTimeoutMs: 50, pollIntervalMs: 1, verificationTimeoutMs: 50 },
    timings: { verificationMs: 0 },
    client,
    verificationClient: null,
    stateSnapshot: null,
    prepared: new Map(ids.map((id) => [id, resource(id)])),
    outcomes: new Map(ids.map((id) => [id, { id, verification: { status: 'verified' } }])),
    journal: { records: [], forAction: () => [] },
    deps: {
      async verifyResource(target, reader, options) {
        verified.push([target.id, options.blockNumber]);
        state.maxActive = Math.max(state.maxActive, ++state.active);
        try {
          await reader.getCode({ address: target.address, blockNumber: options.blockNumber });
          await reader.getCode({ address: SHARED, blockNumber: options.blockNumber });
          const status = await check(target.id);
          return { status, reasons: status === 'verified' ? [] : ['changed'], missingProofs: [] };
        } finally {
          state.active--;
        }
      },
    },
  } as unknown as ApplyContext;
  const work = [
    dependent('contract:x', ['contract:a', 'contract:b']),
    dependent('contract:y', ['contract:b', 'contract:a']),
  ];
  return { ctx, work, calls, verified, state };
}

// The second and the third resource changed. The third answers first, and the first answers last.
const changed = {
  ids: ['contract:a', 'contract:b', 'contract:c'],
  async check(id) {
    await pause({ 'contract:a': 30, 'contract:b': 20, 'contract:c': 1 }[id]);
    return id === 'contract:a' ? 'verified' : 'conflict';
  },
};

test('the prerequisite checks of one group read at one canonical block and share identical reads', async () => {
  const { ctx, work, calls, verified } = fixture();
  await checkExecutionDependencies(ctx, work);
  assert.deepEqual(verified.toSorted(), [
    ['contract:a', 10n],
    ['contract:b', 10n],
  ]);
  const reads = (method, ...key) =>
    calls.filter(
      (call) => call[0] === method && key.every((part, index) => call[index + 1] === part),
    ).length;
  assert.equal(reads('getBlock', 'latest'), 1);
  assert.equal(reads('getCode', SHARED, 10n), 1, 'the two dependencies share the identical read');
  assert.equal(reads('getCode', address('a'), 10n), 1);
  assert.equal(reads('getCode', address('b'), 10n), 1);
  assert.deepEqual(calls.at(-1), ['getBlock', 10n], 'the snapshot is checked again before signing');

  // The next boundary selects a new block, and no read of the earlier boundary answers for it.
  await checkExecutionDependencies(ctx, work);
  assert.deepEqual(verified.slice(2).toSorted(), [
    ['contract:a', 11n],
    ['contract:b', 11n],
  ]);
  assert.equal(reads('getCode', SHARED, 11n), 1);
  assert.equal(reads('getCode', SHARED, 10n), 1);
});

test('a prerequisite snapshot that is no longer canonical stops the group', async () => {
  const { ctx, work } = fixture({ canonical: false });
  await assert.rejects(checkExecutionDependencies(ctx, work), { code: 'reorg', retryable: true });
});

test('the earliest failed prerequisite is reported after every started check has finished', async () => {
  const { ctx, state } = fixture(changed);
  const work = [
    dependent('contract:x', ['contract:a']),
    dependent('contract:y', ['contract:b', 'contract:c']),
    dependent('contract:z', ['contract:c']),
  ];
  await assert.rejects(checkExecutionDependencies(ctx, work), (error) => {
    assert.equal(error.code, 'dependency');
    assert.equal(error.actionId, 'contract:y');
    assert.match(error.message, /contract:y needs verified dependency contract:b/);
    return true;
  });
  assert.equal(state.active, 0, 'no check is in flight when the phase stops');
});

test('prerequisite checks in flight stay within a small bound', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `contract:${index.toString(16)}`);
  const { ctx, state, verified } = fixture({ ids, check: () => pause(5).then(() => 'verified') });
  await checkExecutionDependencies(ctx, [dependent('contract:x', ids)]);
  assert.equal(verified.length, 12);
  assert.ok(state.maxActive <= 8 && state.maxActive < ids.length, `${state.maxActive} in flight`);
});

test('the final check reads at one canonical block and reports the earliest failed resource', async () => {
  const passing = fixture();
  assert.deepEqual(await revalidateDesiredState(passing.ctx), { number: 10n, hash: hash(10n) });
  assert.deepEqual(passing.verified.toSorted(), [
    ['contract:a', 10n],
    ['contract:b', 10n],
  ]);
  assert.deepEqual(passing.calls.at(-1), ['getBlock', 10n], 'the block is checked again last');

  const { ctx, state } = fixture(changed);
  const outcomes = [...ctx.outcomes];
  await assert.rejects(revalidateDesiredState(ctx), {
    code: 'postcondition',
    actionId: 'contract:b',
  });
  assert.equal(state.active, 0, 'no check is in flight when the phase stops');
  assert.deepEqual([...ctx.outcomes], outcomes, 'a failed final check changes no outcome');
});

test('shared reads keep no failed read and never cross clients, blocks or arguments', async () => {
  const provider = (name) => {
    const calls = [];
    let fail = true;
    return {
      calls,
      async getCode(args) {
        calls.push(args);
        if (args.address === address('e') && fail) {
          fail = false;
          throw new Error('provider unavailable');
        }
        return `${name}:${args.address}:${args.blockNumber ?? 'latest'}`;
      },
    };
  };
  const primary = provider('primary');
  const alternate = provider('alternate');
  const [first, second] = [shareReads(primary), shareReads(alternate)];
  const at = (reader, digit, blockNumber) =>
    reader.getCode({ address: address(digit), blockNumber });

  assert.equal(await at(first, 'a', 5n), await at(first, 'a', 5n));
  assert.equal(primary.calls.length, 1);
  assert.notEqual(await at(first, 'a', 6n), await at(first, 'a', 5n));
  assert.notEqual(await at(first, 'b', 5n), await at(first, 'a', 5n));
  assert.equal(primary.calls.length, 3);
  assert.match(await at(second, 'a', 5n), /^alternate/);
  assert.equal(alternate.calls.length, 1, 'the alternate client does not answer from the primary');

  await at(first, 'a', undefined);
  await at(first, 'a', undefined);
  assert.equal(primary.calls.length, 5, 'a read without a block number is never shared');

  await assert.rejects(at(first, 'e', 5n), /provider unavailable/);
  assert.match(await at(first, 'e', 5n), /^primary/, 'a retry asks the provider again');
});
