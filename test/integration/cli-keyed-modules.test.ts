import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { moduleProject } from '../module-fixtures.ts';
import { TEST_KEYS } from '../execution/chain.ts';
import { startAnvil, stopAnvil } from './anvil.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const spend = '100000000000000000000';
const child = `variable "config" {}
mixer = var.config.mixer
resource "contract" "item" {
  artifact = "Minimal.json"
  salt = derive
  args = []
  sender_independent = true
}
output "ready" { value = contracts.item.address }`;

test('keyed CLI plans name instances; reordered seeds apply and added keys leave existing state reusable', async (t) => {
  const anvil = await startAnvil();
  t.after(() => stopAnvil(anvil));
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
variable "rows" {}
module "item" {
  source = "./item"
  for_each = var.rows
  config = each.value
}`,
    'main.ethpvars': 'rows = { a = { mixer = "cli/a" }, b = { mixer = "cli/b" } }',
    'item/main.ethp': child,
  });
  await copyFile(
    path.join(root, 'test/fixtures/Minimal.json'),
    path.join(project.directory, 'item/Minimal.json'),
  );
  const run = (args, signed = false) =>
    spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
      cwd: project.directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ETH_RPC_URL: anvil.rpcUrl,
        ...(signed ? { DEPLOYER_PRIVATE_KEYS: TEST_KEYS[0] } : {}),
      },
    });
  const json = (result) => {
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const planArgs = ['plan', '--out', 'plan.json', '--deployers', owner, '--max-spend-wei', spend];
  const text = run(planArgs);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /module\.item\["a"\]/);
  const original = JSON.parse(await readFile(path.join(project.directory, 'plan.json'), 'utf8'));
  const schedule = json(run(['schedule', '--plan', 'plan.json']));
  const entries = schedule.waves.flatMap((wave) => wave.batches.flat());
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => original.resources.some((item) => item.id === entry.id)));
  assert.ok(entries.some((entry) => entry.label.includes('module.item["a"]')));
  await project.write(
    'main.ethpvars',
    'rows = { b = { mixer = "cli/b" }, a = { mixer = "cli/a" } }',
  );
  const applied = json(run(['apply', '--json', '--plan', 'plan.json'], true));
  assert.equal(applied.status, 'applied');
  assert.equal(applied.transactionsSigned, 2);
  const reuse = json(run([...planArgs, '--json']));
  assert.deepEqual(
    reuse.resources.map((item) => item.action),
    ['reuse', 'reuse'],
  );
  await project.write(
    'main.ethpvars',
    'rows = { c = { mixer = "cli/c" }, b = { mixer = "cli/b" }, a = { mixer = "cli/a" } }',
  );
  const added = json(run([...planArgs, '--json']));
  assert.equal(added.resources.filter((item) => item.action === 'deploy').length, 1);
  for (const resource of original.resources) {
    const same = added.resources.find((item) => item.id === resource.id);
    assert.equal(same.action, 'reuse');
    assert.equal(same.address, resource.address);
  }
});

test('a changed root record field stops CLI saved-plan apply before any signature', async (t) => {
  const anvil = await startAnvil();
  t.after(() => stopAnvil(anvil));
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
variable "config" {}
mixer = var.config.mixer
resource "contract" "item" {
  artifact = "Minimal.json"
  salt = derive
  args = []
}`,
    'main.ethpvars': 'config = { mixer = "cli/record" }',
  });
  await copyFile(
    path.join(root, 'test/fixtures/Minimal.json'),
    path.join(project.directory, 'Minimal.json'),
  );
  const run = (args) =>
    spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
      cwd: project.directory,
      encoding: 'utf8',
      env: { ...process.env, ETH_RPC_URL: anvil.rpcUrl, DEPLOYER_PRIVATE_KEYS: TEST_KEYS[0] },
    });
  const planned = run([
    'plan',
    '--out',
    'plan.json',
    '--deployers',
    owner,
    '--max-spend-wei',
    spend,
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const nonce = await anvil.rpc('eth_getTransactionCount', [owner, 'latest']);
  await project.write('main.ethpvars', 'config = { mixer = "cli/record-changed" }');
  const applied = run(['apply', '--plan', 'plan.json']);
  assert.equal(applied.status, 1);
  assert.match(`${applied.stderr}\n${applied.stdout}`, /stale-spec/);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [owner, 'latest']), nonce);
});
