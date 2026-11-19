import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compileProject } from './compile.ts';
import { fail, parseHcl } from './hcl.ts';
import type { CompiledProject } from './compile.ts';
import type { Evaluator } from './evaluate.ts';
import type { ModuleBinding, ModuleContext } from './module-types.ts';
import type { HclBlock, HclDocument } from './types.ts';
import type { VariableInputs } from './variables.ts';
import type { JsonObject } from '../types.ts';

interface Source {
  directory: string;
  document: HclDocument;
  calls: Map<string, { block: HclBlock; source: Source }>;
  outputs: Set<string>;
}

/** Every source directory contributes its .ethp files, without loading child configuration. */
export async function readSource(file: string): Promise<HclDocument> {
  const files =
    path.basename(file) === 'main.ethp'
      ? (await readdir(path.dirname(file), { withFileTypes: true }))
          .filter(
            (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.ethp'),
          )
          .map((entry) => entry.name)
          .sort()
          .map((name) => path.join(path.dirname(file), name))
      : [file];
  if (!files.includes(file)) throw new Error(`No main.ethp in ${path.dirname(file)}.`);
  const documents = await Promise.all(
    files.map(async (name) => parseHcl(name, await readFile(name, 'utf8'))),
  );
  const document: HclDocument = {
    kind: 'body',
    at: documents[files.indexOf(file)]!.at,
    attributes: new Map(),
    blocks: [],
  };
  for (const part of documents) {
    for (const [name, attribute] of part.attributes) {
      const first = document.attributes.get(name);
      if (first)
        fail(
          attribute,
          `${name} is already set at ${first.at.file}:${first.at.line}:${first.at.column}.`,
        );
      document.attributes.set(name, attribute);
    }
    document.blocks.push(...part.blocks);
  }
  return document;
}

/** Length-prefixed instance segments prevent ambiguity between nesting, underscores and local names. */
export function moduleResourceId(instance: string[], name: string): string {
  return instance.length === 0
    ? name
    : `module${instance.length}_${instance.map((part) => `${part.length}_${part}`).join('_')}_${name}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function compileModules(
  file: string,
  document: HclDocument,
  inputs: VariableInputs,
): Promise<CompiledProject> {
  const cache = new Map<string, Source>();
  const read = async (entry: string, stack: string[], root?: HclDocument): Promise<Source> => {
    const canonical = await realpath(entry);
    if (stack.includes(canonical))
      throw new Error(`Recursive module source cycle: ${[...stack, canonical].join(' -> ')}.`);
    const cached = cache.get(canonical);
    if (cached) return cached;
    const directory = path.dirname(canonical);
    const source: Source = {
      directory,
      document: root ?? (await readSource(canonical)),
      calls: new Map(),
      outputs: new Set(),
    };
    if (!root) {
      const configuration = (await readdir(directory)).find((name) =>
        /\.ethp(vars|config)$/.test(name),
      );
      if (configuration)
        throw new Error(
          `Child module ${directory} cannot select workspace overlays or configuration (${configuration}). Pass inputs from the root.`,
        );
      for (const name of ['chain_id', 'dependency_mode']) {
        const attribute = source.document.attributes.get(name);
        if (attribute) fail(attribute, `Child modules inherit ${name} from the root.`);
      }
      const factory = source.document.blocks.find((block) => block.type === 'factory');
      if (factory) fail(factory, 'Only the root selects the CREATE2 factory.');
    }
    for (const block of source.document.blocks) {
      if (block.type === 'output') {
        const name = block.labels[0];
        if (!name || block.labels.length !== 1 || !/^[a-z][a-zA-Z0-9_]*$/.test(name))
          fail(block, 'An output needs one valid name label.');
        if (source.outputs.has(name)) fail(block, `Duplicate output ${name}.`);
        source.outputs.add(name);
      }
      if (block.type !== 'module') continue;
      const name = block.labels[0];
      if (!name || block.labels.length !== 1 || !/^[a-z][a-zA-Z0-9_]*$/.test(name))
        fail(block, 'A module call needs one valid name label.');
      if (source.calls.has(name)) fail(block, `Duplicate module call ${name}.`);
      if (block.body.blocks.length)
        fail(block.body.blocks[0]!, 'Module inputs must be attributes.');
      const location = block.body.attributes.get('source')?.value;
      if (
        !location ||
        location.kind !== 'literal' ||
        typeof location.value !== 'string' ||
        !/^\.\.?($|\/)/.test(location.value)
      )
        fail(block, 'A module source must be a literal local path starting with ./ or ../.');
      const child = await read(path.resolve(directory, location.value, 'main.ethp'), [
        ...stack,
        canonical,
      ]);
      source.calls.set(name, { block, source: child });
    }
    cache.set(canonical, source);
    return source;
  };
  const root = await read(path.resolve(file), [], document);
  const instances: {
    path: string[];
    source: Source;
    compiled: CompiledProject;
    inputs: Map<string, ModuleBinding>;
  }[] = [];
  const compile = (
    source: Source,
    instance: string[],
    bindings: Map<string, ModuleBinding>,
    inheritedChain?: number,
  ): CompiledProject => {
    const children = new Map<string, CompiledProject>();
    const active = new Set<string>();
    let chain = inheritedChain;
    const child = (name: string, evaluator: Evaluator): CompiledProject => {
      const previous = children.get(name);
      if (previous) return previous;
      const call = source.calls.get(name);
      if (!call) throw new Error(`Unknown module ${[...instance, name].join('.')}.`);
      if (active.has(name))
        fail(call.block, `Module input/output cycle at ${[...instance, name].join('.')}.`);
      active.add(name);
      const args = new Map<string, ModuleBinding>();
      for (const [key, attribute] of call.block.body.attributes) {
        if (key !== 'source')
          args.set(
            key,
            evaluator.capture(() =>
              evaluator.input(attribute.value, `module ${name} input ${key}`),
            ),
          );
      }
      let result: CompiledProject;
      try {
        result = compile(call.source, [...instance, name], args, chain);
      } catch (error) {
        throw new Error(`Module ${[...instance, name].join('.')}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      children.set(name, result);
      active.delete(name);
      return result;
    };
    const context: ModuleContext = {
      child: instance.length > 0,
      bindings,
      qualify: (name) => moduleResourceId(instance, name),
      inputs: [...source.calls.values()].flatMap(({ block }) =>
        [...block.body.attributes.values()]
          .filter((attribute) => attribute.name !== 'source')
          .map((attribute) => attribute.value),
      ),
      hasOutput: (name, output) => source.calls.get(name)?.source.outputs.has(output) ?? false,
      output: (name, output, evaluator) => child(name, evaluator).outputs![output]!,
      load(evaluator, chainId) {
        chain = chainId;
        for (const name of [...source.calls.keys()].sort()) child(name, evaluator);
      },
    };
    const local =
      instance.length === 0
        ? source.document
        : {
            ...source.document,
            attributes: new Map(source.document.attributes).set('chain_id', {
              kind: 'attribute' as const,
              name: 'chain_id',
              at: source.document.at,
              value: { kind: 'literal' as const, value: inheritedChain!, at: source.document.at },
            }),
          };
    const result = compileProject(local, instance.length === 0 ? inputs : {}, context);
    if (instance.length > 0) {
      for (const contract of result.spec.contracts) {
        if (typeof contract.artifact === 'string')
          contract.artifact = path.relative(
            root.directory,
            path.resolve(source.directory, contract.artifact),
          );
      }
      instances.push({ path: instance, source, compiled: result, inputs: bindings });
    }
    return result;
  };
  const result = compile(root, [], new Map());
  const all = [result.spec, ...instances.map((item) => item.compiled.spec)];
  const ids = new Set<string>();
  for (const spec of all) {
    for (const [kind, names] of [
      ['contract', spec.contracts.map((item) => item.id)],
      ['call', spec.calls.map((item) => item.id)],
      ['external', Object.keys(spec.externals)],
    ] as const) {
      for (const name of names) {
        const id = `${kind}:${name}`;
        if (ids.has(id))
          throw new Error(`Module resource ID collision: ${id}. Rename the root resource.`);
        ids.add(id);
      }
    }
  }
  result.spec.contracts = all
    .flatMap((spec) => spec.contracts)
    .sort((a, b) => compare(String(a.id), String(b.id)));
  result.spec.calls = all
    .flatMap((spec) => spec.calls)
    .sort((a, b) => compare(String(a.id), String(b.id)));
  result.spec.externals = Object.assign({}, ...all.map((spec) => spec.externals));
  const assumptions = all.flatMap((spec) => spec.executionAssumptions ?? []);
  if (assumptions.length) result.spec.executionAssumptions = assumptions;
  result.spec.modules = {
    version: 1,
    instances: instances
      .sort((a, b) => compare(JSON.stringify(a.path), JSON.stringify(b.path)))
      .map((item): JsonObject => ({
        path: item.path,
        resources: Object.fromEntries(
          ['contract', 'external', 'call'].map((kind) => [
            kind,
            Object.fromEntries(
              item.source.document.blocks
                .filter((block) => block.type === 'resource' && block.labels[0] === kind)
                .map((block) => block.labels[1]!)
                .filter((name) => ids.has(`${kind}:${moduleResourceId(item.path, name)}`))
                .sort()
                .map((name) => [name, `${kind}:${moduleResourceId(item.path, name)}`]),
            ),
          ]),
        ),
        inputs: Object.fromEntries(
          [...item.inputs].sort(([a], [b]) => compare(a, b)),
        ) as unknown as JsonObject,
        outputs: (item.compiled.outputs as unknown as JsonObject) ?? {},
      })),
  };
  return result;
}
