import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { formatPlanReport } from '../src/cli/reporting.ts';
import { canonicalJson, hashJson } from '../src/identity.ts';
import { createPlan } from '../src/planning/index.ts';
import { graph, parseSpec } from '../src/spec/index.ts';
import { importResource } from '../src/state/index.ts';
import { verifyResource } from '../src/verification/index.ts';
import { normalizedArtifact } from './interface-fixtures.ts';
import {
  CHAIN,
  OWNER,
  OTHER,
  acceptPlan,
  artifactsFor,
  factorySource,
  moduleProject,
  planningClient,
  prepared,
} from './module-fixtures.ts';

const minimal = `variable "config" {}
mixer = var.config.mixer
resource "contract" "item" {
  artifact = "Minimal.json"
  salt = derive
  args = []
  sender_independent = true
}
output "ready" {
  value = contracts.item.address
  after = [contracts.item]
}`;

const producer = `variable "mixer" {}
variable "owner" {}
mixer = var.mixer
resource "contract" "registry" {
  artifact = "Registry.json"
  salt = derive
  args = [var.owner]
}
resource "call" "initialize" {
  target = contracts.registry
  method = "setBinding"
  args = [var.owner]
}
resource "check" "binding" {
  target = calls.initialize
  getter = "binding"
  before = "${OTHER}"
  equals = var.owner
}
output "ready" {
  value = contracts.registry.address
  after = [calls.initialize]
}`;

const consumer = `variable "mixer" {}
variable "portal" { type = address }
mixer = var.mixer
resource "contract" "holder" {
  artifact = "Holder.json"
  salt = derive("consumer")
  args = [var.portal]
}
resource "call" "configure" {
  target = var.portal
  method = "setBinding"
  args = [contracts.holder.address]
}
resource "check" "binding" {
  target = calls.configure
  getter = "binding"
  before = "${OWNER}"
  equals = contracts.holder.address
}`;

const rows = (keys) =>
  `rows = { ${keys.map((key) => `${key} = { mixer = "keyed/${key}", owner = "${OWNER}", bridge = "${key}" }`).join(', ')} }`;
const repeatedRoot = `chain_id = 31337
${factorySource}
variable "rows" {}
module "item" {
  source = "./item"
  for_each = var.rows
  config = each.value
}`;

async function ownedState(spec) {
  const resources = prepared(spec).resources;
  const code = new Map(
    resources.map((item) => [
      item.address.toLowerCase(),
      normalizedArtifact.deployedBytecode.object,
    ]),
  );
  const client = planningClient({ code });
  let state = null;
  for (const resource of resources)
    state = importResource({
      resource,
      verification: await verifyResource(resource, client),
      state,
      chain: CHAIN,
    });
  return { state: { ...state, moduleRoot: true }, code, client };
}

function physical(spec) {
  const resources = prepared(spec).resources;
  const names = new Map(
    resources.map((item) => [item.id, `${item.kind}:${item.address}:${item.method ?? ''}`]),
  );
  return resources
    .map((item) => ({
      kind: item.kind,
      address: item.address,
      salt: item.salt ?? null,
      initcode: item.initcode ?? null,
      inputs: item.inputs ?? null,
      checks: item.checks ?? null,
      args: item.args ?? null,
      before: item.before ?? null,
      after: item.after ?? null,
      dependencies: item.dependencies.map((id) => names.get(id)).sort(),
      resolution: (item.resolutionDependencies ?? []).map((id) => names.get(id)).sort(),
      execution: (item.executionEdges ?? [])
        .map((edge) => ({ ...edge, id: names.get(edge.id) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

test('single-module output readiness preserves the producer initialization barrier', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
module "portal" {
  source = "./producer"
  mixer = "baseline/producer"
  owner = "${OWNER}"
}
module "bridge" {
  source = "./consumer"
  mixer = "baseline/consumer"
  portal = module.portal.ready
}`,
    'producer/main.ethp': producer,
    'consumer/main.ethp': consumer,
  });
  const spec = await project.compile();
  const nodes = graph(parseSpec(spec));
  const initialize = `call:${spec.calls.find((item) => item.id.endsWith('_initialize')).id}`;
  for (const node of nodes.filter((item) => item.id.includes('bridge')))
    assert.ok(node.executionDependencies.includes(initialize));
});

test('created_by exports carry live verification and require a matching before_absent creator check', async (t) => {
  const creator = `resource "external" "factory" {
  address = "${OTHER}"
  abi = [
    { type = "function", name = "create", stateMutability = "nonpayable", inputs = [], outputs = [] },
    { type = "function", name = "UPSTREAM", stateMutability = "view", inputs = [], outputs = [{ type = "address" }] }
  ]
}
resource "call" "create" {
  target = externals.factory
  method = "create"
  args = []
}
resource "check" "created" {
  target = calls.create
  address = "${OWNER}"
  getter = "UPSTREAM"
  before_absent = true
  equals = "${OTHER}"
}
resource "contract" "child" {
  artifact = "Holder.json"
  address = "${OWNER}"
  code_hash = "${keccak256('0x6000')}"
  created_by = calls.create
}
output "ready" { value = contracts.child.address }`;
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
module "creator" { source = "./creator" }
resource "contract" "consumer" {
  artifact = "Holder.json"
  salt = "0x${'11'.repeat(32)}"
  args = [module.creator.ready]
}`,
    'creator/main.ethp': creator,
  });
  const spec = await project.compile();
  const child = spec.contracts.find((item) => item.id.endsWith('_child'));
  assert.deepEqual(spec.contracts.find((item) => item.id === 'consumer').args, [
    { ref: `contracts.${child.id}.address`, requiresLive: true },
  ]);
  assert.equal(spec.calls[0].before.absent, true);
  assert.ok(
    graph(parseSpec(spec))
      .find((item) => item.id === `contract:${child.id}`)
      .executionDependencies.includes(child.createdBy),
  );
  assert.doesNotThrow(() => prepared(spec));
  await project.write(
    'creator/main.ethp',
    creator.replace('before_absent = true', `before = "${OTHER}"`),
  );
  const invalid = await project.compile();
  assert.throws(() => prepared(invalid), /createdBy needs a creator call with before_absent/);
});

test('keyed calls preserve physical addresses and dependencies of separate calls', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
variable "rows" {}
module "portal" {
  source = "./producer"
  for_each = var.rows
  mixer = each.value.mixer
  owner = each.value.owner
}
module "bridge" {
  source = "./consumer"
  for_each = var.rows
  mixer = each.value.mixer
  portal = module.portal[each.value.bridge].ready
}`,
    'main.ethpvars': rows(['a', 'b']),
    'producer/main.ethp': producer,
    'consumer/main.ethp': consumer,
  });
  const repeated = await project.compile();
  const separate = ['a', 'b']
    .map(
      (key) => `module "portal_${key}" {
  source = "./producer"
  mixer = "keyed/${key}"
  owner = "${OWNER}"
}
module "bridge_${key}" {
  source = "./consumer"
  mixer = "keyed/${key}"
  portal = module.portal_${key}.ready
}`,
    )
    .join('\n');
  await project.write('main.ethp', `chain_id = 31337\n${separate}`);
  await project.write('main.ethpvars', '');
  assert.deepEqual(physical(repeated), physical(await project.compile()));
  assert.equal(repeated.modules.version, 2);
  assert.deepEqual(
    repeated.modules.instances
      .filter((item) => item.path[0] === 'portal')
      .map((item) => item.path[1]),
    [{ key: 'a' }, { key: 'b' }],
  );
});

test('adding a key only deploys its resources; field order preserves spec hash and saved plans', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': repeatedRoot,
    'main.ethpvars': rows(['a', 'b']),
    'item/main.ethp': minimal,
  });
  const original = await project.compile();
  const { state, code, client } = await ownedState(original);
  const originalPlan = await createPlan({
    spec: original,
    artifacts: artifactsFor(original),
    client,
    state,
  });
  assert.match(formatPlanReport(originalPlan, 'keyed', 'default'), /module\.item\["a"\]/);
  await project.write('main.ethpvars', rows(['b', 'a']));
  const reordered = await project.compile();
  assert.equal(hashJson(original), hashJson(reordered));
  assert.equal(canonicalJson(original), canonicalJson(reordered));
  await acceptPlan(originalPlan, reordered, client);
  await project.write('main.ethpvars', rows(['c', 'b', 'a']));
  const added = await project.compile();
  const plan = await createPlan({
    spec: added,
    artifacts: artifactsFor(added),
    client: planningClient({ code }),
    state,
  });
  for (const contract of original.contracts) {
    assert.deepEqual(
      added.contracts.find((item) => item.id === contract.id),
      contract,
    );
    assert.equal(
      plan.resources.find((item) => item.id === `contract:${contract.id}`).action,
      'reuse',
    );
  }
  assert.equal(plan.resources.filter((item) => item.action === 'deploy').length, 1);
  await project.write('main.ethpvars', rows(['a']));
  const removed = await project.compile();
  await assert.rejects(
    createPlan({ spec: removed, artifacts: artifactsFor(removed), client, state }),
    /Module root omitted owned contracts/,
  );
});

test('keyed consumers wait only for their selected producer and target its contract', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
variable "rows" {}
variable "fee_row" { default = "a" }
locals { chosen = var.fee_row }
module "portal" {
  source = "./producer"
  for_each = var.rows
  mixer = each.value.mixer
  owner = each.value.owner
}
module "bridge" {
  source = "./consumer"
  for_each = var.rows
  mixer = each.value.mixer
  portal = module.portal[each.key].ready
}
module "single" {
  source = "./consumer"
  mixer = "keyed/single"
  portal = module.portal[local.chosen].ready
}`,
    'main.ethpvars': rows(['a', 'b']),
    'producer/main.ethp': producer,
    'consumer/main.ethp': consumer,
  });
  const spec = await project.compile();
  const nodes = graph(parseSpec(spec));
  for (const key of ['a', 'b']) {
    const portal = spec.modules.instances.find(
      (item) => item.path[0] === 'portal' && item.path[1]?.key === key,
    );
    const bridge = spec.modules.instances.find(
      (item) => item.path[0] === 'bridge' && item.path[1]?.key === key,
    );
    const initialize = portal.resources.call.initialize;
    const holder = nodes.find((item) => item.id === bridge.resources.contract.holder);
    assert.ok(holder.executionDependencies.includes(initialize));
    assert.equal(holder.executionDependencies.filter((id) => id.endsWith('_initialize')).length, 1);
    const call = spec.calls.find((item) => `call:${item.id}` === bridge.resources.call.configure);
    assert.equal(`contract:${call.target}`, portal.resources.contract.registry);
  }
  assert.doesNotThrow(() => prepared(spec));
});

test('empty and null repetition makes no instances or actions and unknown keys never become null', async (t) => {
  const project = await moduleProject(t, { 'main.ethp': repeatedRoot, 'item/main.ethp': minimal });
  for (const value of ['{}', 'null']) {
    await project.write('main.ethpvars', `rows = ${value}`);
    const spec = await project.compile();
    assert.deepEqual(spec.modules.instances, []);
    assert.deepEqual(
      (await createPlan({ spec, artifacts: artifactsFor(spec), client: planningClient() }))
        .resources,
      [],
    );
    await project.write(
      'main.ethp',
      `${repeatedRoot}\noutput "missing" { value = module.item["a"].ready }`,
    );
    await assert.rejects(project.compile(), /module\.item.*a.*(?:keys|Keys).*\(none\)/);
    await project.write('main.ethp', repeatedRoot);
  }
});

test('nested keyed calls cannot collide with child call names and accept child record inputs', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
module "x" {
  source = "./parent"
  config = { a = { mixer = "nested/a" } }
}
module "keyed" {
  source = "./item"
  for_each = { a = { mixer = "nested/key" } }
  config = each.value
}`,
    'parent/main.ethp': `variable "config" {}
module "a" {
  source = "../item"
  config = { mixer = "nested/plain" }
}
module "inner" {
  source = "../item"
  for_each = var.config
  config = each.value
}`,
    'item/main.ethp': minimal,
  });
  const spec = await project.compile();
  assert.equal(new Set(spec.contracts.map((item) => item.id)).size, 3);
  // A keyed segment and a named child segment must be different identities.
  const { moduleResourceId } = await import('../src/input/modules.ts');
  assert.notEqual(
    moduleResourceId(['x', { key: 'a' }], 'item'),
    moduleResourceId(['x', 'a'], 'item'),
  );
});

test('null instance values override non-null child defaults', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337
module "item" {
  source = "./item"
  for_each = { a = null }
  config = each.value
}`,
    'item/main.ethp': `variable "config" { default = { owner = "${OWNER}" } }
output "owner" { value = var.config.owner }`,
  });
  assert.equal((await project.compile()).modules.instances[0].outputs.owner.value, null);
});

test('invalid repetition scopes, keys, reference forms and reserved inputs have actionable errors', async (t) => {
  const project = await moduleProject(t, {
    'main.ethp': repeatedRoot,
    'main.ethpvars': rows(['a', 'b']),
    'item/main.ethp': minimal,
  });
  for (const [root, pattern] of [
    [`${repeatedRoot}\noutput "x" { value = each.key }`, /each.*only.*repeated module call/],
    [`${repeatedRoot}\noutput "x" { value = module.item.ready }`, /module\.item.*\[.*key.*\]/],
    [
      `${repeatedRoot}\noutput "x" { value = module.item["missing"].ready }`,
      /module\.item.*missing.*(?:keys|Keys).*a.*b/,
    ],
    [
      repeatedRoot
        .replace('for_each = var.rows', 'config_unused = var.rows')
        .replace('config = each.value', 'config = { mixer = "single" }') +
        '\noutput "x" { value = module.item["a"].ready }',
      /single.*module\.item\.ready/,
    ],
    [
      repeatedRoot.replace('for_each = var.rows', 'for_each = [var.rows]'),
      /for_each.*constant record/,
    ],
    [repeatedRoot.replace('config = each.value', 'config = each.missing'), /each.*(?:key|value)/],
  ]) {
    await project.write('main.ethp', root);
    await assert.rejects(project.compile(), pattern);
  }
  await project.write('main.ethp', repeatedRoot);
  for (const key of ['UPPER', 'has_dash', 'abcdefghijklmn']) {
    await project.write('main.ethpvars', `rows = { "${key}" = { mixer = "invalid" } }`);
    await assert.rejects(project.compile(), /key.*(?:lowercase|a-z0-9|12)/i);
  }
  await project.write('main.ethpvars', rows(['a']));
  await project.write(
    'item/main.ethp',
    'variable "for_each" { default = null }\noutput "x" { value = var.for_each }',
  );
  await assert.rejects(project.compile(), /for_each.*reserved/);
});
