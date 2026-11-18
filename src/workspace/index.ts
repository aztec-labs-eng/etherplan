import path from 'node:path';
import { hashJson } from '../identity.ts';
import { graph, parseSpec } from '../spec/index.ts';
import { createPlan, prepareResources } from '../planning/index.ts';
import { readState, validateState } from '../state/index.ts';
import { readLocalJournal } from '../execution/journal.ts';
import { readStoredJournal, deploymentScope, scopeKey } from '../execution/backends.ts';
import { applyWithRuntime } from '../execution/lifecycle.ts';
import { workspaceRuntime } from './runtime.ts';
import type { Artifacts } from '../artifacts/types.ts';
import type { ParsedSpec } from '../spec/types.ts';
import type { StateFile } from '../state/types.ts';
import type { ChainIdentity, ResourceId } from '../types.ts';
import type { RecoveryRecord } from '../recovery.ts';
import type {
  WorkspaceUnit,
  WorkspaceMetadata,
  WorkspaceLink,
  CreateWorkspacePlanInput,
  ApplyWorkspacePlanInput,
} from './types.ts';
export type * from './types.ts';

export function workspaceId(key: string, id: ResourceId): ResourceId {
  return id.replace(':', `:${key}__`) as ResourceId;
}
export function localId(key: string, id: ResourceId): ResourceId {
  const prefix = `${id.split(':')[0]}:${key}__`;
  if (!id.startsWith(prefix)) throw new Error(`Resource ${id} does not belong to unit ${key}.`);
  return `${id.split(':')[0]}:${id.slice(prefix.length)}` as ResourceId;
}
function rewrite(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        name === 'ref' && typeof item === 'string'
          ? item.replace(/^(values|contracts|externals)\./, `$1.${key}__`)
          : rewrite(item, key),
      ]),
    );
  return value;
}
export function composeWorkspace(units: WorkspaceUnit[], links: WorkspaceLink[]) {
  if (!units.length) throw new Error('A workspace plan needs units.');
  const keys = new Set<string>();
  const spec: ParsedSpec = {
    schema: 2,
    chainId: parseSpec(units[0]!.spec).chainId,
    dependencyMode: 'split',
    values: {},
    externals: {},
    contracts: [],
    calls: [],
    executionAssumptions: [],
  };
  const artifacts: Artifacts = new Map();
  for (const unit of units) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(unit.key) || unit.key.includes('__') || keys.has(unit.key))
      throw new Error(`Invalid or duplicate workspace unit ${unit.key}.`);
    keys.add(unit.key);
    const source = parseSpec(structuredClone(unit.spec));
    if (source.chainId !== spec.chainId) throw new Error('Workspace units have different chains.');
    if (source.factory) {
      if (spec.factory && hashJson(spec.factory) !== hashJson(source.factory))
        throw new Error('Workspace units have different CREATE2 factories.');
      spec.factory = source.factory;
    }
    const edges = new Map(graph(source).map((node) => [node.id, node.executionDependencies]));
    const prefix = (id: ResourceId) => workspaceId(unit.key, id);
    for (const [name, value] of Object.entries(source.values))
      spec.values[`${unit.key}__${name}`] = value;
    for (const [name, external] of Object.entries(source.externals))
      spec.externals[`${unit.key}__${name}`] = {
        ...(rewrite(external, unit.key) as typeof external),
        after: edges.get(`external:${name}`)!.map(prefix),
      };
    for (const contract of source.contracts) {
      spec.contracts.push({
        ...(rewrite(contract, unit.key) as typeof contract),
        id: `${unit.key}__${contract.id}`,
        identityId: `contract:${contract.id}`,
        after: edges.get(`contract:${contract.id}`)!.map(prefix),
      });
      const artifact = unit.artifacts.get(contract.id);
      if (!artifact) throw new Error(`Missing artifact for ${unit.key}/${contract.id}.`);
      artifacts.set(`${unit.key}__${contract.id}`, artifact);
    }
    for (const call of source.calls) {
      const target = call.target.startsWith('external:')
        ? call.target.replace('external:', `external:${unit.key}__`)
        : `${unit.key}__${call.target}`;
      spec.calls.push({
        ...(rewrite(call, unit.key) as typeof call),
        id: `${unit.key}__${call.id}`,
        target,
        after: edges.get(`call:${call.id}`)!.map(prefix),
      });
    }
    for (const assumption of source.executionAssumptions ?? [])
      spec.executionAssumptions!.push({
        ...assumption,
        consumer: prefix(assumption.consumer) as typeof assumption.consumer,
        reference: assumption.reference.replace(/^contracts\./, `contracts.${unit.key}__`),
      });
  }
  const parsed = parseSpec(spec);
  const prepared = prepareResources(parsed, graph(parsed), artifacts).resources;
  const resources = new Map(prepared.map((row) => [row.id, row]));
  const pending = new Set<ResourceId>();
  const consumers = new Set<ResourceId>();
  for (const link of links) {
    if (!keys.has(link.consumer.unit) || !keys.has(link.producer.unit))
      throw new Error('Workspace link refers to an unknown unit.');
    const consumerId = workspaceId(link.consumer.unit, link.consumer.resource);
    const producerId = workspaceId(link.producer.unit, link.producer.resource);
    const consumer = resources.get(consumerId),
      producer = resources.get(producerId);
    if (!consumer || !producer || producer.kind === 'external')
      throw new Error('Workspace link has no producer or consumer.');
    const address =
      producer.kind === 'call'
        ? producer.before.absent && producer.after.address
        : producer.address;
    if (!address)
      throw new Error('Workspace producer must deploy a contract or check a created address.');
    if (consumer.kind === 'external') {
      if (
        !consumer.expectedCodeHash ||
        consumers.has(consumerId) ||
        address.toLowerCase() !== consumer.address.toLowerCase()
      )
        throw new Error(`Workspace link address or pin differs for ${consumerId}.`);
      parsed.externals[consumerId.slice('external:'.length)]!.after!.push(producerId);
      consumers.add(consumerId);
      pending.add(consumerId);
    } else {
      const location = link.consumer.location;
      if (!location || !/^(inputs|args|libraries|after)(\.[a-zA-Z0-9_]+)+$/.test(location))
        throw new Error('Workspace literal reference needs its exact input location.');
      let value: unknown = consumer;
      for (const field of location.split('.'))
        value =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)[field]
            : undefined;
      if (typeof value !== 'string' || value.toLowerCase() !== address.toLowerCase())
        throw new Error(`Workspace reference location ${location} differs from its producer.`);
      const item =
        consumer.kind === 'contract'
          ? parsed.contracts.find((row) => `contract:${row.id}` === consumerId)!
          : parsed.calls.find((row) => `call:${row.id}` === consumerId)!;
      item.after!.push(producerId);
    }
  }
  // Validate cross-unit execution cycles before a plan can be saved.
  graph(parsed);
  return { spec: parsed, artifacts, pending };
}
export async function unitState(
  unit: WorkspaceUnit,
): Promise<{ value: StateFile | null; version: unknown }> {
  if (unit.backend) {
    const state = await unit.backend.stateStore.read(unit.backend.scope);
    return { value: state ? validateState(state.value) : null, version: state?.version ?? null };
  }
  if (!unit.stateFile || !unit.journalFile)
    throw new Error(`Unit ${unit.key} needs local paths or a backend.`);
  return { value: await readState(unit.stateFile), version: null };
}
export function combinedState(
  units: WorkspaceUnit[],
  states: (StateFile | null)[],
  chain: ChainIdentity,
  planHash?: StateFile['lastPlanHash'],
): StateFile | null {
  if (states.every((state) => state === null)) return null;
  const resources = Object.fromEntries(
    units.flatMap((unit, index) =>
      Object.entries(states[index]?.resources ?? {}).map(([id, value]) => [
        workspaceId(unit.key, id as ResourceId),
        value,
      ]),
    ),
  ) as StateFile['resources'];
  return { formatVersion: 1, chain, resources, ...(planHash ? { lastPlanHash: planHash } : {}) };
}
async function metadata(
  units: WorkspaceUnit[],
  links: WorkspaceLink[],
): Promise<WorkspaceMetadata> {
  const ids = new Set<string>();
  const rows: WorkspaceMetadata['units'] = [];
  const remote = Boolean(units[0]?.backend);
  for (const unit of units) {
    if (
      unit.backend &&
      (!unit.backend.coordinationId ||
        unit.backend.coordinationId !== units[0]!.backend!.coordinationId)
    )
      throw new Error('Workspace units require one signer coordination store.');
    if (Boolean(unit.backend) !== remote)
      throw new Error('Workspace units must use the same storage mode.');
    if (unit.backend && !unit.backend.identity)
      throw new Error('Workspace backend needs a stable identity.');
    const storage = unit.backend
      ? { scope: deploymentScope(unit.backend.scope), backendIdentity: unit.backend.identity }
      : { stateFile: path.resolve(unit.stateFile!), journalFile: path.resolve(unit.journalFile!) };
    for (const id of 'scope' in storage
      ? [scopeKey(storage.scope)]
      : [storage.stateFile, storage.journalFile]) {
      if (ids.has(id)) throw new Error('Workspace units share a state or journal scope.');
      ids.add(id);
    }
    rows.push({
      ...(unit.source ? { source: unit.source } : {}),
      key: unit.key,
      project: unit.project,
      workspace: unit.workspace,
      specHash: hashJson(parseSpec(unit.spec)),
      artifactHashes: Object.fromEntries(
        [...unit.artifacts].map(([id, a]) => [id, a.artifactHash]),
      ),
      stateHash: hashJson((await unitState(unit)).value),
      storage,
    });
  }
  return { formatVersion: 1, units: rows, links };
}
export async function createWorkspacePlan({
  units,
  links = [],
  client,
  pipeline,
  maxSpendWei,
}: CreateWorkspacePlanInput) {
  const composed = composeWorkspace(units, links);
  const description = await metadata(units, links);
  const chain = {
    id: await client.getChainId(),
    genesisHash: (await client.getBlock({ blockNumber: 0n })).hash,
  };
  const states = await Promise.all(units.map(unitState));
  for (const [index, unit] of units.entries()) {
    if (unit.backend) deploymentScope(unit.backend.scope, chain);
    const state = states[index]!.value;
    if (
      state &&
      (state.chain.id !== chain.id ||
        state.chain.genesisHash.toLowerCase() !== chain.genesisHash.toLowerCase())
    )
      throw new Error('Unit state belongs to another chain.');
  }
  const records: RecoveryRecord[] = [];
  for (const unit of units) {
    let history: readonly RecoveryRecord[];
    if (unit.backend)
      history = await readStoredJournal(unit.backend.journalStore, unit.backend.scope);
    else {
      try {
        history = await readLocalJournal(unit.journalFile!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        history = [];
      }
    }
    records.push(
      ...history.map((row) => ({ ...row, actionId: workspaceId(unit.key, row.actionId) })),
    );
  }
  const plan = await createPlan({
    ...composed,
    client,
    pipeline,
    maxSpendWei,
    state: combinedState(
      units,
      states.map((s) => s.value),
      chain,
    ),
    journalRecords: records,
    pendingExternals: composed.pending,
  });
  const { planHash: _hash, ...fields } = plan;
  const full = { ...fields, workspace: description };
  return { ...full, planHash: hashJson(full) };
}
export async function applyWorkspacePlan(input: ApplyWorkspacePlanInput) {
  const { units, plan } = input;
  if (!plan.workspace || plan.workspace.formatVersion !== 1)
    throw new Error('Apply needs a saved workspace plan.');
  const current = await metadata(units, plan.workspace.links);
  const normalize = (value: WorkspaceMetadata) => ({
    ...value,
    units: value.units.map(({ stateHash: _state, ...unit }) => unit),
  });
  if (hashJson(normalize(current)) !== hashJson(normalize(plan.workspace)))
    throw new Error('Workspace sources or unit scopes changed after planning.');
  const composed = composeWorkspace(units, plan.workspace.links);
  const backend = units[0]!.backend;
  if (backend && units.some((unit) => unit.backend!.confirmations !== backend.confirmations))
    throw new Error('Workspace confirmation policies differ.');
  return applyWithRuntime(
    {
      ...input,
      ...composed,
      ...(backend ?? { stateFile: units[0]!.stateFile!, journalFile: units[0]!.journalFile! }),
      pipeline: true,
    },
    (addresses) => workspaceRuntime(units, plan, addresses, input),
  );
}
