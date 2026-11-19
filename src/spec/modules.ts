import type { JsonValue, ResourceId } from '../types.ts';

export interface ModuleBinding {
  value: JsonValue;
  after: ResourceId[];
}

export type ModulePath = (string | { key: string })[];
export const MODULE_KEY = /^[a-z0-9]{1,12}$/;

export function modulePath(path: ModulePath): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === 'string'
        ? `${text}${text ? '.' : ''}${part}`
        : `${text}[${JSON.stringify(part.key)}]`,
    '',
  );
}

export interface ModuleInstance {
  path: ModulePath;
  resources: Record<string, Record<string, ResourceId>>;
  inputs: Record<string, ModuleBinding>;
  outputs: Record<string, ModuleBinding>;
}

export interface ProjectModules {
  version: 1 | 2;
  instances: ModuleInstance[];
}

/** Human labels are presentation only; state and saved-plan identities always use the original ID. */
export function moduleResourceLabel(modules: ProjectModules | undefined, id: ResourceId): string {
  for (const instance of modules?.instances ?? []) {
    if (!instance.path.some((part) => typeof part !== 'string')) continue;
    for (const [kind, names] of Object.entries(instance.resources))
      for (const [name, resource] of Object.entries(names))
        if (resource === id) return `${kind}:module.${modulePath(instance.path)}.${name}`;
  }
  return id;
}

export function validateModules(value: unknown): asserts value is ProjectModules {
  const object = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  const assert: (ok: unknown, message: string) => asserts ok = (ok, message) => {
    if (!ok) throw new Error(`Spec modules: ${message}`);
  };
  assert(
    object(value) && (value.version === 1 || value.version === 2) && Array.isArray(value.instances),
    'expected version 1 or 2 and instances[].',
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
        item.path.every((part, index, parts) =>
          typeof part === 'string'
            ? /^[a-z][a-zA-Z0-9_]*$/.test(part)
            : value.version === 2 &&
              index > 0 &&
              typeof parts[index - 1] === 'string' &&
              object(part) &&
              Object.keys(part).length === 1 &&
              typeof part.key === 'string' &&
              MODULE_KEY.test(part.key),
        ),
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
