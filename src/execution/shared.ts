import type { ScheduleEntry } from '../scheduling/types.ts';
import type { PlannedResource, PlannedTransaction, PreparedResource } from '../planning/types.ts';
import type { ApplyContext, PreparedAction, SignerAccount } from './types.ts';
import { ApplyError } from './errors.ts';

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` for each item in order, at most `limit` at a time. After one rejects, it starts no
 * other item, and it returns only when each started item has settled. An item that did not start
 * has no result, and the earliest failed item is always the first entry that is not fulfilled.
 */
export async function settleBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) };
      } catch (reason) {
        failed = true;
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Finds the earliest failure in the results of settleBounded. */
export const isRejected = (
  result: PromiseSettledResult<unknown> | undefined,
): result is PromiseRejectedResult => result?.status === 'rejected';

export function transactionFor(item: PreparedAction): PlannedTransaction {
  const transaction = item.planned.tx;
  if (!transaction)
    throw new ApplyError('plan-format', `Action ${item.planned.id} has no planned transaction.`, {
      actionId: item.planned.id,
    });
  return transaction;
}

export function roleOf(resource: PlannedResource | PreparedResource): string {
  return (
    ('signerRole' in resource ? resource.signerRole : null) ??
    (resource.kind === 'call' ? 'owner' : 'deployer')
  );
}

// Keep the signing service role distinct even when two roles share one address and nonce lane.
export function signerFor(
  ctx: Pick<ApplyContext, 'lanes'>,
  entry: ScheduleEntry,
): SignerAccount | undefined {
  if (entry.signerRole === 'deployer')
    return ctx.lanes.pool.find((account) => account.address.toLowerCase() === entry.signer);
  if (entry.signerRole === 'owner') return ctx.lanes.owner ?? undefined;
  return Object.hasOwn(ctx.lanes.named, entry.signerRole)
    ? ctx.lanes.named[entry.signerRole]
    : undefined;
}
