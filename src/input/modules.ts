import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compileProject } from './compile.ts';
import { fail, parseHcl } from './hcl.ts';
import { hasReference } from './module-types.ts';
import { MODULE_KEY, modulePath } from '../spec/modules.ts';
import type { ModulePath } from '../spec/modules.ts';
import type { CompiledProject } from './compile.ts';
import type { Evaluator } from './evaluate.ts';
import type { ModuleBinding, ModuleContext } from './module-types.ts';
import type { HclBlock, HclDocument } from './types.ts';
import type { VariableInputs } from './variables.ts';
import type { JsonObject, JsonValue } from '../types.ts';

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
export function moduleResourceId(instance: ModulePath, name: string): string {
  return instance.length === 0
    ? name
    : `module${instance.length}_${instance.map((part) => (typeof part === 'string' ? `${part.length}_${part}` : `k${part.key.length}_${part.key}`)).join('_')}_${name}`;
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
  let repeated = false;
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
      if (!root && block.type === 'variable' && block.labels[0] === 'for_each')
        fail(block, 'Child variable for_each is reserved for module repetition. Rename the input.');
      if (block.type === 'output') {
        const name = block.labels[0];
        if (!name || block.labels.length !== 1 || !/^[a-z][a-zA-Z0-9_]*$/.test(name))
          fail(block, 'An output needs one valid name label.');
        if (source.outputs.has(name)) fail(block, `Duplicate output ${name}.`);
        source.outputs.add(name);
      }
      if (block.type !== 'module') continue;
      if (block.body.attributes.has('for_each')) repeated = true;
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
    path: ModulePath;
    source: Source;
    compiled: CompiledProject;
    inputs: Map<string, ModuleBinding>;
  }[] = [];
  const compile = (
    source: Source,
    instance: ModulePath,
    bindings: Map<string, ModuleBinding>,
    inheritedChain?: number,
  ): CompiledProject => {
    const children = new Map<string, CompiledProject>();
    const active = new Set<string>();
    const collections = new Map<string, Record<string, JsonValue>>();
    let chain = inheritedChain;
    const collection = (name: string, evaluator: Evaluator): Record<string, JsonValue> => {
      const cached = collections.get(name);
      if (cached) return cached;
      const attribute = source.calls.get(name)!.block.body.attributes.get('for_each')!;
      const identity = `collection:${name}`;
      if (active.has(identity))
        fail(attribute, `Module for_each cycle at ${modulePath([...instance, name])}.`);
      active.add(identity);
      const value = evaluator.withEach(undefined, () =>
        evaluator.constant(attribute.value, `module ${name} for_each`),
      );
      if (
        value !== null &&
        (typeof value !== 'object' || Array.isArray(value) || hasReference(value))
      )
        fail(attribute, `module ${name} for_each must be a constant record or null.`);
      const record = value ?? {};
      for (const key of Object.keys(record))
        if (!MODULE_KEY.test(key))
          fail(
            attribute,
            `Module ${name} key ${JSON.stringify(key)} must contain 1 to 12 lowercase letters or digits (${MODULE_KEY}).`,
          );
      collections.set(name, record);
      active.delete(identity);
      return record;
    };
    const child = (
      name: string,
      key: string | undefined,
      evaluator: Evaluator,
    ): CompiledProject => {
      const identity = JSON.stringify([name, key ?? null]);
      const previous = children.get(identity);
      if (previous) return previous;
      const call = source.calls.get(name);
      if (!call) throw new Error(`Unknown module ${modulePath([...instance, name])}.`);
      const path: ModulePath = [...instance, name, ...(key === undefined ? [] : [{ key }])];
      const record = key === undefined ? undefined : collection(name, evaluator);
      if (key !== undefined && !Object.hasOwn(record!, key))
        fail(
          call.block,
          `module.${modulePath([...instance, name])} has unknown key ${JSON.stringify(key)}. Available keys: ${Object.keys(record!).sort().join(', ') || '(none)'}.`,
        );
      if (active.has(identity))
        fail(call.block, `Module input/output cycle at ${modulePath(path)}.`);
      active.add(identity);
      const args = new Map<string, ModuleBinding>();
      for (const [inputName, attribute] of call.block.body.attributes) {
        if (inputName !== 'source' && inputName !== 'for_each')
          args.set(
            inputName,
            evaluator.withEach(key === undefined ? undefined : { key, value: record![key]! }, () =>
              evaluator.capture(() =>
                evaluator.input(attribute.value, `module ${modulePath(path)} input ${inputName}`),
              ),
            ),
          );
      }
      let result: CompiledProject;
      try {
        result = compile(call.source, path, args, chain);
      } catch (error) {
        throw new Error(`Module ${modulePath(path)}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      children.set(identity, result);
      active.delete(identity);
      return result;
    };
    const context: ModuleContext = {
      child: instance.length > 0,
      bindings,
      qualify: (name) => moduleResourceId(instance, name),
      inputs: [...source.calls.values()].flatMap(({ block }) =>
        [...block.body.attributes.values()]
          .filter((attribute) => attribute.name !== 'source')
          .map((attribute) => ({
            value: attribute.value,
            each: block.body.attributes.has('for_each') && attribute.name !== 'for_each',
          })),
      ),
      hasOutput(name, output, node) {
        const call = source.calls.get(name);
        if (call && call.block.body.attributes.has('for_each') !== (node.key !== undefined))
          fail(
            node,
            call.block.body.attributes.has('for_each')
              ? `Repeated module.${name} needs module.${name}[<key>].${output}.`
              : `A single module call uses module.${name}.${output}; remove the index.`,
          );
        return call?.source.outputs.has(output) ?? false;
      },
      output(name, output, evaluator, node) {
        const key = node.key ? evaluator.constant(node.key, `module.${name} key`) : undefined;
        if (key !== undefined && typeof key !== 'string')
          fail(node, `module.${name} key must be a constant string.`);
        return child(name, key, evaluator).outputs![output]!;
      },
      load(evaluator, chainId) {
        chain = chainId;
        for (const name of [...source.calls.keys()].sort()) {
          if (source.calls.get(name)!.block.body.attributes.has('for_each'))
            for (const key of Object.keys(collection(name, evaluator)).sort())
              child(name, key, evaluator);
          else child(name, undefined, evaluator);
        }
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
    version: repeated ? 2 : 1,
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
