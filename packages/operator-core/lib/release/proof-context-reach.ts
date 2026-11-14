/** Actual static consumer provenance for P-021. This is preparation, never execution authority.
 * The caller supplies the existing selector's FULL population for each immutable source tree.
 * File-backed component identities come from this capture; arbitrary runtime/DB values cannot
 * be assigned a small radius by naming a file. Leave those unmapped for the full fallback.
 */
import { createHash } from 'node:crypto';
import { createSourceByteSnapshot } from '@papercusp/test-config/execution-details';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PROOF_CONTEXT_COMPONENTS, readProofContextIdentity,
  type ProofContextComponent, type ProofContextIdentity, type ProofContextReach,
  type ProofContextComparison } from '@papercusp/test-config/configuration-snapshot';
import { buildIndex, transitiveDeps, tsconfigPathEntriesFor,
  type RelatedFs, type WorkspacePackage, type RelatedIndex } from '../../../../scripts/lib/related-tests.mjs';
import { listFilesIncludingUntracked } from '../../../../scripts/lib/tracked-files.mjs';
import { expandWorkspaces } from '../../../../scripts/assert-workspace-links.mjs';

export const PROOF_CONTEXT_REACH_VERSION = 'static-selected-consumers-v1';
type FileIdentity = { path: string; sha256: string };
type Consumer = { kind: 'test' | 'leg'; id: string; inputs: FileIdentity[] };
type Component = { identity: string; inputs: FileIdentity[]; scope: 'files' | 'global' };

/** Structural subset of enumerateAffectedTaskSelection, not a new population selector. */
export interface ProofContextReachSelection {
  schemaVersion: number;
  kind: string;
  phase: string;
  coverage: string;
  files: string[];
  tasks: Array<{ id: string; dir: string; runner: string; files: string[];
    command: string; config?: unknown; lifecycleCommands?: unknown[] }>;
  unenumerated: unknown[];
  overlaps: unknown[];
  commandObligations: unknown[];
}

export interface ProofContextReachCaptureInput {
  rootDir: string;
  selection: ProofContextReachSelection;
  /** COMPLETE file manifests for the components the caller can actually measure this way.
   * Use the returned identity in ProofContextIdentity. No entry means unknown reach.
   * Runtime capabilities, database generations, etc. need their existing measured adapters.
   */
  componentFiles: Partial<Record<ProofContextComponent, readonly string[]>>;
  /** Conservative shared inputs (lockfiles, runtime settings, etc.) affect the whole census. */
  globalComponents?: readonly ProofContextComponent[];
  /** Exact lint/check population from the gate, including each leg's actual entry modules. */
  legs: Array<{ id: string; entryFiles: string[]; workspaceDir?: string }>;
  /** Additional measured file consumers, e.g. fixtures loaded without an import. */
  testInputs?: Record<string, readonly string[]>;
}

export type ProofContextReachCapture = {
  status: 'known';
  schemaVersion: typeof PROOF_CONTEXT_REACH_VERSION;
  fingerprint: string;
  selection: string;
  components: Partial<Record<ProofContextComponent, Component>>;
  consumers: Consumer[];
} | { status: 'unknown'; reason: string };

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value, ''))).digest('hex');
const bytesHash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const sourceFile = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const runnerConfig = /^(?:vitest|vite)(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/;
const hashPattern = /^[a-f0-9]{64}$/;

function relativeFile(value: string): boolean {
  return typeof value === 'string' && !!value && !path.isAbsolute(value) && !value.includes('\\')
    && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}

function canonical(value: unknown, root: string): unknown {
  if (typeof value === 'string') return !root ? value : value === root ? '.' : value.startsWith(root + path.sep)
    ? value.slice(root.length + 1).split(path.sep).join('/') : value;
  if (Array.isArray(value)) return value.map(entry => canonical(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key], root)]));
  return value;
}

/** The maintained graph resolves literal imports. Nonliteral loads cannot silently become leaves. */
function hasUnknownModuleLoad(file: string, source: string): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return sourceFile.test(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if ((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) return true;
  let unknown = false;
  const opaqueLoaderModule = (value: string) => /^(?:node:)?(?:fs(?:\/promises)?|module|vm|child_process|worker_threads)$/.test(value);
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && opaqueLoaderModule(node.moduleSpecifier.text)) unknown = true;
    }
    if (ts.isIdentifier(node)) {
      // The maintained graph recognizes ONLY a literal, direct require call. An escaped
      // require/module/eval/Function value can load arbitrary files behind any alias.
      if (node.text === 'require' && !(ts.isCallExpression(node.parent)
        && node.parent.expression === node && node.parent.arguments.length === 1
        && ts.isStringLiteral(node.parent.arguments[0]!))) unknown = true;
      if (['module', 'eval', 'Function', 'createRequire', 'getBuiltinModule'].includes(node.text)) unknown = true;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) unknown = true;
      else if (opaqueLoaderModule((node.arguments[0] as ts.StringLiteral).text)) unknown = true;
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      // A static import graph cannot prove runtime filesystem discovery or require.resolve.
      if (['readFile', 'readFileSync', 'readdir', 'readdirSync', 'createReadStream', 'glob', 'globSync'].includes(name)
        || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require') unknown = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return unknown;
}

/** Capture real source bytes and the maintained cross-root graph, then verify the read set
 * and inventory did not move. No injected graph or caller-authored `complete:true` is accepted.
 * OLD and NEW must each be captured from their own source tree, not from today's graph twice.
 */
export function captureProofContextReach(input: ProofContextReachCaptureInput): ProofContextReachCapture {
  try {
    const root = realpathSync(input.rootDir);
    const selection = input.selection;
    const fail = (reason: string): never => { throw new Error(reason); };
    const census = listFilesIncludingUntracked(root);
    if (census.unscanned.length) return { status: 'unknown', reason: 'source-census-incomplete' };
    const inventory = sorted(census.files as string[]);
    if (!inventory.every(relativeFile)) return { status: 'unknown', reason: 'source-census-invalid' };
    const files = new Set(inventory.map(file => path.resolve(root, file)));
    const reads = new Map<string, Buffer>();
    const rel = (file: string) => {
      const value = path.relative(root, file).split(path.sep).join('/');
      if (!relativeFile(value)) fail('graph-outside-root');
      return value;
    };
    const read = (file: string): string | null => {
      if (reads.has(file)) return reads.get(file)!.toString('utf8');
      if (!files.has(file)) return null;
      if (realpathSync(file) !== file) fail('source-symlink-unsupported');
      const value = readFileSync(file);
      reads.set(file, value);
      return value.toString('utf8');
    };
    const fs: RelatedFs = {
      list: dir => [...files].filter(file => file.startsWith(dir + path.sep) && sourceFile.test(file)
        && !/\.d\.[cm]?ts$/.test(file)),
      read, exists: file => files.has(file),
    };
    if (!selection || selection.schemaVersion !== 1 || selection.kind !== 'full-gate'
      || selection.phase !== 'selection-preparation' || selection.coverage !== 'complete'
      || !Array.isArray(selection.files) || !selection.files.length
      || selection.unenumerated.length || selection.overlaps.length || selection.commandObligations.length
      || !selection.files.every(relativeFile) || sorted(selection.files).length !== selection.files.length)
      return { status: 'unknown', reason: 'consumer-census-incomplete' };
    const tasks = selection.tasks;
    if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => task.runner !== 'vitest'
      || !Array.isArray(task.files) || !task.files.length || (task.lifecycleCommands?.length ?? 0) > 0
      || !(task.dir === '.' || relativeFile(task.dir))) || new Set(tasks.map(task => task.id)).size !== tasks.length)
      return { status: 'unknown', reason: 'consumer-census-unsupported' };
    const taskFiles = tasks.flatMap(task => task.files);
    if (taskFiles.length !== selection.files.length
      || JSON.stringify(sorted(taskFiles)) !== JSON.stringify(sorted(selection.files)))
      return { status: 'unknown', reason: 'consumer-census-mismatch' };
    if (Object.keys(input.testInputs ?? {}).some(id => !selection.files.includes(id)))
      return { status: 'unknown', reason: 'unknown-test-consumer' };

    const rootManifest = JSON.parse(read(path.join(root, 'package.json')) ?? fail('root-manifest-missing'));
    const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages ?? [];
    const manifestDirs = inventory.filter(file => path.basename(file) === 'package.json').map(file => path.posix.dirname(file));
    // Reuse the affected runner's registry expansion. Fixture/example manifests are NOT
    // workspace packages; treating them as such creates false duplicate names and edges.
    const workspaceDirs = sorted(expandWorkspaces(patterns, root, { directories: manifestDirs }));
    const workspaceCensus = () => sorted(expandWorkspaces(patterns, root));
    // npm includes Git-ignored manifests. A source-only registry can silently
    // omit duplicate names or consumers which the actual workspace runner sees.
    // Such workspaces have no measured source custody in this graph.
    if (workspaceDirs.length > 4096 || JSON.stringify(workspaceDirs) !== JSON.stringify(workspaceCensus()))
      return { status: 'unknown', reason: 'workspace-census-incomplete' };
    const packageDirs = sorted(['.', ...workspaceDirs,
      ...tasks.map(task => task.dir), ...input.legs.flatMap(leg => leg.workspaceDir ? [leg.workspaceDir] : [])]);
    const packages: WorkspacePackage[] = packageDirs.flatMap(dir => {
        if (!(dir === '.' || relativeFile(dir))) return fail('workspace-directory-invalid');
        const file = path.posix.join(dir, 'package.json');
        const manifest = JSON.parse(read(path.resolve(root, file))!);
        return typeof manifest.name === 'string' ? [{ name: manifest.name,
          dir: path.dirname(path.resolve(root, file)), exports: manifest.exports, main: manifest.main }] : [];
      });
    if (new Set(packages.map(pkg => pkg.name)).size !== packages.length)
      return { status: 'unknown', reason: 'ambiguous-workspace-package' };
    const indexes = new Map<string, { index: RelatedIndex; reach: ReturnType<typeof transitiveDeps> }>();
    const graph = (dir: string) => {
      const workspace = path.resolve(root, dir);
      if (workspace !== root) rel(workspace);
      let cached = indexes.get(workspace);
      if (!cached) {
        const index = buildIndex({ rootDir: workspace, fs,
          aliases: tsconfigPathEntriesFor(workspace, { readFile: file => {
            const text = read(file); if (text === null) throw new Error('missing-alias-input'); return text;
          } }), crossRoot: { packages } });
        cached = { index, reach: transitiveDeps(index) };
        indexes.set(workspace, cached);
      }
      return cached;
    };
    const identities = (paths: readonly string[]): FileIdentity[] => {
      if (!paths.length || !paths.every(relativeFile) || sorted(paths).length !== paths.length)
        return fail('input-manifest-invalid');
      return sorted(paths).map(file => {
        const value = read(path.resolve(root, file));
        if (value === null) return fail('input-unreadable');
        return { path: file, sha256: bytesHash(reads.get(path.resolve(root, file))!) };
      });
    };
    const consumer = (kind: Consumer['kind'], id: string, entries: string[], dir: string): Consumer => {
      const { index, reach } = graph(dir);
      const closure = new Set<string>();
      for (const entry of entries) {
        if (!relativeFile(entry)) return fail('consumer-entry-invalid');
        const absolute = path.resolve(root, entry);
        if (sourceFile.test(absolute) && !index.deps.has(absolute)) return fail('consumer-entry-unindexed');
        closure.add(absolute);
        for (const dependency of reach(absolute)) closure.add(dependency);
      }
      for (const file of closure) {
        const text = read(file);
        if (text === null || index.unresolved.has(file) || hasUnknownModuleLoad(file, text ?? ''))
          return fail('consumer-graph-incomplete');
      }
      return { kind, id, inputs: identities(sorted([...closure].map(rel))) };
    };
    const consumers: Consumer[] = tasks.flatMap(task => {
      // Config/setup/reporting modules affect every test even though tests do not import them.
      const configs = inventory.filter(file => path.posix.dirname(file) === task.dir && runnerConfig.test(path.basename(file)));
      return task.files.map(file => consumer('test', file,
        sorted([file, ...configs, ...(input.testInputs?.[file] ?? [])]), task.dir));
    });
    for (const leg of input.legs) {
      if (typeof leg.id !== 'string' || !leg.id.trim() || leg.id.trim() !== leg.id)
        return fail('consumer-id-invalid');
      consumers.push(consumer('leg', leg.id, leg.entryFiles, leg.workspaceDir ?? '.'));
    }
    consumers.sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(consumers.map(entry => entry.id)).size !== consumers.length)
      return { status: 'unknown', reason: 'consumer-census-ambiguous' };
    const components: Partial<Record<ProofContextComponent, Component>> = {};
    for (const component of Object.keys(input.componentFiles).sort() as ProofContextComponent[]) {
      if (!PROOF_CONTEXT_COMPONENTS.includes(component) || component === 'selectionGraph') return fail('component-invalid');
      const inputs = identities(input.componentFiles[component]!);
      const scope = input.globalComponents?.includes(component) || ['submodules', 'dependencies',
        'compilerConfiguration', 'runtimeCapabilities', 'schema', 'behavior', 'population'].includes(component)
        ? 'global' as const : 'files' as const;
      const identity = component === 'source' ? createSourceByteSnapshot(inputs)?.sha256
        : digest([PROOF_CONTEXT_REACH_VERSION, component, inputs]);
      if (!identity) return fail('source-manifest-invalid');
      components[component] = { identity, inputs, scope };
    }
    const selectionIdentity = digest(canonical(selection, root));
    // The identity is the measured selector and complete consumer topology, not source bytes:
    // changing a leaf's contents without changing its consumers does not change the graph.
    const graphInputs = new Map(consumers.flatMap(row => row.inputs).map(file => [file.path, file]));
    components.selectionGraph = { scope: 'files',
      identity: digest([PROOF_CONTEXT_REACH_VERSION, selectionIdentity,
        consumers.map(row => [row.kind, row.id, row.inputs.map(file => file.path)])]),
      inputs: [...graphInputs.values()].sort((a, b) => a.path.localeCompare(b.path)) };
    // Detect concurrent writes rather than combining a graph from one tree with bytes from another.
    if (JSON.stringify(workspaceDirs) !== JSON.stringify(workspaceCensus())
      || JSON.stringify(inventory) !== JSON.stringify(sorted(listFilesIncludingUntracked(root).files as string[]))
      || [...reads].some(([file, bytes]) => !readFileSync(file).equals(bytes)))
      return { status: 'unknown', reason: 'source-changed-during-capture' };
    const body = { status: 'known' as const, schemaVersion: PROOF_CONTEXT_REACH_VERSION as typeof PROOF_CONTEXT_REACH_VERSION,
      selection: selectionIdentity, components, consumers };
    return { ...body, fingerprint: digest(body) };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'capture-failed' };
  }
}

function validCapture(value: ProofContextReachCapture): value is Extract<ProofContextReachCapture, { status: 'known' }> {
  try {
    if (!value || value.status !== 'known' || value.schemaVersion !== PROOF_CONTEXT_REACH_VERSION
      || !value.components || typeof value.components !== 'object' || Array.isArray(value.components)) return false;
    const { fingerprint, ...body } = value;
    const inputs = (files: FileIdentity[]) => Array.isArray(files) && files.length > 0
      && files.every(file => file && relativeFile(file.path) && typeof file.sha256 === 'string' && hashPattern.test(file.sha256))
      && new Set(files.map(file => file.path)).size === files.length;
    return typeof fingerprint === 'string' && hashPattern.test(fingerprint) && fingerprint === digest(body)
      && typeof value.selection === 'string' && hashPattern.test(value.selection)
      && Object.entries(value.components).every(([key, component]) => PROOF_CONTEXT_COMPONENTS.includes(key as ProofContextComponent)
        && component && ['files', 'global'].includes(component.scope) && typeof component.identity === 'string'
        && hashPattern.test(component.identity) && inputs(component.inputs))
      && Array.isArray(value.consumers) && value.consumers.length > 0 && value.consumers.every(row => row && ['test', 'leg'].includes(row.kind)
        && typeof row.id === 'string' && row.id.trim() === row.id && !!row.id && inputs(row.inputs))
      && new Set(value.consumers.map(row => row.id)).size === value.consumers.length;
  } catch { return false; }
}

export type ProofContextReachComparison = ProofContextComparison &
  ({ status: 'known'; reach: ProofContextReach[] } | { status: 'unknown'; reason: string });

/** Union OLD and NEW consumers. A deleted edge still invalidates its OLD consumer.
 * Use capture.components[k].identity in the existing before/after proof context. A transplant
 * from unrelated contexts, a mutated snapshot, or a missing mapping cannot grant narrow reuse.
 */
export function compareProofContextReach(input: { before: unknown; after: unknown;
  oldCapture: ProofContextReachCapture; newCapture: ProofContextReachCapture }): ProofContextReachComparison {
  const { before, after, oldCapture, newCapture } = input;
  // A consumer may pass this straight to proofContextImpact. Null the unqualified side so
  // equal but stale supplied identities cannot reinterpret an unknown graph as safe carry.
  const unknown = (reason: string): ProofContextReachComparison => ({ before, after: null, status: 'unknown', reason });
  const oldContext = readProofContextIdentity(before), newContext = readProofContextIdentity(after);
  if (!oldContext || !newContext || PROOF_CONTEXT_COMPONENTS.some(component =>
    oldContext.components[component] === null || newContext.components[component] === null))
    return unknown('proof-context-incomplete');
  const changed = PROOF_CONTEXT_COMPONENTS.filter(component =>
    oldContext.components[component] !== newContext.components[component]);
  if (!validCapture(oldCapture) || !validCapture(newCapture)) return unknown('reach-capture-incomplete');
  if (oldCapture.components.selectionGraph?.identity !== oldContext.components.selectionGraph
    || newCapture.components.selectionGraph?.identity !== newContext.components.selectionGraph)
    return unknown('reach-graph-identity-mismatch');
  if (!changed.length) return { before, after, status: 'known', reach: [] };
  if (JSON.stringify(oldCapture.consumers.map(row => [row.kind, row.id]))
    !== JSON.stringify(newCapture.consumers.map(row => [row.kind, row.id])))
    return unknown('reach-population-changed');
  const reach: ProofContextReach[] = [];
  for (const component of changed) {
    const oldInputs = oldCapture.components[component], newInputs = newCapture.components[component];
    if (!oldInputs || !newInputs) return unknown(`reach-component-unmapped:${component}`);
    if (oldInputs.identity !== oldContext.components[component] || newInputs.identity !== newContext.components[component])
      return unknown(`reach-component-identity-mismatch:${component}`);
    const oldFiles = new Map(oldInputs.inputs.map(file => [file.path, file.sha256]));
    const newFiles = new Map(newInputs.inputs.map(file => [file.path, file.sha256]));
    const paths = new Set(sorted([...oldFiles.keys(), ...newFiles.keys()])
      .filter(file => oldFiles.get(file) !== newFiles.get(file)));
    const consumers = [...oldCapture.consumers, ...newCapture.consumers];
    const global = oldInputs.scope === 'global' || newInputs.scope === 'global'
      || component === 'selectionGraph' && oldCapture.selection !== newCapture.selection;
    // An input absent from BOTH captured graphs is a hole, even when it is source-shaped:
    // loaders that static analysis cannot see must never turn it into known empty reach.
    if (!global && [...paths].some(file => !consumers.some(row => row.inputs.some(entry => entry.path === file))))
      return unknown(`reach-input-unmapped:${component}`);
    const affected = consumers.filter(row => global || row.inputs.some(file => paths.has(file.path)));
    reach.push({ schemaVersion: 'reach-v1', component, before: oldInputs.identity, after: newInputs.identity,
      provenance: { version: PROOF_CONTEXT_REACH_VERSION, before: oldCapture.fingerprint,
        after: newCapture.fingerprint, complete: true },
      tests: sorted(affected.filter(row => row.kind === 'test').map(row => row.id)),
      legs: sorted(affected.filter(row => row.kind === 'leg').map(row => row.id)) });
  }
  return { before, after, status: 'known', reach };
}

/** Convenience for the existing context producer; missing entries stay null, never invented. */
export function capturedProofContextComponents(capture: ProofContextReachCapture): Partial<ProofContextIdentity['components']> {
  return validCapture(capture) ? Object.fromEntries(Object.entries(capture.components)
    .map(([key, value]) => [key, value!.identity])) : {};
}
