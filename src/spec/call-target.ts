import type { ContractId, ExternalId } from '../types.ts';

export function callTarget(value: string): {
  id: ContractId | ExternalId;
  name: string;
  getter?: string;
} {
  const external = /^external:([a-z][a-zA-Z0-9_]*)$/.exec(value);
  if (external) return { id: `external:${external[1]!}`, name: external[1]! };
  const contract = /^([a-z][a-zA-Z0-9_]*)(?:\.created\.([a-zA-Z_][a-zA-Z0-9_]*))?$/.exec(value);
  if (!contract) throw new Error(`Invalid call target ${value}.`);
  return {
    id: `contract:${contract[1]!}`,
    name: contract[1]!,
    ...(contract[2] ? { getter: contract[2] } : {}),
  };
}
