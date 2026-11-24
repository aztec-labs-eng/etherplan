import { encodeErrorResult } from 'viem';
import { abiArguments } from './values.ts';
import type { Abi, Hex, JsonValue } from '../types.ts';

export function expectedRevert(
  abi: Abi | undefined,
  expected: { error: string; args: JsonValue[] },
  label: string,
): Hex {
  const errors = abi?.filter((item) => item.type === 'error' && item.name === expected.error);
  if (errors?.length !== 1)
    throw new Error(`${label} needs one ABI error named ${expected.error}.`);
  const error = errors[0]!;
  if (error.type !== 'error') throw new Error(`${label} needs an ABI error.`);
  return encodeErrorResult({
    abi: [error],
    errorName: error.name,
    args: abiArguments(error.inputs, expected.args, `${label} revert argument`),
  }).toLowerCase() as Hex;
}

export function revertData(error: unknown): Hex | undefined {
  const seen = new Set<object>();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const current = error as { name?: unknown; raw?: unknown; cause?: unknown };
    if (
      current.name === 'ContractFunctionRevertedError' &&
      typeof current.raw === 'string' &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(current.raw)
    )
      return current.raw.toLowerCase() as Hex;
    error = current.cause;
  }
  return undefined;
}
