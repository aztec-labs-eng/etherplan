import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { keccak256 } from 'viem';
import { checkPlanIdentity } from '../src/execution/preflight.ts';
import { compileSpecFile } from '../src/input/project.ts';
import { prepareResources, transactionFor } from '../src/planning/index.ts';
import { graph, parseSpec } from '../src/spec/index.ts';
import { holderArtifact, registryArtifact } from './execution/contracts.ts';
import { normalizedArtifact } from './interface-fixtures.ts';

export const OWNER = '0x0000000000000000000000000000000000000001';
export const OTHER = '0x0000000000000000000000000000000000000002';
export const FACTORY_CODE = '0x6001';
export const CHAIN = { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` };
export const BLOCK_HASH = `0x${'bb'.repeat(32)}`;

export async function moduleProject(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-modules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (name, source) => {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  };
  for (const [name, source] of Object.entries(files)) await write(name, source);
  return {
    directory,
    write,
    compile: () => compileSpecFile(path.join(directory, 'main.ethp')),
  };
}

export function artifactsFor(spec) {
  return new Map(
    spec.contracts.map((item) => [
      item.id,
      item.artifact.endsWith('Minimal.json')
        ? normalizedArtifact
        : item.artifact.endsWith('Registry.json')
          ? registryArtifact
          : holderArtifact,
    ]),
  );
}

export function prepared(spec) {
  const parsed = parseSpec(spec);
  return prepareResources(parsed, graph(parsed), artifactsFor(spec));
}

export function planningClient({ code = new Map(), binding = OWNER } = {}) {
  return {
    async getChainId() {
      return CHAIN.id;
    },
    async getBlock({ blockNumber }) {
      return blockNumber === 0n
        ? { number: 0n, hash: CHAIN.genesisHash }
        : { number: 7n, hash: BLOCK_HASH };
    },
    async getCode({ address }) {
      return address.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c'
        ? FACTORY_CODE
        : (code.get(address.toLowerCase()) ?? '0x');
    },
    async readContract() {
      return binding;
    },
  };
}

export const factorySource = `factory {
  address = "0x4e59b44847b379578588920cA78FbF26c0B4956C"
  code_hash = "${keccak256(FACTORY_CODE)}"
}`;

export function acceptPlan(plan, spec, client = planningClient()) {
  return checkPlanIdentity({
    plan,
    spec,
    artifacts: artifactsFor(spec),
    client,
    deps: { parseSpec, graph, prepareResources, transactionFor },
  });
}
