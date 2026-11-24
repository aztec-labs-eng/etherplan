import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keccak256, parseAbi, toBytes } from 'viem';
import { normalizeArtifact } from '../src/artifacts.ts';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan } from '../src/planning/index.ts';
import { applyPlan } from '../src/execution/index.ts';
import { readLocalJournal } from '../src/execution/journal.ts';
import { readState } from '../src/state/index.ts';
import { deployerA, owner, startAnvil } from './execution/chain.ts';

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const selector = (signature) => keccak256(toBytes(signature)).slice(2, 10);
const ABI = parseAbi([
  'function row(uint8 key) view returns (uint256)',
  'function configure(uint256 a, uint256 b)',
  'error Missing(uint8 key)',
]);
function runtime() {
  const prefix = '60003560e01c';
  let dispatch = ['row(uint8)', 'configure(uint256,uint256)']
    .map((signature) => `8063${selector(signature)}1460xx57`)
    .join('');
  const fallback = '600080fd';
  const rowStart = (prefix.length + dispatch.length + fallback.length) / 2;
  let row = '506004358054801560xx5760005260206000f3';
  const missingStart = rowStart + 1 + row.length / 2;
  row = row.replace('xx', missingStart.toString(16).padStart(2, '0'));
  row += `5b5063${selector('Missing(uint8)')}60e01b60005260045260246000fd`;
  const configureStart = rowStart + 1 + row.length / 2;
  const destinations = [rowStart, configureStart];
  dispatch = dispatch.replaceAll('xx', () => destinations.shift().toString(16).padStart(2, '0'));
  return `0x${prefix}${dispatch}${fallback}5b${row}5b5060043560015560243560025500`;
}
for (const pipeline of [false, true]) {
  test(`grouped call recovery and reuse preserve one signature (${pipeline ? 'pipeline' : 'serial'})`, async () => {
    const chain = await startAnvil();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-grouped-checks-'));
    try {
      const code = runtime();
      await chain.rpc('anvil_setCode', [ADDRESS, code]);
      await chain.rpc('anvil_setStorageAt', [ADDRESS, '0x3', `0x${'0'.repeat(63)}7`]);
      const artifact = normalizeArtifact(
        { abi: ABI, bytecode: { object: '0x00' }, deployedBytecode: { object: code } },
        'Table',
      );
      const source = `chain_id = 31337
resource "contract" "table" {
  artifact = "Table.json"
  address = "${ADDRESS}"
  code_hash = "${keccak256(code)}"
}
resource "call" "configure" {
  target = contracts.table
  method = "configure"
  args = [10, 20]
}
${[1, 2]
  .map(
    (key) => `resource "check" "row${key}" {
  target = calls.configure
  getter = "row"
  args = [${key}]
  before_revert = { error = "Missing", args = [${key}] }
  equals = ${key * 10}
}`,
  )
  .join('\n')}
resource "check" "unchanged" {
  target = calls.configure
  getter = "row"
  args = [3]
  before = 7
  equals = 7
}`;
      const spec = compileSpec(parseHcl('grouped.ethp', source));
      const artifacts = new Map([['table', artifact]]);
      const policy = { deployers: [deployerA.address], owner: owner.address };
      const planning = {
        spec,
        artifacts,
        client: chain.client,
        ...(pipeline ? { pipeline: policy } : { signers: policy }),
        maxSpendWei: '100000000000000000',
      };
      const plan = await createPlan(planning);
      assert.equal(plan.resources.find((r) => r.kind === 'call').action, 'call');
      const input = {
        ...planning,
        plan,
        pipeline,
        signers: { deployer: [deployerA], owner },
        stateFile: path.join(dir, 'state.json'),
        journalFile: path.join(dir, 'journal.jsonl'),
        confirmations: 1,
        pollIntervalMs: 1,
      };
      const interruption = new Error('stop before state commit');
      await assert.rejects(
        applyPlan({
          ...input,
          hooks: {
            afterRecord(record) {
              if (record.phase === 'verified' && record.actionId === 'call:configure')
                throw interruption;
            },
          },
        }),
        (error) => error === interruption,
      );
      assert.equal((await applyPlan(input)).status, 'applied');
      assert.equal(
        (await readLocalJournal(input.journalFile)).filter((r) => r.phase === 'signed').length,
        1,
      );
      assert.equal(await chain.client.getTransactionCount({ address: owner.address }), 1);
      const state = await readState(input.stateFile);
      const reused = await createPlan({ ...planning, state });
      assert(reused.resources.every((r) => r.action === 'reuse'));
      assert.equal((await applyPlan({ ...input, plan: reused })).status, 'applied');
      assert.equal(await chain.client.getTransactionCount({ address: owner.address }), 1);
    } finally {
      await chain.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
