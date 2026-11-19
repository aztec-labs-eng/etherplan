import assert from 'node:assert/strict';
import test from 'node:test';
import { hashJson } from '../src/identity.ts';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan } from '../src/planning/index.ts';
import { dependencyGraphs, graph, parseSpec } from '../src/spec/index.ts';
import {
  OWNER,
  OTHER,
  acceptPlan,
  artifactsFor,
  factorySource,
  moduleProject,
  planningClient,
  prepared,
} from './module-fixtures.ts';

function compile(source, values = '') {
  return compileSpec(parseHcl('main.ethp', source), {
    files: [{ file: 'main.ethpvars', document: parseHcl('main.ethpvars', values) }],
  });
}

const declarations = `variable "config" { type = any }`;
const body = `chain_id = 31337
${factorySource}
mixer = var.config.mixer
locals { owner = var.config.nested.owner }
resource "contract" "registry" {
  artifact = "Registry.json"
  salt = derive
  generation = var.config.generation
  args = [local.owner]
  signer_role = var.config.role
  sender_independent = true
}
resource "contract" "holder" {
  artifact = "Holder.json"
  salt = derive("holder")
  args = [contracts.registry.address]
}
resource "call" "initialize" {
  target = contracts.registry
  method = "setBinding"
  args = [var.config.nested.owner]
}
resource "check" "binding" {
  target = calls.initialize
  getter = "binding"
  before = "${OTHER}"
  equals = var.config.nested.owner
}
resource "check" "upstream" {
  target = contracts.holder
  UPSTREAM = contracts.registry.address
}`;
const values = `config = {
  mixer = "records/example"
  generation = 0
  role = "deployer"
  nested = { owner = "${OWNER}" }
  unused = 10
}`;

test('record reads preserve resolved contracts, calls, checks, salts, addresses and dependency edges', () => {
  const record = compile(`${declarations}\n${body}`, values);
  const flatBody = body
    .replaceAll('var.config.nested.owner', 'var.owner')
    .replaceAll('var.config.mixer', 'var.mixer')
    .replaceAll('var.config.generation', 'var.generation')
    .replaceAll('var.config.role', 'var.role');
  const flat = compile(
    `variable "owner" {}\nvariable "mixer" {}\nvariable "generation" {}\nvariable "role" {}\n${flatBody}`,
    `owner = "${OWNER}"\nmixer = "records/example"\ngeneration = 0\nrole = "deployer"`,
  );
  assert.deepEqual(prepared(record), prepared(flat));
  assert.deepEqual(
    dependencyGraphs(graph(parseSpec(record))),
    dependencyGraphs(graph(parseSpec(flat))),
  );
  assert.deepEqual(record.values, {});
  assert.equal(record.contracts.find((item) => item.id === 'registry').args[0], OWNER);
  assert.equal(
    hashJson(record),
    hashJson(compile(`${declarations}\n${body}`, values.replace('unused = 10', 'unused = 20'))),
  );
});

test('null record paths omit optional attributes and resources without changing surviving identity', () => {
  const source = `${declarations}
chain_id = 31337
mixer = "records/null"
resource "contract" "optional" {
  enabled = var.config.nested != null
  artifact = "Holder.json"
  salt = derive("optional")
  args = [var.config.nested.owner]
}
resource "contract" "stable" {
  artifact = "Holder.json"
  salt = derive("stable")
  address = var.config.nested.owner
  args = ["${OWNER}"]
}`;
  const full = compile(source, `config = { nested = { owner = "${OTHER}" } }`);
  for (const value of ['null', '{ nested = null }']) {
    const empty = compile(source, `config = ${value}`);
    assert.equal(empty.contracts.length, 1);
    assert.equal(empty.contracts[0].id, 'stable');
    assert.equal(empty.contracts[0].salt, full.contracts.find((item) => item.id === 'stable').salt);
    assert.equal(Object.hasOwn(empty.contracts[0], 'address'), false);
  }
});

test('missing fields and traversal through non-records report the complete path', () => {
  const source = `${declarations}\nchain_id = 1\nresource "contract" "x" {\n artifact = "Holder.json"\n args = [var.config.nested.owner]\n}`;
  assert.throws(
    () => compile(source, 'config = { nested = { rate = 1, caps = [] } }'),
    /var\.config\.nested\.owner.*(?:caps.*rate|rate.*caps)/,
  );
  for (const value of ['"x"', '1', 'true', '[]']) {
    assert.throws(
      () => compile(source, `config = { nested = ${value} }`),
      /var\.config\.nested\.owner.*(?:record|object)/,
    );
  }
  assert.throws(
    () => compile(`${declarations}\nchain_id = 1`, 'config = {}'),
    /Unused variables: config/,
  );
});

test('child record reads equal separate inputs in value and constant fields', async (t) => {
  const child = `variable "config" {}
mixer = var.config.mixer
resource "contract" "holder" {
  artifact = "Holder.json"
  salt = derive
  args = [var.config.owner]
}
output "owner" { value = var.config.owner }`;
  const project = await moduleProject(t, {
    'main.ethp': `chain_id = 31337\n${declarations}\nmodule "child" {\n source = "./child"\n config = var.config\n}`,
    'main.ethpvars': `config = { mixer = "records/child", owner = "${OWNER}" }`,
    'child/main.ethp': child,
  });
  const record = await project.compile();
  await project.write(
    'main.ethp',
    `chain_id = 31337\nmodule "child" {\n source = "./child"\n mixer = "records/child"\n owner = "${OWNER}"\n}`,
  );
  await project.write('main.ethpvars', '');
  await project.write(
    'child/main.ethp',
    child
      .replace('variable "config" {}', 'variable "mixer" {}\nvariable "owner" {}')
      .replaceAll('var.config.mixer', 'var.mixer')
      .replaceAll('var.config.owner', 'var.owner'),
  );
  assert.deepEqual(prepared(record), prepared(await project.compile()));
  assert.equal(record.modules.instances[0].outputs.owner.value, OWNER);
});

test('saved-plan apply identity rejects a changed read field before any chain access', async () => {
  const original = compile(`${declarations}\n${body}`, values);
  const plan = await createPlan({
    spec: original,
    artifacts: artifactsFor(original),
    client: planningClient(),
  });
  await acceptPlan(plan, original);
  const changed = compile(`${declarations}\n${body}`, values.replace(OWNER, OTHER));
  assert.notEqual(hashJson(parseSpec(original)), hashJson(parseSpec(changed)));
  await assert.rejects(
    acceptPlan(plan, changed, {
      getChainId() {
        assert.fail('stale specs must fail before RPC');
      },
    }),
    (error) => error.code === 'stale-spec',
  );
});

test('record fields cannot bypass signer-secret names in defaults, files, nested records or lists', () => {
  for (const value of [
    '{ private_key = "redacted" }',
    '{ nested = { mnemonic = "redacted" } }',
    '{ nested = [{ seed_phrase = "redacted" }] }',
  ]) {
    const source =
      'chain_id = 1\nvariable "config" { DEFAULT }\nresource "contract" "x" {\n artifact = "Holder.json"\n args = [var.config]\n}';
    assert.throws(
      () => compile(source.replace('DEFAULT', `default = ${value}`)),
      /forbidden signer secret/,
    );
    assert.throws(
      () => compile(source.replace('DEFAULT', ''), `config = ${value}`),
      /forbidden signer secret/,
    );
  }
});

test('record field reads cannot inject symbolic resource references from literal records', () => {
  const source = `${declarations}
chain_id = 1
resource "contract" "x" {
  artifact = "Holder.json"
  args = [var.config.owner]
}`;
  for (const value of [
    '{ owner = { ref = "contracts.x.address" } }',
    `{ owner = "${OWNER}", unused = [{ ref = "contracts.x.address" }] }`,
  ])
    assert.throws(
      () => compile(source, `config = ${value}`),
      /constant record.*resource references/,
    );
});
