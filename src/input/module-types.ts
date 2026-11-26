import type { JsonValue } from '../types.ts';
import type { ModuleBinding } from '../spec/modules.ts';
export type { ModuleBinding } from '../spec/modules.ts';
import type { HclExpression, HclReference } from './types.ts';
import type { Evaluator } from './evaluate.ts';

export interface ModuleContext {
  qualify(name: string): string;
  bindings: ReadonlyMap<string, ModuleBinding>;
  inputs: { value: HclExpression; each: boolean }[];
  child: boolean;
  load(evaluator: Evaluator, chainId: number): void;
  hasOutput(module: string, output: string, node: HclReference): boolean;
  output(module: string, output: string, evaluator: Evaluator, node: HclReference): ModuleBinding;
}

export function hasReference(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(hasReference);
  return (
    value !== null &&
    typeof value === 'object' &&
    (typeof value.ref === 'string' || Object.values(value).some(hasReference))
  );
}
