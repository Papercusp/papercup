/** Registry preflight shared by standalone private HTTP workers and their cheap guard. */
import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'esbuild';
import { ensureWorkspaceEntry, isKnownWorkspace } from '../lib/workspace-registry';

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
 * Nuqs context and Sonner's module-local toast/Toaster observer. */
export function portalBrowserPackagesPlugin(portalSourceRoot: string): Plugin {
  const fromPortal = createRequire(join(realpathSync(portalSourceRoot), 'package.json'));
  return { name: 'portal-browser-package-exports', setup(builder) {
    builder.onResolve({ filter: /^(?:nuqs(?:\/.*)?|sonner)$/ }, ({ path }) => ({ path: fromPortal.resolve(path) }));
  } };
}

/** Use the exact maintained Portal client boundary, including router and
 * server-only aliases. Do not duplicate the table in a fixture. */
export async function portalBrowserSurfaceBuild(portalSourceRoot: string, options: { standaloneRouter?: boolean } = {}) {
  const portal = realpathSync(portalSourceRoot);
  const root = resolve(import.meta.dirname, '../../..');
  const source = join(portal, 'apps/host/src/operator-surface-build.mjs');
  const { assertShimsResolvable, operatorSurfaceShims, operatorSurfaceImportMetaEnv } = await import(pathToFileURL(source).href);
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
  return { plugin, define: { 'import.meta.env': JSON.stringify(operatorSurfaceImportMetaEnv()) }, source };
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
