import { hashJson } from '../identity.ts';
import type { Plan } from '../planning/types.ts';
import { validateState } from '../state/index.ts';
import type { StateFile } from '../state/types.ts';
import type { Address, Hash } from '../types.ts';
import { acquireLeases, readStoredJournal, scopeKey, validateJournal } from './backends.ts';
import { liveTransactions } from './journal.ts';
import type {
  DeploymentScope,
  JournalRecord,
  JournalStore,
  LockProvider,
  PlanStore,
  StateStore,
  StoredJournalRecord,
} from './types.ts';

/** One deployment scope as `state pull` writes it and `state push` reads it. */
export interface PulledScope {
  format: 'etherplan-scope';
  formatVersion: 1;
  scope: DeploymentScope;
  state: StateFile;
  /** Every journal record as stored. Signed bytes stay sealed by the source backend's key. */
  journal: StoredJournalRecord[];
  /** The saved plans that the journal and the state name. */
  plans: Plan[];
  /** Plans that the journal names and the source plan bucket did not have. */
  plansMissing: Hash[];
}

export interface ScopeSource {
  stateStore: StateStore;
  journalStore: JournalStore;
  planStore?: PlanStore | null;
}

export interface ScopeTarget extends ScopeSource {
  lockProvider: LockProvider;
}

export interface PushDeploymentScopeInput {
  backend: ScopeTarget;
  pulled: PulledScope;
  /** Defaults to the pulled scope. It must name the same chain. */
  scope?: DeploymentScope;
  /** Push only these state resources. The whole journal is always pushed, because its hash chain cannot be cut. */
  resources?: string[];
  principal?: string;
  ttlMs?: number;
}

export interface ScopeSummary {
  scope: string;
  records: number;
  signedRecords: number;
  signers: Address[];
  resources: string[];
  stateHash: Hash;
  journalHead: { sequence: number; recordHash: Hash } | null;
  plans: number;
  plansMissing: Hash[];
}

export interface PushReport extends ScopeSummary {
  pulledScope: string;
  resumedAt: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hash;

function refuseUnresolved(records: StoredJournalRecord[], where: string): void {
  const live = liveTransactions(records as unknown as JournalRecord[]);
  if (live.length > 0)
    throw new Error(
      `${where} has unresolved transactions; settle them with apply in the source backend first: ${live
        .map(
          ({ latest, signed }) => `${latest.actionId} ${signed.transactionHash} (${latest.phase})`,
        )
        .join(', ')}.`,
    );
}

function signersOf(records: StoredJournalRecord[]): Address[] {
  return [
    ...new Set(
      records
        .filter((record) => record.phase === 'signed')
        .map((record) => record.signer.toLowerCase()),
    ),
  ] as Address[];
}

function summarize(
  scope: DeploymentScope,
  state: StateFile,
  journal: StoredJournalRecord[],
  plans: number,
  plansMissing: Hash[],
): ScopeSummary {
  const last = journal.at(-1);
  return {
    scope: scopeKey(scope),
    records: journal.length,
    signedRecords: journal.filter((record) => record.phase === 'signed').length,
    signers: signersOf(journal),
    resources: Object.keys(state.resources),
    stateHash: hashJson(state),
    journalHead: last ? { sequence: last.sequence, recordHash: last.recordHash } : null,
    plans,
    plansMissing,
  };
}

/** What a pulled scope holds, in the shape of a push report. */
export function summarizePulledScope(pulled: PulledScope): ScopeSummary {
  return summarize(
    pulled.scope,
    pulled.state,
    pulled.journal,
    pulled.plans.length,
    pulled.plansMissing,
  );
}

/**
 * Reads one settled deployment scope: its state, every journal record as stored, and the saved plans the journal
 * names. It only reads the backend and never decrypts signed bytes. It refuses a scope with an unresolved transaction
 * and fails when the state or the journal head moves while it reads.
 */
export async function pullDeploymentScope({
  backend,
  scope,
}: {
  backend: ScopeSource;
  scope: DeploymentScope;
}): Promise<PulledScope> {
  const journal = await readStoredJournal(backend.journalStore, scope);
  refuseUnresolved(journal, 'The scope');
  const stored = await backend.stateStore.read(scope);
  if (!stored) throw new Error('The scope has no state.');
  const state = validateState(stored.value);
  const plans: Plan[] = [];
  const plansMissing: Hash[] = [];
  if (backend.planStore) {
    const hashes = new Set<Hash>(journal.map((record) => record.planHash));
    if (state.lastPlanHash) hashes.add(state.lastPlanHash as Hash);
    for (const planHash of hashes) {
      try {
        plans.push(await backend.planStore.read(scope, planHash));
      } catch (error) {
        if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
        plansMissing.push(planHash);
      }
    }
  }
  const after = await backend.stateStore.read(scope);
  const head = backend.journalStore.head ? await backend.journalStore.head(scope) : null;
  if (
    after?.version !== stored.version ||
    (backend.journalStore.head &&
      (head?.recordHash ?? null) !== (journal.at(-1)?.recordHash ?? null))
  )
    throw new Error('The scope changed during the pull; freeze its deploys and pull again.');
  return {
    format: 'etherplan-scope',
    formatVersion: 1,
    scope,
    state,
    journal,
    plans,
    plansMissing,
  };
}

/**
 * Writes a pulled scope into an empty scope of another backend: the saved plans, every journal record unchanged
 * through the normal append, and the state last. A target that holds an exact prefix of the pulled journal is a push
 * that stopped partway, and the push resumes after it. Apply never decrypts a settled signature, so the target needs
 * no access to the source backend's key.
 */
export async function pushDeploymentScope({
  backend,
  pulled,
  scope = pulled.scope,
  resources,
  principal,
  ttlMs,
}: PushDeploymentScopeInput): Promise<PushReport> {
  if (pulled?.format !== 'etherplan-scope' || pulled.formatVersion !== 1)
    throw new Error('The file is not a scope from etherplan state pull, format version 1.');
  if (
    scope.chainId !== pulled.scope.chainId ||
    scope.genesisHash.toLowerCase() !== pulled.scope.genesisHash.toLowerCase()
  )
    throw new Error('A push keeps the chain; the target scope names another chain.');
  const records = pulled.journal;
  validateJournal(records, scope);
  refuseUnresolved(records, 'The pulled scope');
  const state = validateState(pulled.state);
  let pushed: StateFile = state;
  if (resources) {
    const missing = resources.filter((id) => !Object.hasOwn(state.resources, id));
    if (missing.length > 0) throw new Error(`The pulled state has no ${missing.join(', ')}.`);
    pushed = {
      ...state,
      resources: Object.fromEntries(
        Object.entries(state.resources).filter(([id]) => resources.includes(id)),
      ),
    } as StateFile;
  }
  if (pulled.plans.length > 0 && !backend.planStore)
    throw new Error('The target backend has no plan bucket for the pulled saved plans.');
  if (await backend.stateStore.read(scope))
    throw new Error('The target scope already has state; a push writes only into an empty scope.');
  const existing = await readStoredJournal(backend.journalStore, scope);
  if (
    existing.length > records.length ||
    existing.some((record, index) => record.recordHash !== records[index]!.recordHash)
  )
    throw new Error('The target journal is not a prefix of the pulled journal.');
  const signers = signersOf(records);
  // The signer index has one row per transaction. A hand-repaired journal can sign one transaction under two actions;
  // only the first record indexes it, as it did in the source.
  const indexing = new Set<number>();
  const indexed = new Set<string>();
  for (const record of records) {
    if (record.phase !== 'signed') continue;
    const key = `${record.signer.toLowerCase()}/${record.transactionHash.toLowerCase()}`;
    if (indexed.has(key)) continue;
    indexed.add(key);
    indexing.add(record.sequence);
  }
  // Saved plans are keyed by their hash, so writing one again is harmless.
  for (const plan of pulled.plans) await backend.planStore!.put(scope, plan);
  // Every journal and state write is fenced by a deployment lease and a lease per signer; a scope that never signed
  // takes the zero address.
  const leases = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses: signers.length > 0 ? signers : [ZERO_ADDRESS],
    planHash: (state.lastPlanHash ?? ZERO_HASH) as Hash,
    ...(principal ? { principal } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  });
  try {
    for (const record of records.slice(existing.length)) {
      await leases.assertHeld();
      await backend.journalStore.append(scope, record, {
        expectedSequence: record.sequence,
        expectedPreviousHash: record.previousHash,
        fence: leases.fence,
        indexSigner: indexing.has(record.sequence),
      });
    }
    await leases.assertHeld();
    await backend.stateStore.compareAndSwap(scope, null, pushed, { fence: leases.fence });
  } finally {
    await leases.release();
  }
  const written = await readStoredJournal(backend.journalStore, scope);
  const writtenState = await backend.stateStore.read(scope);
  if (
    written.length !== records.length ||
    (written.at(-1)?.recordHash ?? null) !== (records.at(-1)?.recordHash ?? null) ||
    !writtenState ||
    hashJson(writtenState.value) !== hashJson(pushed)
  )
    throw new Error('The target scope does not read back as pushed.');
  return {
    pulledScope: scopeKey(pulled.scope),
    ...summarize(scope, pushed, records, pulled.plans.length, pulled.plansMissing),
    resumedAt: existing.length,
  };
}
