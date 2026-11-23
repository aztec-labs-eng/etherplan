import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { bytesToHex, hexToBytes } from 'viem';
import { canonicalJson, hashJson } from '../identity.ts';
import { field } from '../json.ts';
import { liveTransactions } from './journal.ts';
import { jsonSafe } from './preflight.ts';
import { classifyLeaseFailure, safeLeaseMessage } from './rpc-error.ts';
import { validateJournalCreationProof } from '../verification/creation-proof.ts';
import type {
  Address,
  ChainIdentity,
  DecimalString,
  DistributiveOmit,
  Hash,
  Hex,
  ResourceId,
} from '../types.ts';
import type {
  AcquireLeasesInput,
  DeploymentLockScope,
  DeploymentScope,
  DeploymentStatus,
  EncryptionContext,
  InspectDeploymentInput,
  Journal,
  JournalRecord,
  JournalStore,
  Lease,
  LeaseFailure,
  LeaseHolder,
  Leases,
  LockScope,
  OpenStoredJournalInput,
  SignerLockScope,
  StoredJournalRecord,
  UnfinishedPlan,
  UnfinishedPlanInput,
} from './types.ts';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SCOPE_PART = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function scopePart(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SCOPE_PART.test(value))
    throw new Error(`Deployment scope needs a safe ${name}.`);
  return value;
}

export function deploymentScope(input: unknown, chain?: ChainIdentity | null): DeploymentScope {
  const project = scopePart(field(input, 'project'), 'project');
  const environment = scopePart(field(input, 'environment'), 'environment');
  const label = scopePart(field(input, 'label'), 'label');
  const chainId = field(input, 'chainId') ?? chain?.id;
  const genesisHash = field(input, 'genesisHash') ?? chain?.genesisHash;
  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId < 1 ||
    typeof genesisHash !== 'string' ||
    !HASH.test(genesisHash)
  )
    throw new Error('Deployment scope needs chain ID and genesis hash.');
  if (
    chain &&
    (chainId !== chain.id || genesisHash.toLowerCase() !== chain.genesisHash.toLowerCase())
  )
    throw new Error('Deployment scope differs from the plan chain.');
  return { project, environment, chainId, genesisHash: genesisHash.toLowerCase() as Hash, label };
}

export function scopeKey(scope: DeploymentScope): string {
  return [scope.project, scope.environment, scope.chainId, scope.genesisHash, scope.label]
    .map(encodeURIComponent)
    .join('/');
}

/** The deployment lease first, then one signer lease per distinct lowercase address. */
export function lockScopes(
  scope: DeploymentScope,
  addresses: Address[],
): [DeploymentLockScope, ...SignerLockScope[]] {
  const chain = { chainId: scope.chainId, genesisHash: scope.genesisHash.toLowerCase() as Hash };
  return [
    {
      ...chain,
      project: scope.project,
      environment: scope.environment,
      kind: 'deployment',
      label: scope.label,
    },
    ...[...new Set(addresses.map((address) => address.toLowerCase() as Address))]
      .sort()
      .map((address): SignerLockScope => ({ ...chain, kind: 'signer', address })),
  ];
}

export function encryptionContext(record: {
  planHash: Hash;
  chain: ChainIdentity;
  actionId: ResourceId;
  signer: Address;
  nonce: DecimalString | number;
}): EncryptionContext {
  return {
    planHash: record.planHash,
    chainId: record.chain.id,
    genesisHash: record.chain.genesisHash.toLowerCase() as Hash,
    actionId: record.actionId,
    signer: record.signer.toLowerCase() as Address,
    nonce: String(record.nonce),
  };
}

function recordHash(record: object): Hash {
  const { recordHash: _current, ...fields } = record as { recordHash?: unknown };
  return hashJson(fields);
}

/** The rules for one record at the position that its predecessor gives it. */
function validateJournalRecord(
  record: StoredJournalRecord,
  scope: DeploymentScope,
  sequence: number,
  previousHash: Hash | null,
): void {
  if (
    record.formatVersion !== 2 ||
    record.sequence !== sequence ||
    record.previousHash !== previousHash ||
    record.recordHash !== recordHash(record)
  )
    throw new Error(`Journal integrity failure at sequence ${sequence}.`);
  if (
    typeof record.planHash !== 'string' ||
    !HASH.test(record.planHash) ||
    typeof record.actionId !== 'string' ||
    typeof record.phase !== 'string' ||
    ![
      'intent',
      'signed',
      'broadcast-attempt',
      'broadcast',
      'receipt',
      'verified',
      'failed',
    ].includes(record.phase)
  )
    throw new Error(`Journal record ${sequence} has invalid identity or phase.`);
  if (
    typeof record.principal !== 'string' ||
    !record.principal ||
    typeof record.at !== 'string' ||
    !Number.isFinite(Date.parse(record.at))
  )
    throw new Error(`Journal record ${sequence} lacks audit metadata.`);
  if (
    record.chain?.id !== scope.chainId ||
    record.chain.genesisHash?.toLowerCase() !== scope.genesisHash
  )
    throw new Error(`Journal chain differs from deployment scope at sequence ${sequence}.`);
  if (Object.hasOwn(record, 'rawTransaction'))
    throw new Error('Journal contains plaintext signed transaction bytes.');
  if (record.phase === 'signed' && !record.encryptedRawTransaction)
    throw new Error(`Signed journal record ${sequence} has no ciphertext.`);
  validateJournalCreationProof(record, `Journal record ${sequence}`);
}

export function validateJournal(records: StoredJournalRecord[], scope: DeploymentScope): void {
  let previousHash: Hash | null = null;
  for (const [index, record] of records.entries()) {
    validateJournalRecord(record, scope, index + 1, previousHash);
    previousHash = record.recordHash;
  }
}

/** Read and validate journal evidence for read-only planning without decrypting signed bytes. */
export async function readStoredJournal(
  journalStore: JournalStore,
  scope: DeploymentScope,
): Promise<StoredJournalRecord[]> {
  const records: StoredJournalRecord[] = [];
  for await (const record of journalStore.read(scope)) records.push(record);
  validateJournal(records, scope);
  if (journalStore.head) {
    const head = await journalStore.head(scope);
    if (
      (head?.sequence ?? 0) !== records.length ||
      (head?.recordHash ?? null) !== (records.at(-1)?.recordHash ?? null)
    ) {
      throw new Error('Journal head differs from its records.');
    }
  }
  return records;
}

/**
 * The saved plan that an interrupted apply left unfinished, or null. A remote apply of another plan stops with
 * `plan-mismatch` while a transaction of this plan is in liveTransactions, so the next runner must apply this plan
 * again. It decrypts no signed bytes: the phase, the plan and the transaction hash of a record are not encrypted.
 */
export async function readUnfinishedPlan({
  scope,
  journalStore,
  planStore,
}: UnfinishedPlanInput): Promise<UnfinishedPlan | null> {
  const records = await readStoredJournal(journalStore, scope);
  const live = liveTransactions(records as unknown as JournalRecord[]);
  const hashes = [...new Set(live.map(({ latest }) => latest.planHash))];
  const [planHash, ...others] = hashes;
  if (planHash === undefined) return null;
  if (others.length)
    throw new Error(
      `Plans ${hashes.join(', ')} each have an unfinished transaction. Resume them one at a time, oldest first.`,
    );
  return {
    planHash,
    plan: await planStore.read(scope, planHash),
    transactions: live.map(({ latest, signed }) => ({
      actionId: latest.actionId,
      phase: latest.phase,
      transactionHash: signed.transactionHash,
      signer: signed.signer,
      nonce: signed.nonce,
    })),
  };
}

export async function openStoredJournal({
  journalStore,
  journalCipher,
  scope,
  fence,
  assertHeld,
}: OpenStoredJournalInput): Promise<Journal> {
  const persisted = await readStoredJournal(journalStore, scope);
  const records: JournalRecord[] = [];
  for (const item of persisted) {
    if (item.phase !== 'signed') {
      records.push(item);
      continue;
    }
    const bytes = await journalCipher.decrypt(
      item.encryptedRawTransaction,
      encryptionContext(item),
    );
    records.push({ ...item, rawTransaction: bytesToHex(bytes) });
  }
  let queue: Promise<unknown> = Promise.resolve();
  // The ciphertexts that `prepare` made, by encryption context and plaintext. One append takes each of them.
  const prepared = new Map<string, Promise<unknown>>();
  const preparedKey = (context: EncryptionContext, raw: Hex) => `${canonicalJson(context)}:${raw}`;
  /** Runs one write at a time, after the leases are checked at the time that it runs. */
  function enqueue<T>(write: () => Promise<T>): Promise<T> {
    const task = queue.then(async () => {
      await assertHeld();
      return write();
    });
    queue = task.catch(() => {});
    return task;
  }
  /** Builds and validates the record that follows `previousHash` at `sequence`. It stores nothing. */
  async function seal(
    fields: Parameters<Journal['append']>[0],
    sequence: number,
    previousHash: Hash | null,
  ): Promise<{ stored: StoredJournalRecord; decoded: JournalRecord }> {
    // The plaintext bytes leave the record before it is hashed and stored; only signed records may carry them.
    const { rawTransaction: raw, ...safe } = jsonSafe(fields) as JsonSafeInput;
    const envelope = {
      formatVersion: 2 as const,
      ...safe,
      sequence,
      previousHash,
      at: new Date().toISOString(),
    };
    if (
      envelope.chain?.id !== scope.chainId ||
      envelope.chain.genesisHash?.toLowerCase() !== scope.genesisHash
    )
      throw new Error('Journal append chain differs from deployment scope.');
    let draft: DistributiveOmit<StoredJournalRecord, 'recordHash'>;
    if (envelope.phase === 'signed') {
      if (typeof raw !== 'string')
        throw new Error('Signed journal record needs raw transaction bytes.');
      const context = encryptionContext(envelope);
      const ready = prepared.get(preparedKey(context, raw));
      prepared.delete(preparedKey(context, raw));
      const encryptedRawTransaction =
        (await ready) ?? (await journalCipher.encrypt(hexToBytes(raw), context));
      draft = { ...envelope, encryptedRawTransaction } as StoredJournalRecord;
    } else {
      if (raw !== undefined)
        throw new Error('Only signed journal records may contain raw transaction bytes.');
      draft = envelope as StoredJournalRecord;
    }
    // This is the runtime check of the shape the casts above claim. The open validated every
    // stored record, so an append validates only the record that it adds.
    const stored = { ...draft, recordHash: recordHash(draft) } as StoredJournalRecord;
    validateJournalRecord(stored, scope, sequence, previousHash);
    const decoded = (
      raw === undefined ? stored : { ...stored, rawTransaction: raw }
    ) as JournalRecord;
    return { stored, decoded };
  }
  /** Advances the journal past records that the store holds. */
  function commit(entries: { stored: StoredJournalRecord; decoded: JournalRecord }[]): void {
    for (const { stored, decoded } of entries) {
      persisted.push(stored);
      records.push(decoded);
    }
  }
  const appendBatch = journalStore.appendBatch?.bind(journalStore);
  return {
    file: null,
    tornTail: null,
    records,
    forAction(planHash, actionId) {
      return records.filter(
        (record) => record.planHash === planHash && record.actionId === actionId,
      );
    },
    append(fields) {
      return enqueue(async () => {
        const entry = await seal(
          fields,
          persisted.length + 1,
          persisted.at(-1)?.recordHash ?? null,
        );
        await journalStore.append(scope, entry.stored, {
          expectedSequence: entry.stored.sequence,
          expectedPreviousHash: entry.stored.previousHash,
          fence,
        });
        commit([entry]);
        return entry.decoded;
      });
    },
    ...(appendBatch && {
      appendAll(run) {
        return enqueue(async () => {
          if (run.some((fields) => fields.phase === 'signed'))
            throw new Error('A batch append takes no signed record.');
          const sealed: Awaited<ReturnType<typeof seal>>[] = [];
          for (const fields of run)
            sealed.push(
              await seal(
                fields,
                persisted.length + sealed.length + 1,
                sealed.at(-1)?.stored.recordHash ?? persisted.at(-1)?.recordHash ?? null,
              ),
            );
          // Each write is atomic, so the journal advances one stored chunk at a time.
          for (let done = 0; done < sealed.length;) {
            const rest = sealed.slice(done);
            const count = await appendBatch(
              scope,
              rest.map((entry) => entry.stored),
              {
                expectedSequence: rest[0]!.stored.sequence,
                expectedPreviousHash: rest[0]!.stored.previousHash,
                fence,
              },
            );
            if (!Number.isSafeInteger(count) || count < 1 || count > rest.length)
              throw new Error('Journal store reported an invalid batch size.');
            commit(rest.slice(0, count));
            done += count;
          }
          return sealed.map((entry) => entry.decoded);
        });
      },
    }),
    prepare(fields) {
      const { rawTransaction: raw, ...safe } = jsonSafe(fields) as JsonSafeInput;
      if (safe.phase !== 'signed' || typeof raw !== 'string') return Promise.resolve();
      const context = encryptionContext(safe);
      const ready = journalCipher.encrypt(hexToBytes(raw), context).catch(() => undefined);
      prepared.set(preparedKey(context, raw), ready);
      return ready.then(() => {});
    },
    async close() {
      await queue;
    },
  };
}

/** A journal append input after jsonSafe: every member may name the plaintext bytes so they can be split off. */
type JsonSafeInput = ReturnType<typeof jsonSafe<Parameters<Journal['append']>[0]>> & {
  rawTransaction?: Hex;
};

export async function acquireLeases({
  lockProvider,
  scope,
  addresses,
  planHash,
  principal,
  ttlMs = 60_000,
  onRenew,
  onRenewFailure,
}: AcquireLeasesInput): Promise<Leases> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3_000)
    throw new Error('Lock ttlMs must be at least 3000.');
  if (principal !== undefined && (typeof principal !== 'string' || principal.length === 0))
    throw new Error('Applying principal must be a nonempty string.');
  const holder: LeaseHolder = {
    id: randomUUID(),
    principal: principal ?? `${os.userInfo().username}@${os.hostname()}`,
    host: os.hostname(),
    pid: process.pid,
    planHash,
    acquiredAt: new Date().toISOString(),
  };
  const acquired: { scope: LockScope; lease: Lease }[] = [];
  // Local view of the lease deadline, measured from when each successful request started.
  let validUntil = Date.now() + ttlMs;
  try {
    for (const lockScope of lockScopes(scope, addresses))
      acquired.push({
        scope: lockScope,
        lease: await lockProvider.acquire(lockScope, holder, ttlMs),
      });
  } catch (error) {
    await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    throw error;
  }
  let lost: LeaseFailure | null = null;
  let closed = false;
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(
    () => {
      renewing = renewing.then(async () => {
        if (closed || lost) return;
        const startedAt = Date.now();
        try {
          for (const { lease } of acquired) await lease.renew();
          validUntil = startedAt + ttlMs;
          await onRenew?.({ holder, scopes: acquired.map(({ scope }) => scope) });
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          const classified = classifyLeaseFailure(cause);
          // Only a rejected lease or a passed deadline ends the writer; transport faults retry.
          const failure: LeaseFailure =
            classified === 'lease-lost'
              ? classified
              : Date.now() >= validUntil
                ? 'lease-expired'
                : classified;
          const fatal = failure === 'lease-lost' || failure === 'lease-expired';
          if (fatal) lost = failure;
          await Promise.resolve()
            .then(() => onRenewFailure?.({ holder, error: cause, failure, fatal }))
            .catch(() => {});
        }
      });
    },
    Math.floor(ttlMs / 3),
  );
  timer.unref?.();
  function assertRenewed(): void {
    if (!lost && Date.now() >= validUntil) lost = 'lease-expired';
    if (lost) throw Object.assign(new Error(safeLeaseMessage(lost)), { code: lost });
  }
  const fence = acquired.map(({ scope: lockScope, lease }) => ({
    scope: lockScope,
    token: lease.fencingToken,
    holderId: holder.id,
    principal: holder.principal,
  }));
  if (fence.some((entry) => !Number.isSafeInteger(entry.token) || entry.token < 1)) {
    clearInterval(timer);
    await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    throw new Error('Lock provider must return positive fencingToken values.');
  }
  return {
    holder,
    fence,
    recovered: null,
    async assertHeld() {
      assertRenewed();
      for (const { lease } of acquired) await lease.assertHeld();
      assertRenewed();
    },
    async release() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await renewing;
      await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    },
  };
}

export async function inspectDeployment({
  scope: input,
  chain,
  planHash,
  journalStore,
  stateStore,
  lockProvider,
}: InspectDeploymentInput): Promise<DeploymentStatus> {
  const scope = deploymentScope(input, chain);
  const records: StoredJournalRecord[] = [];
  for await (const record of journalStore.read(scope)) records.push(record);
  validateJournal(records, scope);
  if (typeof journalStore.head === 'function') {
    const head = await journalStore.head(scope);
    if (
      (head?.sequence ?? 0) !== records.length ||
      (head?.recordHash ?? null) !== (records.at(-1)?.recordHash ?? null)
    )
      throw new Error('Journal head differs from its records.');
  }
  const latest = records.at(-1) ?? null;
  const selected = planHash
    ? (records.filter((record) => record.planHash === planHash).at(-1) ?? null)
    : latest;
  const [state, lock] = await Promise.all([
    stateStore.read(scope),
    lockProvider.inspect?.(lockScopes(scope, [])[0]) ?? null,
  ]);
  const signerAddresses = [
    ...new Set(
      records.flatMap((record) =>
        'signer' in record && record.signer ? [record.signer.toLowerCase() as Address] : [],
      ),
    ),
  ];
  const [, ...signerScopes] = lockScopes(scope, signerAddresses);
  const signerLocks = lockProvider.inspect
    ? await Promise.all(
        signerScopes.map(async (lockScope) => ({
          address: lockScope.address,
          ...(await lockProvider.inspect?.(lockScope)),
        })),
      )
    : [];
  return {
    scope,
    planHash: selected?.planHash ?? planHash ?? null,
    lastJournalPhase: selected?.phase ?? null,
    lastJournalSequence: selected?.sequence ?? null,
    journalHead: latest
      ? { sequence: latest.sequence, planHash: latest.planHash, phase: latest.phase, at: latest.at }
      : null,
    stateVersion: state?.version ?? null,
    stateUpdatedAt: state?.at ?? null,
    lock: lock
      ? {
          holder: lock.holder,
          expiresAt: lock.expiresAt,
          active: lock.active,
          fencingToken: lock.fencingToken,
        }
      : null,
    signerLocks,
  };
}
