import type { ScheduleEntry } from '../scheduling/types.ts';
import type { PlannedResource, PlannedTransaction, PreparedResource } from '../planning/types.ts';
import type { ApplyContext, PreparedAction, SignerAccount } from './types.ts';
import { ApplyError } from './errors.ts';

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
