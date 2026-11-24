import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractFunctionRevertedError, encodeErrorResult, keccak256, parseAbi } from 'viem';
import { normalizeArtifact } from '../src/artifacts.ts';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { recordResource } from '../src/state/index.ts';
import { verifyResource } from '../src/verification/index.ts';

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const CODE = '0x6000';
const HASH = `0x${'ab'.repeat(32)}`;
const ABI = parseAbi([
  'function row(uint8 key) view returns (uint256)',
  'function configure(uint256 a, uint256 b)',
  'error Missing(uint8 key)',
  'error Other(uint8 key)',
]);
const artifact = normalizeArtifact(
  {
    abi: ABI,
    bytecode: { object: '0x00' },
    deployedBytecode: { object: CODE },
  },
  'Table',
);

const checks = [1, 2].map(
  (key) => `resource "check" "row${key}" {
  target = calls.configure
  getter = "row"
  args = [${key}]
  before_revert = { error = "Missing", args = [${key}] }
  equals = ${key * 10}
}`,
);
const stable = `resource "check" "unchanged" {
  target = calls.configure
  getter = "row"
  args = [3]
  before = 7
  equals = 7
}`;
function source(blocks = [...checks, stable]) {
  return `chain_id = 31337
resource "contract" "table" {
  artifact = "Table.json"
  address = "${ADDRESS}"
  code_hash = "${keccak256(CODE)}"
}
resource "call" "configure" {
  target = contracts.table
  method = "configure"
  args = [10, 20]
}
${blocks.join('\n')}`;
}
function compiled(text = source()) {
  return compileSpec(parseHcl('checks.ethp', text));
}
function setup(text = source()) {
  const spec = compiled(text);
  const artifacts = new Map([['table', artifact]]);
  const { resources } = prepareResources(spec, null, artifacts);
  return { spec, artifacts, call: resources.find((r) => r.kind === 'call') };
}
function missing(key, errorName = 'Missing') {
  return new ContractFunctionRevertedError({
    abi: ABI,
    functionName: 'row',
    data: encodeErrorResult({ abi: ABI, errorName, args: [key] }),
  });
}
function client(values = [missing(1), missing(2), 7n]) {
  const reads = [];
  return {
    reads,
    getChainId: async () => 31337,
    getBlock: async ({ blockNumber } = {}) => ({ number: blockNumber ?? 7n, hash: HASH }),
    getCode: async () => CODE,
    readContract: async (request) => {
      reads.push(request);
      const value = values[Number(request.args[0]) - 1];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

test('one grouped call is pending when all before outcomes match, including unchanged values', async () => {
  const { spec, artifacts, call } = setup();
  const rpc = client();
  const result = await verifyResource(call, rpc, { blockNumber: 7n });
  assert.equal(result.status, 'unverified');
  assert.equal(result.bindingChecks.length, 3);
  assert(rpc.reads.every((read) => read.blockNumber === 7n));
  const plan = await createPlan({
    spec,
    artifacts,
    client: rpc,
    signers: { deployers: [ADDRESS], owner: ADDRESS },
  });
  assert.equal(plan.resources.find((r) => r.kind === 'call').action, 'call');
  assert.equal(plan.resources.filter((r) => r.tx).length, 1);
});

test('a complete grouped snapshot is reused and can be recorded', async () => {
  const { spec, artifacts, call } = setup();
  const rpc = client([10n, 20n, 7n]);
  const result = await verifyResource(call, rpc, { blockNumber: 7n });
  assert.equal(result.status, 'verified');
  assert(result.bindingChecks.every((check) => check.observed === 'after'));
  assert.doesNotThrow(() =>
    recordResource({
      resource: call,
      verification: result,
      state: null,
      chain: { id: 31337, genesisHash: HASH },
    }),
  );
  const plan = await createPlan({
    spec,
    artifacts,
    client: rpc,
    signers: { deployers: [ADDRESS], owner: ADDRESS },
  });
  assert.equal(plan.resources.find((r) => r.kind === 'call').action, 'reuse');
});

test('partial writes and conflicting unchanged values never authorize another grouped transaction', async () => {
  const { spec, artifacts, call } = setup();
  for (const values of [
    [10n, missing(2), 7n],
    [missing(1), 20n, 7n],
    [missing(1), missing(2), 8n],
  ]) {
    const rpc = client(values);
    const result = await verifyResource(call, rpc, { blockNumber: 7n });
    assert.equal(result.status, 'conflict');
    assert.throws(() =>
      recordResource({
        resource: call,
        verification: result,
        state: null,
        chain: { id: 31337, genesisHash: HASH },
      }),
    );
    const plan = await createPlan({
      spec,
      artifacts,
      client: rpc,
      signers: { deployers: [ADDRESS], owner: ADDRESS },
    });
    assert.equal(plan.resources.find((r) => r.kind === 'call').action, 'conflict');
  }
});

test('expected reverts match complete error data, never arbitrary errors with data attached', async () => {
  const { call } = setup();
  for (const error of [
    missing(9),
    missing(1, 'Other'),
    new Error('RPC timeout'),
    Object.assign(new Error('RPC failure'), { data: missing(1).raw }),
  ]) {
    const result = await verifyResource(call, client([error, missing(2), 7n]));
    assert.equal(result.status, 'conflict');
  }
});

test('expected errors work across separate Viem copies without accepting transport errors', async () => {
  const { call } = setup();
  const foreign = (name, raw) =>
    new Error('read failed', {
      cause: Object.assign(new Error('reverted'), { name, raw }),
    });
  assert.equal(
    (
      await verifyResource(
        call,
        client([foreign('ContractFunctionRevertedError', missing(1).raw), missing(2), 7n]),
      )
    ).status,
    'unverified',
  );
  for (const error of [
    foreign('ContractFunctionRevertedError', missing(9).raw),
    foreign('RpcRequestError', missing(1).raw),
  ])
    assert.equal((await verifyResource(call, client([error, missing(2), 7n]))).status, 'conflict');
});

test('a declared missing result can be required after a write', async () => {
  const absent = `resource "check" "absent" {
    target = calls.configure
    getter = "row"
    args = [3]
    before_revert = { error = "Missing", args = [3] }
    after_revert = { error = "Missing", args = [3] }
  }`;
  const { call } = setup(source([...checks, absent]));
  assert.equal((await verifyResource(call, client([10n, 20n, missing(3)]))).status, 'verified');
  assert.equal((await verifyResource(call, client([10n, 20n, 7n]))).status, 'conflict');
});

test('check declaration order does not change the compiled spec', () => {
  assert.deepEqual(compiled(), compiled(source([stable, ...checks.toReversed()])));
});

test('ambiguous outcomes and unknown or invalid custom errors fail before chain reads', () => {
  for (const text of [
    source().replace(
      'equals = 10',
      'equals = 10\n after_revert = { error = "Missing", args = [1] }',
    ),
    source().replace('before_revert =', 'before = 0\n before_revert ='),
    source().replace('error = "Missing"', 'error = "Unknown"'),
    source().replace('error = "Missing", args = [1]', 'error = "Missing", args = [256]'),
  ])
    assert.throws(() => setup(text));
});
