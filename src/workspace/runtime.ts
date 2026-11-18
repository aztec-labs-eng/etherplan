import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { hashJson } from '../identity.ts';
import { validateState, writeStateAtomic } from '../state/index.ts';
import { acquireLock, canonicalLocalFile, localJournalLockFile } from '../execution/lock.ts';
import { acquireLocalSignerLocks, registerLocalSignerJournal } from '../execution/local-signer.ts';
import { openJournal } from '../execution/journal.ts';
import { deploymentScope, acquireLeases, openStoredJournal } from '../execution/backends.ts';
import { ApplyError } from '../execution/errors.ts';
import { combinedState, localId, unitState, workspaceId } from './index.ts';
import type { ApplyRuntime } from '../execution/context.ts';
import type { Address } from '../types.ts';
import type { Plan } from '../planning/types.ts';
import type { ApplyInput, Journal, JournalRecord, LocalLock, Lock } from '../execution/types.ts';
import type { WorkspaceUnit } from './types.ts';

export async function workspaceRuntime(
  units: WorkspaceUnit[],
  plan: Plan,
  addresses: Address[],
  options: Pick<ApplyInput, 'ttlMs' | 'principal'>,
): Promise<ApplyRuntime> {
  const journals = new Map<string, Journal>();
  let lock: Lock | undefined;
  const local: LocalLock[] = [];
  try {
    const first = units[0]!.backend;
    if (first) {
      lock = await acquireLeases({
        lockProvider: first.lockProvider,
        scope: first.scope,
        additionalScopes: units.slice(1).map((unit) => unit.backend!.scope),
        addresses,
        planHash: plan.planHash,
        ...options,
      });
    } else {
      const files = await Promise.all(
        units.flatMap((unit) => [unit.stateFile!, unit.journalFile!]).map(canonicalLocalFile),
      );
      if (new Set(files).size !== files.length)
        throw new Error('Workspace unit paths alias the same file.');
      for (const file of [...new Set(files.map((file) => `${file}.lock`))].sort())
        local.push(await acquireLock(file, { planHash: plan.planHash }));
      local.push(...(await acquireLocalSignerLocks(plan.chain, addresses, null, plan.planHash)));
      lock = {
        ...local[0]!,
        async assertHeld() {
          for (const held of local) await held.assertHeld();
        },
        async release() {
          for (const held of [...local].reverse()) await held.release();
        },
      };
      for (const unit of units)
        await registerLocalSignerJournal(plan.chain, addresses, unit.journalFile!);
    }
    const held = lock;
    for (const unit of units) {
      if (unit.backend)
        journals.set(
          unit.key,
          await openStoredJournal({
            ...unit.backend,
            fence: 'fence' in held ? held.fence : null,
            assertHeld: () => held.assertHeld(),
          }),
        );
      else {
        const file = await localJournalLockFile(unit.journalFile!);
        const writerLock = local.find((item) => item.file === file);
        if (!writerLock) throw new Error('Unit journal lock is missing.');
        journals.set(unit.key, await openJournal(unit.journalFile!, { writerLock }));
      }
      // A workspace plan must be recoverable from every durable unit journal.
      if (unit.backend?.planStore) await unit.backend.planStore.put(unit.backend.scope, plan);
      else if (!unit.backend) {
        const directory = path.join(path.dirname(unit.stateFile!), 'plans');
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${plan.planHash}.json`), JSON.stringify(plan), {
          mode: 0o600,
        });
      }
    }
    const history = units.flatMap((unit) =>
      journals
        .get(unit.key)!
        .records.map((record) => ({ ...record, actionId: workspaceId(unit.key, record.actionId) })),
    );
    const older = history.filter((row) => row.planHash !== plan.planHash);
    const active = history
      .filter((row) => row.planHash === plan.planHash)
      .sort((a, b) => (a.workspaceSequence ?? 0) - (b.workspaceSequence ?? 0));
    if (
      active.some(
        (row, index) =>
          !Number.isSafeInteger(row.workspaceSequence) || row.workspaceSequence !== index + 1,
      )
    )
      throw new Error('Workspace journal sequence is incomplete or duplicated.');
    const records = [...older, ...active].map((row, index) => ({ ...row, sequence: index + 1 }));
    let next = active.length;
    let queue: Promise<unknown> = Promise.resolve();
    let appendFailure: unknown;
    const journal: Journal = {
      file: null,
      tornTail: [...journals.values()].find((value) => value.tornTail)?.tornTail ?? null,
      records,
      forAction(planHash, actionId) {
        return records.filter((row) => row.planHash === planHash && row.actionId === actionId);
      },
      append(fields) {
        const task = queue.then(async () => {
          if (appendFailure) throw appendFailure;
          try {
            const unit = units.find((value) =>
              fields.actionId.startsWith(`${fields.actionId.split(':')[0]}:${value.key}__`),
            );
            if (!unit) throw new Error(`Unknown workspace action ${fields.actionId}.`);
            const stored = await journals.get(unit.key)!.append({
              ...fields,
              actionId: localId(unit.key, fields.actionId),
              workspaceSequence: next + 1,
            });
            next++;
            const record = {
              ...stored,
              actionId: fields.actionId,
              sequence: records.length + 1,
            } as JournalRecord;
            records.push(record);
            return record;
          } catch (error) {
            appendFailure = error;
            throw error;
          }
        });
        queue = task.catch(() => {});
        return task;
      },
      async close() {
        await queue;
        const results = await Promise.allSettled(
          [...journals.values()].map((value) => value.close()),
        );
        const failure = results.find((row) => row.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      },
    };
    const readState: ApplyRuntime['readState'] = async () => {
      const snapshots = await Promise.all(units.map(unitState));
      let resumed = false;
      for (const [index, snapshot] of snapshots.entries()) {
        const backend = units[index]!.backend;
        if (backend) deploymentScope(backend.scope, plan.chain);
        if (
          snapshot.value &&
          (snapshot.value.chain.id !== plan.chain.id ||
            snapshot.value.chain.genesisHash.toLowerCase() !== plan.chain.genesisHash.toLowerCase())
        )
          throw new ApplyError('wrong-chain', 'Unit state belongs to another chain.');
        if (hashJson(snapshot.value) !== plan.workspace!.units[index]!.stateHash) {
          if (snapshot.value?.lastPlanHash !== plan.planHash)
            throw new ApplyError(
              'stale-state',
              `Unit ${units[index]!.key} state changed after planning.`,
            );
          resumed = true;
        }
      }
      return {
        version: snapshots.map((row) => row.version),
        value: combinedState(
          units,
          snapshots.map((row) => row.value),
          plan.chain,
          resumed ? plan.planHash : undefined,
        ),
      };
    };
    // Validate state under all locks before returning control to the executor.
    await readState();
    return {
      lock: held,
      journal,
      readState,
      ...(first
        ? { ownedScopes: units.map((unit) => unit.backend!.scope) }
        : {
            ownedJournalFiles: await Promise.all(
              units.map((unit) => canonicalLocalFile(unit.journalFile!)),
            ),
          }),
      async writeState(version, state) {
        const versions = version as unknown[];
        for (const [index, unit] of units.entries()) {
          await held.assertHeld();
          const localState = validateState({
            formatVersion: 1,
            chain: plan.chain,
            lastPlanHash: plan.planHash,
            resources: Object.fromEntries(
              Object.entries(state.resources)
                .filter(([id]) => id.startsWith(`${id.split(':')[0]}:${unit.key}__`))
                .map(([id, value]) => [
                  localId(unit.key, id as Parameters<typeof localId>[1]),
                  value,
                ]),
            ),
          });
          if (unit.backend)
            await unit.backend.stateStore.compareAndSwap(
              unit.backend.scope,
              versions[index],
              localState,
              { fence: 'fence' in held ? held.fence : null },
            );
          else await writeStateAtomic(unit.stateFile!, localState);
        }
        return null;
      },
    };
  } catch (error) {
    await Promise.allSettled([...journals.values()].map((journal) => journal.close()));
    if (lock) await lock.release();
    else for (const held of local.reverse()) await held.release();
    throw error;
  }
}
