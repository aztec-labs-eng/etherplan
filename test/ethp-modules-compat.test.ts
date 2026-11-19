import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashJson } from '../src/identity.ts';
import { compileSpecFile } from '../src/input/project.ts';
import { createPlan } from '../src/planning/index.ts';
import { parseSpec } from '../src/spec/index.ts';
import { validateState } from '../src/state/index.ts';
import { normalizedArtifact } from './interface-fixtures.ts';
import { acceptPlan, artifactsFor, planningClient, prepared } from './module-fixtures.ts';

const directory = new URL('./fixtures/modules-v1/', import.meta.url);
const baseline = JSON.parse(await readFile(new URL('baseline.json', directory), 'utf8'));

test('an existing nested module root retains the exact rc.1 spec, IDs, hash and module format', async () => {
  const spec = await compileSpecFile(fileURLToPath(new URL('main.ethp', directory)));
  assert.equal(canonicalJson(spec), canonicalJson(baseline.spec));
  assert.equal(hashJson(parseSpec(spec)), baseline.plan.specHash);
  assert.equal(spec.modules.version, 1);
  assert.deepEqual(
    spec.contracts.map((item) => item.id),
    ['consumer', 'module1_5_outer_token', 'module2_5_outer_6_nested_token'],
  );
});

test('rc.1 module state reuses every contract and its saved plan passes apply identity unchanged', async () => {
  const spec = await compileSpecFile(fileURLToPath(new URL('main.ethp', directory)));
  const resources = prepared(spec).resources;
  const code = new Map(
    resources.map((item) => [
      item.address.toLowerCase(),
      normalizedArtifact.deployedBytecode.object,
    ]),
  );
  const client = planningClient({ code });
  const plan = await createPlan({
    spec,
    artifacts: artifactsFor(spec),
    client,
    state: validateState(baseline.state),
  });
  assert.deepEqual(
    plan.resources.map((item) => item.action),
    ['reuse', 'reuse', 'reuse'],
  );
  assert.equal((await acceptPlan(baseline.plan, spec, client)).size, 3);
});
