import { hashJson } from '../identity.ts';
import { validateState } from '../state/index.ts';
import type { StateFile } from '../state/types.ts';
import type { Address, Hash } from '../types.ts';
import { acquireLeases, readStoredJournal, scopeKey } from './backends.ts';
import { liveTransactions } from './journal.ts';
import type {
  DeploymentScope,
  JournalRecord,
  JournalStore,
  LockProvider,
  PlanStore,
  StateStore,
} from './types.ts';

export interface BackendCopySource {
  stateStore: StateStore;
  journalStore: JournalStore;
  planStore?: PlanStore | null;
}

export interface BackendCopyTarget extends BackendCopySource {
  lockProvider: LockProvider;
}

export interface BackendCopyInput {
  source: BackendCopySource;
  target: BackendCopyTarget;
  sourceScope: DeploymentScope;
  /** Defaults to the source scope. It must name the same chain. */
  targetScope?: DeploymentScope;
  /** Copy only these state resources; the whole journal is always copied, because its hash chain cannot be cut. */
  resources?: string[];
  principal?: string;
  ttlMs?: number;
}

export interface BackendCopyReport {
  sourceScope: string;
  targetScope: string;
  records: number;
  resumedAt: number;
  signedRecords: number;
  signers: string[];
  resources: string[];
  stateHash: Hash;
  journalHead: { sequence: number; recordHash: Hash } | null;
  plansCopied: number;
  plansMissing: Hash[];
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hash;

/**
 * Copies one settled deployment scope into another backend: its state, every journal record unchanged with the
 * journal head and signer index, and the saved plans the journal names. Signed bytes stay sealed by the source
 * backend's key; apply never decrypts a settled signature, so the target needs no access to that key. The source is
 * only read. The target scope must be empty, or hold an exact prefix of the source journal from an interrupted copy.
 */
export async function copyDeploymentScope({
  source,
  target,
  sourceScope,
  targetScope = sourceScope,
  resources,
  principal,
  ttlMs,
}: BackendCopyInput): Promise<BackendCopyReport> {
  if (
    targetScope.chainId !== sourceScope.chainId ||
    targetScope.genesisHash.toLowerCase() !== sourceScope.genesisHash.toLowerCase()
  )
    throw new Error('A backend copy keeps the chain; the target scope names another chain.');
  const records = await readStoredJournal(source.journalStore, sourceScope);
  const live = liveTransactions(records as unknown as JournalRecord[]);
  if (live.length > 0)
    throw new Error(
      `The source scope has unresolved transactions; settle them with apply in the source backend first: ${live
        .map(
          ({ latest, signed }) => `${latest.actionId} ${signed.transactionHash} (${latest.phase})`,
        )
        .join(', ')}.`,
    );
  const stored = await source.stateStore.read(sourceScope);
  if (!stored) throw new Error('The source scope has no state.');
  const state = validateState(stored.value);
  let copied: StateFile = state;
  if (resources) {
    const missing = resources.filter((id) => !Object.hasOwn(state.resources, id));
    if (missing.length > 0) throw new Error(`The source state has no ${missing.join(', ')}.`);
    copied = {
      ...state,
      resources: Object.fromEntries(
        Object.entries(state.resources).filter(([id]) => resources.includes(id)),
      ),
    } as StateFile;
  }
  if (await target.stateStore.read(targetScope))
    throw new Error('The target scope already has state; a copy writes only into an empty scope.');
  const existing = await readStoredJournal(target.journalStore, targetScope);
  if (
    existing.length > records.length ||
    existing.some((record, index) => record.recordHash !== records[index]!.recordHash)
  )
    throw new Error('The target journal is not a prefix of the source journal.');
  const signed = records.filter((record) => record.phase === 'signed');
  const signers = [...new Set(signed.map((record) => record.signer.toLowerCase()))] as Address[];
  // The signer index has one row per transaction. A hand-repaired journal can sign one transaction under two actions;
  // only the first record indexes it, as it did in the source.
  const indexing = new Set<number>();
  const indexed = new Set<string>();
  for (const record of signed) {
    const key = `${record.signer.toLowerCase()}/${record.transactionHash.toLowerCase()}`;
    if (indexed.has(key)) continue;
    indexed.add(key);
    indexing.add(record.sequence);
  }
  // Every write is fenced by a deployment and a signer lease; a scope that never signed takes the zero address.
  const leases = await acquireLeases({
    lockProvider: target.lockProvider,
    scope: targetScope,
    addresses: signers.length > 0 ? signers : [ZERO_ADDRESS],
    planHash: (state.lastPlanHash ?? ZERO_HASH) as Hash,
    ...(principal ? { principal } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  });
  try {
    for (const record of records.slice(existing.length)) {
      await leases.assertHeld();
      await target.journalStore.append(targetScope, record, {
        expectedSequence: record.sequence,
        expectedPreviousHash: record.previousHash,
        fence: leases.fence,
        indexSigner: indexing.has(record.sequence),
      });
    }
    await leases.assertHeld();
    await target.stateStore.compareAndSwap(targetScope, null, copied, { fence: leases.fence });
  } finally {
    await leases.release();
  }
  let plansCopied = 0;
  const plansMissing: Hash[] = [];
  if (source.planStore && target.planStore) {
    const hashes = new Set<Hash>(records.map((record) => record.planHash));
    if (state.lastPlanHash) hashes.add(state.lastPlanHash as Hash);
    for (const planHash of hashes) {
      let plan;
      try {
        plan = await source.planStore.read(sourceScope, planHash);
      } catch (error) {
        if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
        plansMissing.push(planHash);
        continue;
      }
      await target.planStore.put(targetScope, plan);
      plansCopied++;
    }
  }
  const after = await source.stateStore.read(sourceScope);
  const sourceHead = source.journalStore.head ? await source.journalStore.head(sourceScope) : null;
  const last = records.at(-1);
  if (
    after?.version !== stored.version ||
    (source.journalStore.head && (sourceHead?.recordHash ?? null) !== (last?.recordHash ?? null))
  )
    throw new Error('The source scope changed during the copy; freeze its deploys and copy again.');
  const written = await readStoredJournal(target.journalStore, targetScope);
  const writtenState = await target.stateStore.read(targetScope);
  if (
    written.length !== records.length ||
    (written.at(-1)?.recordHash ?? null) !== (last?.recordHash ?? null) ||
    !writtenState ||
    hashJson(writtenState.value) !== hashJson(copied)
  )
    throw new Error('The target scope does not read back as copied.');
  return {
    sourceScope: scopeKey(sourceScope),
    targetScope: scopeKey(targetScope),
    records: records.length,
    resumedAt: existing.length,
    signedRecords: signed.length,
    signers,
    resources: Object.keys(copied.resources),
    stateHash: hashJson(copied),
    journalHead: last ? { sequence: last.sequence, recordHash: last.recordHash } : null,
    plansCopied,
    plansMissing,
  };
}
