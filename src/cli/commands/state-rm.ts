import path from 'node:path';
import { removeFromLocalState, removeFromStoredState } from '../../execution/state-removal.ts';
import type { ParsedSpec } from '../../spec/types.ts';
import { backendFromFile, publicClient } from '../environment.ts';
import type { CliOptions } from '../options.ts';
import { defaultJournalFile, print } from '../shared.ts';

export async function stateRm({
  options,
  spec,
  stateFile,
}: {
  options: CliOptions;
  spec: ParsedSpec;
  stateFile: string;
}): Promise<void> {
  const ids = options.resources!.split(',').map((id) => id.trim());
  const declared = new Set([
    ...spec.contracts.map((item) => `contract:${item.id}`),
    ...spec.calls.map((item) => `call:${item.id}`),
    ...Object.keys(spec.externals).map((name) => `external:${name}`),
  ]);
  if (options.backend) {
    const client = publicClient();
    const id = await client.getChainId();
    const genesis = await client.getBlock({ blockNumber: 0n });
    const backend = await backendFromFile(options.backend, { id, genesisHash: genesis.hash });
    const { removed } = await removeFromStoredState({
      backend,
      scope: backend.scope,
      ids,
      declared,
      ...(backend.ttlMs ? { ttlMs: backend.ttlMs } : {}),
    });
    print({ status: 'removed', removed, scope: backend.scope });
    return;
  }
  const journalFile = path.resolve(options.journal ?? defaultJournalFile(stateFile));
  const { removed } = await removeFromLocalState({ stateFile, journalFile, ids, declared });
  print({ status: 'removed', removed, stateFile });
}
