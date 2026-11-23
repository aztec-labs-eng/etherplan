import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  moveScopeResource,
  pullDeploymentScope,
  pushDeploymentScope,
  summarizePulledScope,
} from '../../execution/scope-transfer.ts';
import type { PulledScope } from '../../execution/scope-transfer.ts';
import type { ChainIdentity } from '../../types.ts';
import { backendFromFile, publicClient } from '../environment.ts';
import type { CommandContext } from './context.ts';
import { print, writeJsonAtomic } from '../shared.ts';

async function chainIdentity(): Promise<ChainIdentity> {
  const client = publicClient();
  const [chainId, genesis] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockNumber: 0n }),
  ]);
  return { id: chainId, genesisHash: genesis.hash };
}

// Writes one settled deployment scope of the backend to a file. The backend is only read.
export async function statePull({ options }: CommandContext): Promise<void> {
  const backend = await backendFromFile(options.backend!, await chainIdentity());
  const pulled = await pullDeploymentScope({ backend, scope: backend.scope });
  const out = path.resolve(options.out!);
  await writeJsonAtomic(out, pulled);
  print({ ...summarizePulledScope(pulled), out });
}

// Writes a pulled scope into the backend's scope, which must be empty.
export async function statePush({ options }: CommandContext): Promise<void> {
  const pulled = JSON.parse(await readFile(path.resolve(options.in!), 'utf8')) as PulledScope;
  const backend = await backendFromFile(options.backend!, await chainIdentity());
  print(
    await pushDeploymentScope({
      backend,
      pulled,
      scope: backend.scope,
      ...(options.resources
        ? { resources: options.resources.split(',').map((id) => id.trim()) }
        : {}),
      ...(backend.ttlMs !== undefined ? { ttlMs: backend.ttlMs } : {}),
    }),
  );
}

// Moves one resource between two files of state pull. It reads no backend and no chain.
export async function stateMove({ options }: CommandContext): Promise<void> {
  const [source, target] = [path.resolve(options.in!), path.resolve(options.out!)];
  if (source === target) throw new Error('state mv moves a resource between two files.');
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as PulledScope;
  const to = await read(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const moved = moveScopeResource({
    from: await read(source),
    ...(to ? { to } : {}),
    source: options.from!,
    destination: options.to!,
  });
  // The destination goes first: a run that stops between the two writes leaves the resource in both files, and the
  // next run refuses it.
  await writeJsonAtomic(target, moved.to);
  await writeJsonAtomic(source, moved.from);
  print({
    ...summarizePulledScope(moved.to),
    moved: { from: options.from, to: options.to, journalRecords: moved.movedRecords },
    in: source,
    out: target,
  });
}
