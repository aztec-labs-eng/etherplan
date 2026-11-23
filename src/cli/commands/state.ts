import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
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
