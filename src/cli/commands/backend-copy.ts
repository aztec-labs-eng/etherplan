import { copyDeploymentScope } from '../../execution/backend-copy.ts';
import { backendFromFile, publicClient } from '../environment.ts';
import { UsageError } from '../options.ts';
import type { CommandContext } from './context.ts';
import { print } from '../shared.ts';

// Copies one settled deployment scope from the --from backend into the --to backend. The source is only read.
export async function backendCopy({ options }: CommandContext): Promise<void> {
  if (!options.from || !options.to)
    throw new UsageError('backend-copy needs --from and --to backend files.');
  const client = publicClient();
  const [chainId, genesis] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockNumber: 0n }),
  ]);
  const chain = { id: chainId, genesisHash: genesis.hash };
  const aws = (profile: string | undefined, region: string | undefined) => ({
    ...(profile ? { profile } : {}),
    ...(region ? { region } : {}),
  });
  const source = await backendFromFile(
    options.from,
    chain,
    aws(options['from-profile'], options['from-region']),
  );
  const target = await backendFromFile(
    options.to,
    chain,
    aws(options['to-profile'], options['to-region']),
  );
  print(
    await copyDeploymentScope({
      source,
      target,
      sourceScope: source.scope,
      targetScope: target.scope,
      ...(options.resources
        ? { resources: options.resources.split(',').map((id) => id.trim()) }
        : {}),
      ...(target.ttlMs !== undefined ? { ttlMs: target.ttlMs } : {}),
    }),
  );
}
