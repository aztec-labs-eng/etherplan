import path from 'node:path';
import { readUnfinishedPlan } from '../../execution/backends.ts';
import { backendFromFile, publicClient } from '../environment.ts';
import type { CommandContext } from './context.ts';
import { print, writeJsonAtomic } from '../shared.ts';

// Finds the saved plan that an interrupted apply left unfinished. It reads the backend and the chain identity only.
export async function unfinished({ options }: CommandContext): Promise<void> {
  if (!options.backend) throw new Error('unfinished needs --backend file.json.');
  const client = publicClient();
  const [chainId, genesis] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockNumber: 0n }),
  ]);
  const backend = await backendFromFile(
    options.backend,
    { id: chainId, genesisHash: genesis.hash },
    { requireBucket: true },
  );
  if (!backend.planStore) throw new Error('unfinished needs a plan bucket in backend config.');
  const found = await readUnfinishedPlan({ ...backend, planStore: backend.planStore });
  const out = found && options.out ? path.resolve(options.out) : null;
  if (found && out) await writeJsonAtomic(out, found.plan);
  print({
    scope: backend.scope,
    planHash: found?.planHash ?? null,
    transactions: found?.transactions ?? [],
    out,
  });
}
