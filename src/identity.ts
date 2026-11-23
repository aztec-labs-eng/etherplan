import { keccak256, stringToHex } from 'viem';
import type { Hash, JsonSafe, JsonValue } from './types.ts';

export function canonicalJson(value: unknown): string {
  function normalize(item: unknown): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      item &&
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    ) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key): [string, JsonValue] => [key, normalize(record[key])]),
      );
    }
    throw new TypeError(
      'Canonical JSON accepts only finite numbers, strings, booleans, null, arrays, and plain objects.',
    );
  }

  return JSON.stringify(normalize(value));
}

function convert(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string')
    return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, convert(item)]),
    );
  }
  return value;
}

// Makes in-memory values comparable with plan JSON: quantities become decimal strings and hex becomes lowercase.
export function jsonSafe<T>(value: T): JsonSafe<T> {
  return convert(value) as JsonSafe<T>;
}

export function hashJson(value: unknown): Hash {
  return keccak256(stringToHex(canonicalJson(value)));
}
