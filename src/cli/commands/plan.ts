import path from 'node:path';
import { writeJsonAtomic, print } from '../shared.ts';
import { formatPlanReport } from '../reporting.ts';
import { planFor } from './plan-context.ts';
import type { ChainCommandContext } from './context.ts';

export async function plan(context: ChainCommandContext): Promise<void> {
  const { options, specFile, workspace } = context;
  const { plan, backend } = await planFor('plan', context);
  if (
    plan.resources.some((resource) => ['deploy', 'call'].includes(resource.action)) &&
    ((!options.deployers && !options['signer-module']) || !options['max-spend-wei'])
  ) {
    throw new Error(
      'A write plan needs --deployers <address,address> or --signer-module, and --max-spend-wei <amount>.',
    );
  }
  if (backend?.planStore) await backend.planStore.put(backend.scope, plan);
  const outFile = options.out === '-' ? null : path.resolve(options.out ?? 'plan.json');
  if (outFile) await writeJsonAtomic(outFile, plan);
  if (options.json) print(plan);
  else {
    process.stdout.write(formatPlanReport(plan, path.basename(path.dirname(specFile)), workspace));
    if (outFile) process.stdout.write(`Full plan saved to ${outFile}\n`);
  }
  if (
    plan.resources.some(
      (resource) => resource.action === 'conflict' || resource.action === 'unverified',
    )
  )
    process.exitCode = 1;
  return;
}
