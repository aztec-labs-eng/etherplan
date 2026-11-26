import type { Client } from '../types.ts';

const SHARED_METHODS: ReadonlySet<PropertyKey> = new Set(['getCode', 'readContract', 'getBlock']);
const sources = new WeakMap<Client, Client>();

/** The client that shareReads wrapped, or the client itself. Evidence that belongs to a provider names this client. */
export function readSource(client: Client): Client {
  return sources.get(client) ?? client;
}

/**
 * A view of a client for one verification boundary. Code, getter and block reads that name a block
 * number share one request when their arguments are equal, so the key of a read is the client, the
 * method, the complete arguments and the block. A failed read is not kept, so a retry asks the
 * provider again. A read without a block number, and each other method, goes to the client unchanged.
 */
export function shareReads(client: Client): Client {
  const reads = new Map<string, Promise<unknown>>();
  const view = new Proxy(client, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (!SHARED_METHODS.has(property)) return member.bind(target) as unknown;
      return (args?: { blockNumber?: unknown }): unknown => {
        if (typeof args?.blockNumber !== 'bigint') return member.call(target, args) as unknown;
        const key = `${String(property)}:${JSON.stringify(args, (_name, value: unknown) =>
          typeof value === 'bigint' ? `${value}n` : value,
        )}`;
        const known = reads.get(key);
        if (known) return known;
        const read = Promise.resolve(member.call(target, args) as unknown);
        reads.set(key, read);
        read.catch(() => reads.delete(key));
        return read;
      };
    },
  });
  sources.set(view, client);
  return view;
}
