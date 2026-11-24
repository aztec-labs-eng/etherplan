import { jsonSafe } from './preflight.ts';
import { ApplyError } from './errors.ts';
import type { Plan } from '../planning/types.ts';
import type { ResourceId } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';
import type {
  ApplyContext,
  ApplyResult,
  ApplyStep,
  FailedFields,
  FailureCode,
  JournalPhaseFields,
  JournalRecord,
  JournalRecordInput,
  PreparedAction,
  ReportEvent,
  ReportEventType,
  ResourceOutcomeSummary,
  VerificationSummary,
} from './types.ts';

export async function report(
  ctx: ApplyContext,
  type: ReportEventType,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const event = jsonSafe({
    type,
    at: new Date().toISOString(),
    planHash: ctx.plan.planHash,
    chain: ctx.plan.chain,
    scope: ctx.scope,
    principal: ctx.principal,
    ...fields,
  }) as ReportEvent;
  if (typeof ctx.config.reporter === 'function') await ctx.config.reporter(event);
  else await ctx.config.reporter?.emit(event);
}

/**
 * Times one step of the apply. When the step ends, it records the step and its wall time and
 * reports them, also when the step fails. It gives back the result or the error of the step unchanged.
 */
export async function timed<T>(
  ctx: ApplyContext,
  step: ApplyStep,
  work: () => Promise<T>,
  wave?: number,
): Promise<T> {
  const started = Date.now();
  const note = (failed: boolean): Promise<void> => {
    const durationMs = Date.now() - started;
    ctx.steps.push({
      step,
      ...(wave === undefined ? {} : { wave }),
      startedAt: new Date(started).toISOString(),
      ms: durationMs,
      ...(failed ? { failed: true as const } : {}),
    });
    return report(ctx, 'step', { step, wave, durationMs, ...(failed ? { failed } : {}) });
  };
  let result: T;
  try {
    result = await work();
  } catch (error) {
    // The error of the step is the one to report. A reporter failure here must not replace it.
    await note(true).catch(() => {});
    throw error;
  }
  await note(false);
  return result;
}

export function summarizeVerification(verification: VerificationResult): VerificationSummary {
  return jsonSafe({
    status: verification.status,
    ...(verification.bindingState ? { bindingState: verification.bindingState } : {}),
    address: verification.address,
    codeHash: verification.codeHash,
    codeComparison: verification.codeComparison,
    missingProofs: verification.missingProofs,
    reasons: verification.reasons,
    failedProofs: (verification.proofs ?? [])
      .filter((proof) => !proof.matched)
      .map(({ name, method }) => ({ name, method })),
    bindingChecks: (verification.bindingChecks ?? []).map(
      ({ name, functionName, observed, actual, error }) => ({
        name,
        functionName,
        observed,
        actual,
        error,
      }),
    ),
    ...(verification.creationProof
      ? {
          creation: {
            method:
              verification.creationProof.kind === 'create2' &&
              verification.creationProof.method === 'pinned-runtime'
                ? 'pinned-runtime'
                : 'replay',
            parentCodeHash: verification.creationProof.codeHash,
            ...(verification.evidence?.creation?.createdCode
              ? { createdCode: verification.evidence.creation.createdCode }
              : {}),
          },
        }
      : {}),
  });
}

/** The journal input for one record of this apply. */
function recordInput(
  ctx: ApplyContext,
  actionId: ResourceId,
  fields: JournalPhaseFields,
  identity: Pick<Plan, 'planHash' | 'chain'> = ctx.plan,
): JournalRecordInput {
  return {
    ...jsonSafe(fields),
    planHash: identity.planHash,
    chain: identity.chain,
    actionId,
    ...(ctx.remote && ctx.principal ? { principal: ctx.principal } : {}),
  } as unknown as JournalRecordInput;
}

/** Reports a durable record and runs its hook. */
async function announce(ctx: ApplyContext, record: JournalRecord, started: number): Promise<void> {
  // Only `state mv` writes a moved record, so an apply has none to report.
  if (record.phase === 'moved') return;
  await report(ctx, record.phase === 'failed' ? 'terminal-failure' : record.phase, {
    actionId: record.actionId,
    sequence: record.sequence,
    transactionHash: 'transactionHash' in record ? record.transactionHash : undefined,
    signer: 'signer' in record ? record.signer : undefined,
    nonce: 'nonce' in record ? record.nonce : undefined,
    journalAppendLatencyMs: Date.now() - started,
    ...(record.phase === 'broadcast' ? { rebroadcast: record.rebroadcast } : {}),
  });
  await ctx.config.hooks.afterRecord?.(record);
}

export async function append<T extends JournalPhaseFields>(
  ctx: ApplyContext,
  actionId: ResourceId,
  fields: T,
  identity: Pick<Plan, 'planHash' | 'chain'> = ctx.plan,
): Promise<JournalRecord & T> {
  // The stored journal checks every lease when the queued append runs. The local journal checks only its own lock.
  if (!ctx.remote) await ctx.lock.assertHeld?.();
  const started = Date.now();
  const record = await ctx.journal.append(recordInput(ctx, actionId, fields, identity));
  await announce(ctx, record, started);
  return record as JournalRecord & T;
}

/**
 * Starts the work that the append of this record can do ahead of the journal's queue of writes: a
 * stored journal encrypts signed bytes. It resolves when that work ends, and it never rejects.
 */
export async function prepareAppend(
  ctx: ApplyContext,
  actionId: ResourceId,
  fields: JournalPhaseFields,
): Promise<void> {
  await ctx.journal.prepare?.(recordInput(ctx, actionId, fields));
}

/**
 * Appends the records in order and resolves when all of them are durable. A journal with batch
 * writes stores them in few writes and reports each record after its write. Any other journal gets
 * one append for each record.
 */
export async function appendAll<T extends JournalPhaseFields>(
  ctx: ApplyContext,
  entries: { actionId: ResourceId; fields: T }[],
): Promise<(JournalRecord & T)[]> {
  if (!ctx.journal.appendAll) {
    const records: (JournalRecord & T)[] = [];
    for (const { actionId, fields } of entries) records.push(await append(ctx, actionId, fields));
    return records;
  }
  const started = Date.now();
  const records = await ctx.journal.appendAll(
    entries.map(({ actionId, fields }) => recordInput(ctx, actionId, fields)),
  );
  for (const record of records) await announce(ctx, record, started);
  return records as (JournalRecord & T)[];
}

export async function fail(
  ctx: ApplyContext,
  item: PreparedAction,
  code: FailureCode,
  reason: string,
  {
    retryable = false,
    evidence,
    ...fields
  }: Omit<Partial<Omit<FailedFields, 'phase' | 'code' | 'reason'>>, 'evidence'> & {
    evidence?: unknown;
  } = {},
): Promise<never> {
  await append(ctx, item.planned.id, {
    phase: 'failed',
    code,
    reason,
    retryable,
    ...fields,
    ...(evidence === undefined
      ? {}
      : { evidence: jsonSafe(evidence) as import('../types.ts').JsonValue }),
  });
  ctx.outcomes.set(item.planned.id, {
    id: item.planned.id,
    action: item.planned.action,
    outcome: 'failed',
    code,
    reason,
    retryable,
    ...fields,
  });
  throw new ApplyError(code, reason, { actionId: item.planned.id, evidence, retryable });
}

export function summary(
  ctx: ApplyContext,
  status: ApplyResult['status'],
  error?: Error & Partial<ApplyError>,
): ApplyResult {
  const resources: ResourceOutcomeSummary[] = ctx.plan.resources.map((resource) => {
    const outcome = ctx.outcomes.get(resource.id);
    if (!outcome) return { id: resource.id, action: resource.action, outcome: 'pending' };
    if (!('verification' in outcome)) return outcome;
    const { verification, ...rest } = outcome;
    return { ...rest, verification: summarizeVerification(verification) };
  });
  return jsonSafe({
    status,
    planHash: ctx.plan.planHash,
    chain: ctx.plan.chain,
    parallel: ctx.parallel,
    pipeline: ctx.pipeline,
    timings: ctx.timings,
    steps: ctx.steps,
    transactionsSigned: ctx.sent.length,
    transactions: ctx.sent,
    rebroadcasts: ctx.rebroadcasts,
    resources,
    ...(ctx.schedule ? { schedule: ctx.schedule } : {}),
    lockRecovered: ctx.lock.recovered,
    journal: { file: ctx.journal.file, tornTailRemoved: ctx.journal.tornTail !== null },
    state: ctx.state,
    ...(error
      ? {
          stoppedAt: {
            ...(error.code ? { code: error.code } : {}),
            ...(error.actionId ? { actionId: error.actionId } : {}),
            message: error.message,
            ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
          },
        }
      : {}),
  } satisfies ApplyResult);
}
