import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_KEYS } from '../execution/chain.ts';
import { startAnvil, stopAnvil } from './anvil.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const maxSpend = '100000000000000000000';
const kept = 'contract:module1_4_kept_item';
const moved = 'contract:module1_5_moved_item';
let anvil;
let directory;

const file = (name) => path.join(directory, name);
const stateFile = () => file('.etherplan/default/state.json');

function runCli(args, signed = false) {
  return spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: anvil.rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: TEST_KEYS[0] } : {}),
    },
  });
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function failed(result, pattern) {
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, pattern);
}

// A root that calls one module twice, as a deployment root calls the modules it owns.
async function writeRoot(calls) {
  await writeFile(
    file('main.ethp'),
    [
      'chain_id = 31337',
      ...calls.map(
        (name) =>
          `variable "${name}" {}\nmodule "${name}" {\n  source = "./item"\n  config = var.${name}\n}`,
      ),
    ].join('\n\n'),
  );
  await writeFile(
    file('main.ethpvars'),
    calls.map((name) => `${name} = { mixer = "state-rm/${name}" }`).join('\n'),
  );
}

before(async () => {
  anvil = await startAnvil();
  directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-cli-state-rm-'));
  await mkdir(file('item'));
  await writeFile(
    file('item/main.ethp'),
    `variable "config" {}
mixer = var.config.mixer

resource "contract" "item" {
  artifact           = "Minimal.json"
  salt               = derive
  args               = []
  sender_independent = true
}`,
  );
  await copyFile(path.join(root, 'test/fixtures/Minimal.json'), file('item/Minimal.json'));
  await writeRoot(['kept', 'moved']);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await stopAnvil(anvil);
});

test('state rm lets a module root drop a module it no longer calls, and the root then plans reuse', async () => {
  const planArgs = ['plan', '--deployers', owner, '--max-spend-wei', maxSpend];
  succeeded(runCli([...planArgs, '--json', '--out', 'plan.json']));
  assert.equal(
    succeeded(runCli(['apply', '--json', '--plan', 'plan.json'], true)).status,
    'applied',
  );
  const applied = JSON.parse(await readFile(stateFile(), 'utf8'));
  assert.deepEqual(Object.keys(applied.resources).sort(), [kept, moved]);
  const journal = await readFile(`${stateFile()}.journal.jsonl`, 'utf8');
  const nonce = await anvil.rpc('eth_getTransactionCount', [owner, 'latest']);

  await writeRoot(['kept']);
  failed(
    runCli([...planArgs, '--out', '-']),
    new RegExp(`Module root omitted owned contracts: ${moved}\\. .*etherplan state rm`),
  );
  failed(
    runCli(['state', 'rm', '--resources', `${moved},${kept}`]),
    new RegExp(`The project still declares ${kept}\\.`),
  );
  failed(
    runCli(['state', 'rm', '--resources', 'contract:module1_5_other_item']),
    /State has no contract:module1_5_other_item\./,
  );
  assert.deepEqual(JSON.parse(await readFile(stateFile(), 'utf8')), applied);

  assert.deepEqual(succeeded(runCli(['state', 'rm', '--resources', moved])), {
    status: 'removed',
    removed: [moved],
    stateFile: stateFile(),
  });
  const removed = JSON.parse(await readFile(stateFile(), 'utf8'));
  assert.deepEqual(Object.keys(removed.resources), [kept]);
  assert.deepEqual(removed.resources[kept], applied.resources[kept]);
  assert.equal(removed.moduleRoot, true);
  assert.equal(removed.lastPlanHash, undefined);
  assert.equal(await readFile(`${stateFile()}.journal.jsonl`, 'utf8'), journal);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [owner, 'latest']), nonce);

  const plan = succeeded(runCli([...planArgs, '--json', '--out', '-']));
  assert.deepEqual(
    plan.resources.map((resource) => [resource.id, resource.action]),
    [[kept, 'reuse']],
  );
});

test('state rm needs resource ids and explains itself', () => {
  const missing = runCli(['state', 'rm']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /state rm needs --resources/);
  const help = runCli(['state', 'rm', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: etherplan state rm \[options\]/);
  assert.match(help.stdout, /Remove resources from state without touching the chain\./);
});
