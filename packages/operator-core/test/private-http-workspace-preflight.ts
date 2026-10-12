/** Registry preflight shared by standalone private HTTP workers and their cheap guard. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'esbuild';
import { ensureWorkspaceEntry, isKnownWorkspace } from '../lib/workspace-registry';
import { PANEL_LABELS, type PanelKey, type SystemHealth } from '../lib/system-health/types';
import { readVerifierSourceReceiptSync, verifierSourceFiles, type VerifierSourceFile } from '../lib/verifier-source';

/** Additional pins on the existing operator-api-preflight.json receipt. This
 * is preparation evidence, not proof that a host loaded or served the bundle.
 * The selected source/dependency/graph receipt must come from the independent
 * preparation phase; an in-process snapshot cannot certify its own selection.
 */
export interface CommittedReaderClosure {
  sourceCommit: string;
  sha256: string;
  metafileSha256: string;
  testPaths: string[];
  helperPaths: string[];
  configPaths: string[];
  executedImports: string[];
  dependencyFiles: VerifierSourceFile[];
  externalResolutions: Record<string, string>;
  copiedSources: string[];
  artifacts: { path: string; sha256: string; sourcePath?: string }[];
  schema: Record<string, string>;
  environment: Record<string, string>;
  omitted: string[];
  opaque: string[];
}

/** Qualify the selected committed preparation before creating a sidecar/host.
 * Source files reuse the independent full archive census. Dependencies remain
 * a separate full materialized census, including bytes and symlink identities;
 * a lockfile is never substituted for the files Node will resolve. Unknown
 * executed imports (including an unobserved subprocess graph) must be recorded
 * as opaque and refuse this required closure.
 */
export function qualifyCommittedReaderSource(o: {
  root: string; bundle: string; receiptPath: string; sourceReceiptPath: string;
  selectedCommit: string;
} & ({ preparationOnly: true } | {
  preparationOnly?: false; schema: Record<string, string>; environment: NodeJS.ProcessEnv;
})) {
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const inside = (root: string, path: string) => {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  assert.match(o.selectedCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.ok(!inside(o.root, o.receiptPath), 'Closure receipt must be independent of the source archive');
  const closure: CommittedReaderClosure = JSON.parse(readFileSync(o.receiptPath, 'utf8'));
  assert.equal(closure.sourceCommit, o.selectedCommit, 'Closure differs from selected committed source');
  const source = readVerifierSourceReceiptSync(o.root, o.sourceReceiptPath);
  assert.equal(source.sourceCommit, o.selectedCommit, 'Archive differs from selected committed source');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'copiedSources',
    'dependencyFiles', 'artifacts', 'omitted', 'opaque'] as const)
    assert.ok(Array.isArray(closure[key]), `Required closure dimension missing: ${key}`);
  for (const key of ['schema', 'environment', 'externalResolutions'] as const)
    assert.ok(closure[key] && typeof closure[key] === 'object' && !Array.isArray(closure[key]),
      `Required closure dimension missing: ${key}`);
  assert.deepEqual(closure.omitted, [], 'Required closure has omitted dimensions');
  assert.deepEqual(closure.opaque, [], 'Required closure has opaque dimensions');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'artifacts'] as const)
    assert.ok(closure[key].length, `Required closure dimension empty: ${key}`);
  const sourceFiles = new Map(source.files.map(file => [file.path, file]));
  const sourcePath = (path: string) => {
    assert.ok(path && !isAbsolute(path) && !path.split('/').some(part => !part || part === '.' || part === '..')
      && !path.includes('\\'), `Invalid closure source path: ${path}`);
    assert.ok(sourceFiles.has(path), `Required source is outside selected archive: ${path}`);
    assert.ok(inside(o.root, join(o.root, path)), `Required source resolves outside selected archive: ${path}`);
  };
  for (const input of source.testedInputs) {
    sourcePath(input.path);
    assert.equal(sourceFiles.get(input.path)!.sha256, input.sha256, `Tested input differs: ${input.path}`);
  }
  for (const path of [...closure.testPaths, ...closure.helperPaths, ...closure.configPaths,
    ...closure.executedImports, ...closure.copiedSources]) sourcePath(path);
  for (const path of closure.testPaths)
    assert.ok(source.testedInputs.some(input => input.path === path), `Test is absent from selected tested inputs: ${path}`);
  const dependencies = verifierSourceFiles(join(o.root, 'node_modules'));
  assert.deepEqual(dependencies, closure.dependencyFiles, 'Materialized dependency census differs');
  const dependencyFiles = new Set(dependencies.map(file => `node_modules/${file.path}`));
  const graphBytes = readFileSync(`${o.bundle}.meta.json`);
  assert.equal(digest(graphBytes), closure.metafileSha256, 'Prepared build graph changed');
  const graph = JSON.parse(String(graphBytes));
  assert.ok(graph.inputs && Object.keys(graph.inputs).length && graph.outputs && Object.keys(graph.outputs).length,
    'Complete prepared build graph is required');
  const externals = new Set<string>();
  const graphImports = new Set<string>();
  const graphPath = (path: string) => {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..'), `Build input escapes selected root: ${path}`);
    if (path.startsWith('node_modules/')) assert.ok(dependencyFiles.has(path), `Unpinned dependency input: ${path}`);
    else { sourcePath(path); graphImports.add(path); }
  };
  for (const [path, input] of Object.entries(graph.inputs) as [string, { imports?: { path: string; external?: boolean }[] }][]) {
    graphPath(path);
    assert.ok(Array.isArray(input.imports), `Build imports are unknown: ${path}`);
    for (const edge of input.imports!) {
      if (edge.external) { if (!isBuiltin(edge.path)) externals.add(edge.path); }
      else graphPath(edge.path);
    }
  }
  for (const output of Object.values(graph.outputs) as { imports?: { path: string; external?: boolean }[] }[]) {
    assert.ok(Array.isArray(output.imports), 'Build output imports are unknown');
    for (const edge of output.imports!) if (edge.external && !isBuiltin(edge.path)) externals.add(edge.path);
  }
  for (const path of graphImports)
    assert.ok(closure.executedImports.includes(path), `Build source is absent from observed import closure: ${path}`);
  assert.deepEqual(Object.keys(closure.externalResolutions).sort(), [...externals].sort(), 'External resolution census differs');
  const fromBundle = createRequire(o.bundle);
  for (const specifier of externals) {
    const actual = realpathSync(fromBundle.resolve(specifier));
    const expected = closure.externalResolutions[specifier];
    assert.ok(dependencyFiles.has(expected), `External lacks dependency pin: ${specifier}`);
    assert.equal(actual, realpathSync(join(o.root, expected)), `External resolution differs: ${specifier}`);
  }
  const artifactPaths = new Set<string>();
  for (const artifact of closure.artifacts) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Artifact digest is required');
    assert.ok(!artifactPaths.has(artifact.path), 'Duplicate artifact pin');
    artifactPaths.add(artifact.path);
    assert.ok(isAbsolute(artifact.path) && inside(dirname(o.bundle), artifact.path), 'Artifact escapes private preparation');
    assert.equal(digest(readFileSync(artifact.path)), artifact.sha256, `Prepared artifact changed: ${artifact.path}`);
  }
  assert.ok(artifactPaths.has(o.bundle) && artifactPaths.has(`${o.bundle}.meta.json`), 'Bundle and graph artifact pins are required');
  for (const path of closure.copiedSources) {
    const copies = closure.artifacts.filter(artifact => artifact.sourcePath === path);
    assert.ok(copies.length, `Copied source lacks retained artifact mapping: ${path}`);
    for (const copy of copies)
      assert.equal(copy.sha256, digest(readFileSync(join(o.root, path))), `Copied artifact differs from selected source: ${path}`);
  }
  assert.equal(digest(readFileSync(o.bundle)), closure.sha256, 'Prepared bundle changed');
  assert.ok(Object.keys(closure.schema).length && Object.keys(closure.environment).length,
    'Required private schema and environment pins are missing');
  for (const [key, expected] of Object.entries(closure.environment)) {
    assert.match(expected, /^[a-f0-9]{64}$/, `Environment digest missing: ${key}`);
    if (!o.preparationOnly) {
      assert.ok(o.environment[key] !== undefined, `Required private environment missing: ${key}`);
      assert.equal(digest(o.environment[key]!), expected, `Required private environment differs: ${key}`);
    }
  }
  if (!o.preparationOnly) assert.deepEqual(o.schema, closure.schema, 'Applied required private schema differs');
  return { sourceCommit: source.sourceCommit, sha256: closure.sha256, metafileSha256: closure.metafileSha256,
    checked: ['source', 'tested-inputs', 'build-imports', 'observed-imports', 'dependencies', 'externals',
      'config', 'copied-sources', 'artifacts',
      ...(!o.preparationOnly ? ['required-private-schema', 'required-environment'] : [])],
    pending: o.preparationOnly ? ['actual-private-schema', 'actual-private-environment', 'loaded-host'] : ['loaded-host'],
    omitted: closure.omitted, opaque: closure.opaque, hostStarted: false, httpStarted: false };
}

/** Complete, typed private Health seed; nullable data remains per-panel typed. */
export function createPrivateHealthSnapshot(workspaceId: string, foreign: boolean, evaluatedAt: number): SystemHealth {
  const panel = <K extends PanelKey>(key: K): SystemHealth['panels'][K] => ({ key, label: PANEL_LABELS[key],
    status: key === 'workItems' || key === 'plans' ? 'warn' : 'unknown',
    summary: foreign ? 'private-health-foreign' : key === 'workItems' ? 'private-health-selected'
      : key === 'plans' ? 'private-health-neighbor' : 'private-health-unmeasured',
    metrics: [], data: null,
    ...(key === 'workItems' ? { link: { label: 'Work', href: '/adv?tab=harnesses' } } : {}),
  });
  return { workspaceId, evaluatedAt, overall: 'warn', crossMonitor: { queenAlive: true, overwatchAlive: null }, panels: {
    queen: panel('queen'), bees: panel('bees'), workItems: panel('workItems'), workFeed: panel('workFeed'),
    loops: panel('loops'), tokens: panel('tokens'), watchdog: panel('watchdog'), deploy: panel('deploy'),
    plans: panel('plans'), escalations: panel('escalations'), autonomy: panel('autonomy'),
    observations: panel('observations'), improvements: panel('improvements'), infra: panel('infra'),
    suFleet: panel('suFleet'), coordination: panel('coordination'), overwatch: panel('overwatch'),
    scout: panel('scout'), memory: panel('memory'), toolEfficiency: panel('toolEfficiency'), contextInjection: panel('contextInjection'),
  } };
}

/** Read the same declared corpus as the real Docs API before allocating PG. */
export async function preparePrivateDocsBrowserDocuments(repoRoot: string, selection = {
  selectedDoc: 'branding.mdx', neighborDoc: 'index.mdx',
  selectedHeading: 'Classic Identity', neighborHeading: 'What this is',
}) {
  const { resolveDocsRoot, resolveDocsSources } = await import('../lib/endpoint-route/routes/harness/project-docs');
  const { readDocBody } = await import('../lib/harness/docs/doc-fs');
  const docsRoot = await resolveDocsRoot(repoRoot);
  const sources = await resolveDocsSources(repoRoot);
  const bodies: Record<string, string> = {};
  for (const [docId, heading] of [[selection.selectedDoc, selection.selectedHeading],
    [selection.neighborDoc, selection.neighborHeading]]) {
    const body = await readDocBody({ docsRoot, sources }, docId);
    assert.ok(body, `Private Docs target ${docId} has no body in the configured corpus`);
    assert.ok(body.split('\n').some(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, '').trim() === heading),
      `Private Docs target ${docId} lacks its expected heading ${heading}`);
    bodies[docId] = body;
  }
  return { selection, bodies, docsRoot, sourcePaths: ['.papercusp/docs.json',
    ...[selection.selectedDoc, selection.neighborDoc].map(docId => relative(repoRoot, join(docsRoot, docId)))] };
}

/** Match with-test-pg's six-character runtime allocation and the native fixture's
 * existing conservative socket limit before paying for PG startup/migrations. */
export function preparePrivateRosterSocketRoot(scratchRoot = tmpdir()) {
  assert.ok(isAbsolute(scratchRoot), 'Private roster scratch root must be absolute');
  const socket = join(scratchRoot, 'papercusp-test-runtime-XXXXXX', 'tmp', 'rs-XXXXXX', 'su-rs-123456789-neighbor.sock');
  assert.ok(Buffer.byteLength(socket) < 104,
    'Private roster scratch root exceeds native socket capacity; select a shorter task-owned TMPDIR before private PG');
  return socket;
}

/** Compile the native API before allocating PG, retaining the exact artifact
 * that the private worker will run instead of reading the shared graph again. */
export function preparePrivateOperatorApiBundle(root: string, evidenceDir: string, options?: {
  committedReader: { receiptPath: string; sourceReceiptPath: string; selectedCommit: string };
}) {
  // Match the child runtime's fail-closed evidence prerequisite before paying
  // for compilation. A missing reporter sink must not become a late PG failure.
  assert.ok(!(process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE?.trim()
    || process.env.PC_EXECUTED_SOURCE_MAP_RESULT?.trim()) || process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim(),
  'PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts');
  const selected = options?.committedReader;
  if (selected) {
    assert.match(selected.selectedCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
    assert.equal(readVerifierSourceReceiptSync(root, selected.sourceReceiptPath).sourceCommit,
      selected.selectedCommit, 'Archive differs from selected committed source');
    // Missing independent preparation must refuse before compilation/PG. Never
    // synthesize a closure from this process's own source/dependency snapshot.
    const closure: CommittedReaderClosure = JSON.parse(readFileSync(selected.receiptPath, 'utf8'));
    assert.equal(closure.sourceCommit, selected.selectedCommit, 'Closure differs from selected committed source');
    assert.deepEqual(closure.omitted, [], 'Required closure has omitted dimensions');
    assert.deepEqual(closure.opaque, [], 'Required closure has opaque dimensions');
  }
  const path = join(evidenceDir, 'hono-host.mjs');
  try {
    const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', path],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
    writeFileSync(join(evidenceDir, 'operator-api-build.log'), output);
  } catch (error: any) {
    writeFileSync(join(evidenceDir, 'operator-api-build.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  let receipt: { path: string; sha256: string; selectedSource?: {
    receiptPath: string; sha256: string; sourceCommit: string;
  } } = { path, sha256 };
  if (selected) {
    const qualification = qualifyCommittedReaderSource({ root, bundle: path, ...selected, preparationOnly: true });
    const sourceBytes = readFileSync(selected.sourceReceiptPath);
    const sourcePath = join(evidenceDir, 'verifier-source.json');
    writeFileSync(sourcePath, sourceBytes);
    receipt = { ...JSON.parse(readFileSync(selected.receiptPath, 'utf8')), path, sha256, qualification,
      selectedSource: { receiptPath: sourcePath, sha256: createHash('sha256').update(sourceBytes).digest('hex'),
        sourceCommit: selected.selectedCommit } };
  }
  const receiptBytes = JSON.stringify(receipt);
  writeFileSync(join(evidenceDir, 'operator-api-preflight.json'), receiptBytes);
  return { ...receipt, receiptSha256: createHash('sha256').update(receiptBytes).digest('hex') };
}

/** A worker may reuse only the artifact from its own original prepare phase. */
export function resolvePreparedPrivateApiBundle(argv: readonly string[], evidenceDir: string) {
  const values = argv.filter(value => value.startsWith('--prepared-api-sha='));
  if (!values.length) return undefined;
  assert.equal(values.length, 1, 'Pass exactly one prepared API digest');
  const sha256 = values[0].slice('--prepared-api-sha='.length);
  assert.match(sha256, /^[a-f0-9]{64}$/, 'Prepared API digest must be SHA256');
  const path = join(dirname(evidenceDir), 'prepare', 'hono-host.mjs');
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256,
    'Prepared private API changed after preflight');
  const receipts = argv.filter(value => value.startsWith('--prepared-receipt-sha='));
  if (receipts.length) {
    assert.equal(receipts.length, 1, 'Pass exactly one prepared receipt digest');
    const receiptSha256 = receipts[0].slice('--prepared-receipt-sha='.length);
    assert.match(receiptSha256, /^[a-f0-9]{64}$/, 'Prepared receipt digest must be SHA256');
    const receiptBytes = readFileSync(join(dirname(path), 'operator-api-preflight.json'));
    assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), receiptSha256,
      'Prepared private receipt changed after preflight');
    const receipt = JSON.parse(String(receiptBytes));
    assert.equal(receipt.path, path, 'Prepared private receipt names another artifact');
    assert.equal(receipt.sha256, sha256, 'Prepared private receipt names another digest');
  }
  return path;
}

/** Selected source crosses the sanitized child boundary through the parent's
 * pinned preparation receipt, never through an ambient selection default. */
export function resolvePreparedCommittedReaderSource(argv: readonly string[], evidenceDir: string) {
  assert.equal(argv.filter(value => value.startsWith('--prepared-receipt-sha=')).length, 1,
    'Committed reader requires one pinned preparation receipt');
  const bundle = resolvePreparedPrivateApiBundle(argv, evidenceDir);
  assert.ok(bundle, 'Committed reader requires an independently prepared pinned API');
  const receipt = JSON.parse(readFileSync(join(dirname(bundle), 'operator-api-preflight.json'), 'utf8'));
  const source = receipt.selectedSource;
  assert.ok(source && source.receiptPath === join(dirname(bundle), 'verifier-source.json'),
    'Committed reader requires the retained independent selected source receipt');
  assert.match(source.sourceCommit, /^[a-f0-9]{40}$/, 'Exact selected committed source is required');
  assert.equal(source.sourceCommit, receipt.sourceCommit, 'Prepared source selection differs');
  assert.equal(createHash('sha256').update(readFileSync(source.receiptPath)).digest('hex'), source.sha256,
    'Retained selected source receipt changed after preflight');
  return { sourceReceiptPath: source.receiptPath as string, selectedCommit: source.sourceCommit as string };
}

/** Isolated workers intentionally discard PAPERCUSP_* ambient settings.
 * Explicit readonly source selection travels in argv and is validated by the
 * parent BEFORE booting a runtime, then by the child before bundling its API. */
export function preparePortalBrowserSource(argv: readonly string[]) {
  const values = argv.filter(value => value.startsWith('--portal-source='));
  assert.equal(values.length, 1, 'Pass exactly one explicit --portal-source argument');
  const value = values[0].slice('--portal-source='.length);
  assert.ok(isAbsolute(value), 'Portal source must be an absolute maintained checkout path');
  const root = realpathSync(value);
  for (const file of ['packages/ui/src/agents-popover.tsx', 'app/tokens.css', 'app/globals.css',
    'node_modules/react/package.json', 'node_modules/react-dom/package.json']) {
    assert.ok(statSync(join(root, file)).isFile(), `Portal browser preflight requires ${file}`);
  }
  const fromPortal = createRequire(join(root, 'package.json'));
  for (const specifier of ['nuqs', 'nuqs/adapters/react']) {
    assert.ok(statSync(fromPortal.resolve(specifier)).isFile(), `Portal browser preflight requires ${specifier}`);
  }
  return root;
}

/** Resolve shared browser stores through one maintained package's exports map.
 * Directory aliases bypass adapter exports; duplicate installations split the
 * Nuqs and TanStack router contexts and Sonner's toast/Toaster observer. */
export function portalBrowserPackagesPlugin(portalSourceRoot: string): Plugin {
  const fromPortal = createRequire(join(realpathSync(portalSourceRoot), 'package.json'));
  return { name: 'portal-browser-package-exports', setup(builder) {
    builder.onResolve({ filter: /^(?:nuqs(?:\/.*)?|sonner|@tanstack\/react-router)$/ }, ({ path }) => ({ path: fromPortal.resolve(path) }));
  } };
}

/** Use the exact maintained Portal client boundary, including router and
 * server-only aliases. Do not duplicate the table in a fixture. */
export async function portalBrowserSurfaceBuild(portalSourceRoot: string, options: { standaloneRouter?: boolean } = {}) {
  const portal = realpathSync(portalSourceRoot);
  const root = resolve(import.meta.dirname, '../../..');
  const source = join(portal, 'apps/host/src/operator-surface-build.mjs');
  const { assertShimsResolvable, operatorSurfaceShims, operatorSurfaceImportMetaEnv, operatorSurfaceAliases } = await import(pathToFileURL(source).href);
  const shims: Array<{ pattern: RegExp; replacement: string }> = assertShimsResolvable(operatorSurfaceShims(root, portal));
  // The static private ADV fixture mounts the operator's real TanStack router,
  // while the Portal host mounts Next. Keep the native router-compat modules
  // for that fixture; all server-only boundaries still come from the registry.
  const activeShims = options.standaloneRouter ? shims.filter(shim => ![
    join(portal, 'apps/host/shims/router-compat-navigation.tsx'),
    join(portal, 'apps/host/shims/router-compat-link.tsx'),
  ].includes(shim.replacement)) : shims;
  const plugin: Plugin = { name: 'maintained-portal-surface-boundary', setup(builder) {
    for (const shim of activeShims) builder.onResolve({ filter: shim.pattern }, () => ({ path: shim.replacement }));
  } };
  // Prefix aliases are part of the same maintained boundary as the shims.
  // tsconfig paths preserve onResolve shim precedence and let esbuild resolve
  // directory barrels (e.g. the real Dev IPC transport) without fixture stubs.
  const paths: Record<string, string[]> = {};
  for (const [prefix, replacement] of Object.entries(operatorSurfaceAliases(root) as Record<string, string>)) {
    paths[prefix] = [replacement];
    paths[prefix + '/*'] = [replacement + '/*'];
  }
  return { plugin, paths, define: { 'import.meta.env': JSON.stringify(operatorSurfaceImportMetaEnv()) }, source };
}

export function preparePrivateHttpWorkspaces() {
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID ?? '';
  assert.match(workspace, /^test-runtime-/);
  const runtimeRoot = resolve(process.env.HOME ?? '', '..');
  assert.equal(process.env.PAPERCUSP_WORKSPACES_ROOT, join(runtimeRoot, 'workspaces'),
    'HTTP controls must use the disposable runtime registry');
  assert.equal(process.env.TMPDIR, join(runtimeRoot, 'tmp'),
    'HTTP controls must use the disposable runtime scratch');
  const foreignWorkspace = workspace + '-foreign';
  ensureWorkspaceEntry(workspace);
  ensureWorkspaceEntry(foreignWorkspace);
  assert.ok(isKnownWorkspace(workspace) && isKnownWorkspace(foreignWorkspace));
  return { workspace, foreignWorkspace };
}
