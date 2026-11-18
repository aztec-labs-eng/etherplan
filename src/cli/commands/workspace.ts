import path from 'node:path';
import { hashJson } from '../../identity.ts';
import { readFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { loadProject, findSpecFile, selectWorkspace } from '../../input/project.ts';
import { loadArtifacts } from '../../artifacts.ts';
import { createWorkspacePlan, applyWorkspacePlan } from '../../workspace/index.ts';
import {
  addressesFromModule,
  assertAwsBackendInitialized,
  backendFromFile,
  namedSigners,
  publicClient,
  signerFromModule,
  signersFromEnvironment,
  specNeedsOwner,
  stateFileFor,
} from '../environment.ts';
import { defaultJournalFile, print, writeJsonAtomic } from '../shared.ts';
import { formatApplyReport } from '../reporting.ts';
import type { WorkspaceUnit, WorkspaceUnitSource, WorkspaceLink } from '../../workspace/types.ts';
import type { Plan } from '../../planning/types.ts';
import type { CliOptions } from '../options.ts';
import type { ApplyOptions } from '../../execution/types.ts';

export async function workspaceCommand(
  command: 'plan' | 'apply',
  options: CliOptions,
  saved?: Plan,
) {
  if (!options.pipeline) throw new Error('A workspace plan requires --pipeline.');
  const client = publicClient();
  const chain = {
    id: await client.getChainId(),
    genesisHash: (await client.getBlock({ blockNumber: 0n })).hash,
  };
  const manifestFile = options['workspace-manifest']
    ? path.resolve(options['workspace-manifest'])
    : null;
  const manifest = manifestFile ? JSON.parse(await readFile(manifestFile, 'utf8')) : null;
  const entries =
    manifest?.units ??
    saved?.workspace?.units.map((unit) => ({
      key: unit.key,
      project: unit.project,
      ...unit.source,
    }));
  if (!Array.isArray(entries) || !entries.length)
    throw new Error('Workspace manifest needs units.');
  const units: WorkspaceUnit[] = [];
  const root = manifestFile ? path.dirname(manifestFile) : process.cwd();
  for (const entry of entries) {
    if (typeof entry.projectDirectory !== 'string')
      throw new Error('Workspace unit needs its source projectDirectory.');
    const projectDirectory = path.resolve(root, entry.projectDirectory);
    const workspace = selectWorkspace(entry.workspace);
    const specFile = await findSpecFile(projectDirectory);
    const varFiles = (entry.varFiles ?? []).map((file: string) => path.resolve(root, file));
    const source: WorkspaceUnitSource = {
      projectDirectory,
      workspace,
      varFiles,
      vars: entry.vars ?? [],
      ...(entry.backendFile ? { backendFile: path.resolve(root, entry.backendFile) } : {}),
      ...(entry.stateFile ? { stateFile: path.resolve(root, entry.stateFile) } : {}),
      ...(entry.journalFile ? { journalFile: path.resolve(root, entry.journalFile) } : {}),
    };
    const { spec } = await loadProject(specFile, {
      workspace,
      varFiles,
      vars: source.vars,
      env: process.env,
    });
    const stateFile = source.stateFile ?? stateFileFor(specFile, {}, workspace);
    const backend = source.backendFile
      ? await backendFromFile(source.backendFile, chain, { requireBucket: true })
      : undefined;
    if (backend)
      await assertAwsBackendInitialized(source.backendFile!, projectDirectory, workspace);
    units.push({
      key: entry.key,
      project: entry.project ?? path.basename(projectDirectory),
      workspace,
      spec,
      artifacts: await loadArtifacts(spec, specFile),
      source,
      ...(backend
        ? {
            backend: {
              ...backend,
              identity: hashJson(JSON.parse(await readFile(source.backendFile!, 'utf8'))),
              coordinationId: await coordinationId(source.backendFile!),
              confirmations: backend.confirmations!,
            },
          }
        : { stateFile, journalFile: source.journalFile ?? defaultJournalFile(stateFile) }),
    });
  }
  if (command === 'plan') {
    if (!options['max-spend-wei']) throw new Error('Workspace plan needs --max-spend-wei.');
    const module = options['signer-module']
      ? await signerFromModule(options['signer-module'])
      : null;
    const addresses = module
      ? await addressesFromModule(
          module,
          units.some((unit) => specNeedsOwner(unit.spec as Parameters<typeof specNeedsOwner>[0])),
        )
      : {
          deployers: options.deployers?.split(',') ?? [],
          owner: options.owner ?? null,
          named: namedSigners(options['named-signers']),
        };
    const plan = await createWorkspacePlan({
      units,
      links: (manifest.links ?? []) as WorkspaceLink[],
      client,
      pipeline: { ...addresses, parallel: options.parallel ?? false },
      maxSpendWei: options['max-spend-wei'],
    });
    for (const unit of units)
      if (unit.backend?.planStore) await unit.backend.planStore.put(unit.backend.scope, plan);
    if (options.out !== '-') await writeJsonAtomic(path.resolve(options.out ?? 'plan.json'), plan);
    print(plan);
    return;
  }
  const signerSource = options['signer-module']
    ? await signerFromModule(options['signer-module'])
    : { signers: signersFromEnvironment() };
  const overrides: ApplyOptions = {};
  for (const [flag, key] of [
    ['gas-multiplier', 'gasMultiplier'],
    ['base-fee-multiplier', 'baseFeeMultiplier'],
    ['receipt-timeout-ms', 'receiptTimeoutMs'],
    ['verification-timeout-ms', 'verificationTimeoutMs'],
  ] as const)
    if (options[flag] !== undefined) overrides[key] = Number(options[flag]);
  if (options['max-fee-per-gas'])
    overrides.fees = {
      maxFeePerGas: options['max-fee-per-gas'],
      maxPriorityFeePerGas: options['priority-fee-per-gas']!,
    };
  if (options['replace-max-fee-per-gas'])
    overrides.replacementFees = {
      maxFeePerGas: options['replace-max-fee-per-gas'],
      maxPriorityFeePerGas: options['replace-priority-fee-per-gas']!,
      maxCostWei: options['replace-max-cost-wei']!,
    };
  if (options['max-spend-wei']) {
    const signers = saved!.pipeline!;
    overrides.budgets = Object.fromEntries(
      [
        ...signers.deployers,
        ...Object.values(signers.named ?? {}),
        ...(signers.owner ? [signers.owner] : []),
      ].map((address) => [address, options['max-spend-wei']!]),
    );
  }
  const verification = process.env.ETH_VERIFICATION_RPC_URL;
  const result = await applyWorkspacePlan({
    units,
    plan: saved!,
    client,
    ...signerSource,
    ...overrides,
    parallel: options.parallel ?? false,
    pipeline: true,
    ...(verification
      ? { verificationClient: createPublicClient({ transport: http(verification) }) }
      : {}),
  });
  if (options.json) print(result);
  else process.stdout.write(formatApplyReport(result));
}

async function coordinationId(file: string) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  return hashJson({
    kind: config.kind,
    region: config.region ?? null,
    tableName: config.tableName,
    kmsKeyId: config.kmsKeyId,
    bucket: config.bucket ?? null,
    prefix: config.prefix ?? 'etherplan',
  });
}
