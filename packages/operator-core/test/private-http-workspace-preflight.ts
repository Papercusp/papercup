/** Registry preflight shared by standalone private HTTP workers and their cheap guard. */
import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { ensureWorkspaceEntry, isKnownWorkspace } from '../lib/workspace-registry';

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

/** Resolve every consumer through the same maintained package's exports map.
 * A directory alias bypasses exports for adapters and can split Nuqs context. */
export function portalNuqsPlugin(portalSourceRoot: string): Plugin {
  const fromPortal = createRequire(join(realpathSync(portalSourceRoot), 'package.json'));
  return { name: 'portal-nuqs-package-exports', setup(builder) {
    builder.onResolve({ filter: /^nuqs(?:\/|$)/ }, ({ path }) => ({ path: fromPortal.resolve(path) }));
  } };
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
