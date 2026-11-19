import type { JsonValue, ResourceId } from '../types.ts';

export interface ModuleBinding {
  value: JsonValue;
  after: ResourceId[];
}

export interface ModuleInstance {
  path: string[];
  resources: Record<string, Record<string, ResourceId>>;
  inputs: Record<string, ModuleBinding>;
  outputs: Record<string, ModuleBinding>;
}

export interface ProjectModules {
  version: 1;
  instances: ModuleInstance[];
}

export function validateModules(value: unknown): asserts value is ProjectModules {
  const object = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  const assert: (ok: unknown, message: string) => asserts ok = (ok, message) => {
    if (!ok) throw new Error(`Spec modules: ${message}`);
  };
  assert(
    object(value) && value.version === 1 && Array.isArray(value.instances),
    'expected version 1 and instances[].',
  );
  assert(
    Object.keys(value).every((key) => ['version', 'instances'].includes(key)),
    'unknown field.',
  );
  const paths = new Set<string>();
  for (const item of value.instances) {
    assert(
      object(item) &&
        Object.keys(item).every((key) => ['path', 'resources', 'inputs', 'outputs'].includes(key)),
      'invalid instance.',
    );
    assert(
      Array.isArray(item.path) &&
        item.path.length > 0 &&
        item.path.every((part) => typeof part === 'string' && /^[a-z][a-zA-Z0-9_]*$/.test(part)),
      'invalid instance path.',
    );
    const key = JSON.stringify(item.path);
    assert(!paths.has(key), `duplicate instance ${key}.`);
    paths.add(key);
    assert(object(item.resources), 'instance needs resources.');
    for (const [kind, names] of Object.entries(item.resources)) {
      assert(
        ['contract', 'external', 'call'].includes(kind) && object(names),
        'invalid resource map.',
      );
      for (const [name, id] of Object.entries(names))
        assert(
          /^[a-z][a-zA-Z0-9_]*$/.test(name) && typeof id === 'string' && id.startsWith(`${kind}:`),
          'invalid mapped resource.',
        );
    }
    for (const field of ['inputs', 'outputs']) {
      const bindings = item[field];
      assert(object(bindings), `instance needs ${field}.`);
      for (const [name, binding] of Object.entries(bindings)) {
        assert(
          /^[a-z][a-zA-Z0-9_]*$/.test(name) &&
            object(binding) &&
            Object.hasOwn(binding, 'value') &&
            Object.keys(binding).every((key) => ['value', 'after'].includes(key)),
          `invalid ${field} binding ${name}.`,
        );
        assert(
          Array.isArray(binding.after) &&
            binding.after.every(
              (id) =>
                typeof id === 'string' && /^(contract|external|call):[a-z][a-zA-Z0-9_]*$/.test(id),
            ),
          `invalid readiness for ${name}.`,
        );
      }
    }
  }
}
