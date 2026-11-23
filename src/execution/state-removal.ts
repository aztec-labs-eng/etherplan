import { zeroAddress } from 'viem';
import { readState, removeResources, validateState, writeStateAtomic } from '../state/index.ts';
import type { StateFile } from '../state/types.ts';
import type { Address } from '../types.ts';
import { acquireLeases, readStoredJournal } from './backends.ts';
import { liveTransactions, readLocalJournal } from './journal.ts';
import { acquireLock, canonicalLocalFile } from './lock.ts';
import type { AwsBackend, DeploymentScope, JournalRecord } from './types.ts';

export interface StateRemovalInput {
  /** The resource IDs to remove, such as contract:registry. */
  ids: string[];
  /** The resource IDs the project declares. Removing one would make the next plan deploy or call it again. */
  declared: ReadonlySet<string>;
}

function removal(
  state: StateFile | null,
  records: JournalRecord[],
  { ids, declared }: StateRemovalInput,
  where: string,
): StateFile {
  if (!state) throw new Error(`${where} has no state.`);
  const kept = ids.filter((id) => declared.has(id));
  if (kept.length)
    throw new Error(
      `The project still declares ${kept.join(', ')}. Remove them from the project first, or the next plan deploys them again.`,
    );
  const live = liveTransactions(records);
  if (live.length)
    throw new Error(
      `Plan ${live[0]!.latest.planHash} has an unresolved transaction for ${live.map(({ latest }) => latest.actionId).join(', ')}. Resume it with apply before changing state.`,
    );
  return removeResources(state, ids);
}

/**
 * Removes resources from a local state file, as Terraform's `state rm` does. It holds the state lock that apply
 * holds, sends nothing and leaves the journal whole.
 */
export async function removeFromLocalState({
  stateFile,
  journalFile,
  ...input
}: StateRemovalInput & { stateFile: string; journalFile: string }): Promise<StateFile> {
  const lock = await acquireLock(`${await canonicalLocalFile(stateFile)}.lock`, { planHash: null });
  try {
    let records: JournalRecord[] = [];
    try {
      records = await readLocalJournal(journalFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const state = removal(await readState(stateFile), records, input, stateFile);
    await lock.assertHeld();
    await writeStateAtomic(stateFile, state);
    return state;
  } finally {
    await lock.release();
  }
}

/**
 * Removes resources from a deployment scope's stored state, as Terraform's `state rm` does. Like apply, it writes
 * under the deployment lease and a lease for each signer of the scope's journal, or the zero address when nothing
 * signed. It sends nothing and leaves the journal whole.
 */
export async function removeFromStoredState({
  backend,
  scope,
  ttlMs,
  ...input
}: StateRemovalInput & {
  backend: Pick<AwsBackend, 'stateStore' | 'journalStore' | 'lockProvider'>;
  scope: DeploymentScope;
  ttlMs?: number;
}): Promise<StateFile> {
  const signers = [
    ...new Set(
      (await readStoredJournal(backend.journalStore, scope)).flatMap((record) =>
        'signer' in record && record.signer ? [record.signer.toLowerCase() as Address] : [],
      ),
    ),
  ];
  const leases = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses: signers.length > 0 ? signers : [zeroAddress],
    planHash: undefined,
    ...(ttlMs ? { ttlMs } : {}),
  });
  try {
    const records = await readStoredJournal(backend.journalStore, scope);
    const stored = await backend.stateStore.read(scope);
    const state = removal(
      stored ? validateState(stored.value) : null,
      records as unknown as JournalRecord[],
      input,
      'The backend scope',
    );
    await leases.assertHeld();
    await backend.stateStore.compareAndSwap(scope, stored!.version, state, { fence: leases.fence });
    return state;
  } finally {
    await leases.release();
  }
}
