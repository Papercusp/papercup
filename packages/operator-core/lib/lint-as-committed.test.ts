/**
 * Tests for the as-committed lint runner (scripts/lint-as-committed.mjs,
 * EI-18672078222841101).
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE
 * The tool exists because `npm run lint:x` silently answers a different question than
 * the release gate asks, and returns a confident green either way. So the load-bearing
 * property is NOT "it runs a lint" — it is that this tool CANNOT ITSELF report a green
 * for a lint it did not actually run. Every path where a lint is not executed
 * (absent at the ref, the run itself errored) must be a FAILURE, never a skip.
 *
 * If a future edit ever turns `missing` or `error` into a skip, this tool becomes the
 * very bug it was built to remove — a fast, confident, wrong green — so those are the
 * negative controls below, not the happy path.
 *
 * The end-to-end behaviour (extract a tree, symlink node_modules, spawn npm) is
 * deliberately NOT unit-tested: mocking it would assert the mock. It is verified by
 * running the real thing against this repo.
 *
 * ONE EXCEPTION TO THAT (EI-21033860565861795): the submodule-materialisation step
 * below IS run end-to-end, against a real spawn of the CLI and local Git repos, because the bug it
 * regresses is exactly the kind a mock cannot see — `git clone --no-checkout` +
 * `checkout --detach` leaves a submodule (for example `libs/papercusp`)
 * as an EMPTY gitlink directory, and a lint that resolves an import through one
 * fabricated a TS2307 that the committed code does not actually have. Asserting the
 * extracted tree's submodule file byte-matches the COMMITTED content is the only way
 * to prove the fix; a unit test over `parseGitmodules` alone would prove the parser
 * works and say nothing about whether the tree it feeds actually gets materialised.
 */
import { execFileSync, spawnSync, spawn, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceRootFrom } from '@papercusp/test-config/admin-test-runs-reporter';
import { createRetentionPin, removeRetentionPin } from './storage/retention-pins';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, '../../../scripts/lint-as-committed.mjs');
const repoRoot = resolve(here, '../../..');

// These CLI tests exercise this implementation, including uncommitted repairs.
// The runner still selects committed fixture content itself; substituting an
// older runner in the child would mix two implementations in one verdict.
function currentRunnerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const loader = `--import=${resolve(repoRoot, 'scripts/lib/committed-source-loader.mjs')}`;
  env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').split(/\s+/)
    .filter(option => option !== loader).join(' ');
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return env;
}

// Preserve process-level evidence on EVERY attempt, including a second probe
// after a successful command. A null status alone cannot distinguish startup,
// import, admission, callback, cleanup, or process termination.
function fixtureProcessEvidence(run: SpawnSyncReturns<string>, startedAt: number) {
  return {
    elapsedMs: Date.now() - startedAt,
    status: run.status,
    signal: run.signal,
    error: run.error ? { message: run.error.message, code: (run.error as NodeJS.ErrnoException).code } : null,
    stdoutTail: run.stdout?.slice(-2000) ?? '',
    stderrTail: run.stderr?.slice(-4000) ?? '',
  };
}

function fixtureNpmLogs(logs: string) {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).filter(name => name.endsWith('.log') || name.endsWith('-timing.json'))
    .map(name => ({ name, tail: readFileSync(join(logs, name), 'utf8').slice(-6000) }));
}

describe('fixture subprocess evidence', () => {
  it('retains termination and import milestones from a later failing writer attempt', () => {
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      "console.log('WRITER_STARTED'); await import('node:fs'); console.log('WRITER_IMPORTED'); process.exit(7);"],
    { encoding: 'utf8', timeout: 5000 });
    const evidence = fixtureProcessEvidence(run, started);
    expect(evidence).toMatchObject({ status: 7, signal: null, error: null });
    expect(evidence.stdoutTail).toContain('WRITER_STARTED');
    expect(evidence.stdoutTail).toContain('WRITER_IMPORTED');
    expect(evidence.stdoutTail).not.toContain('WRITER_ACQUIRED');
    expect(evidence.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('retains the process error when no child could enter its operation', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-process-evidence-'));
    try {
      const started = Date.now();
      const run = spawnSync(join(root, 'missing-node'), [], { encoding: 'utf8', timeout: 5000 });
      expect(fixtureProcessEvidence(run, started)).toMatchObject({
        status: null, signal: null, error: { code: 'ENOENT' }, stdoutTail: '', stderrTail: '',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains npm timing JSON as well as debug logs before fixture cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-npm-evidence-'));
    try {
      writeFileSync(join(root, 'attempt-debug-0.log'), 'verbose cli entered');
      writeFileSync(join(root, 'attempt-timing.json'), JSON.stringify({
        timers: { 'npm:load': 12 }, unfinishedTimers: { 'command:ls': [12, 15_000] },
      }));
      const evidence = fixtureNpmLogs(root);
      expect(evidence).toEqual(expect.arrayContaining([
        { name: 'attempt-debug-0.log', tail: 'verbose cli entered' },
        { name: 'attempt-timing.json', tail: expect.stringContaining('"command:ls"') },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

type PublicDocsViteConfig = {
  resolve?: { preserveSymlinks?: boolean };
  plugins?: Array<{
    name: string;
    enforce?: string;
    resolveId: (this: unknown, id: string, importer?: string) => string | null | { id: string } | Promise<string | null | { id: string }>;
  }>;
};

async function readPublicDocsModule(): Promise<{
  default: { vite?: PublicDocsViteConfig };
  normalizeExternalAstroModuleIds: (projectRoot?: string) => NonNullable<PublicDocsViteConfig['plugins']>[number];
}> {
  const configPath = resolve(repoRoot, 'apps/papercusp-docs/astro.config.mjs');
  // Use the producer's maintained Vite fallback, retaining named exports so
  // shallow/persistent path assertions exercise the same resolver factory.
  // Direct Vitest imports transform the whole Starlight graph and bypass
  // Astro's fallback for .jsonc themes (EI-25875124368917949).
  const [{ createMinimalViteDevServer }, { default: loadFallbackPlugin }] = await Promise.all([
    import(resolve(repoRoot, 'node_modules/astro/dist/core/createMinimalViteDevServer.js')),
    import(resolve(repoRoot, 'node_modules/astro/dist/vite-plugin-load-fallback/index.js')),
  ]);
  const server = await createMinimalViteDevServer(
    loadFallbackPlugin({ root: pathToFileURL(dirname(configPath)) }),
  );
  try {
    return await server.environments.ssr.runner.import(configPath);
  } finally {
    await server.close();
  }
}

const mod = await import(scriptPath);
describe('selected workspace lock objects', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function metadataFixture() {
    const root = mkdtempSync(join(tmpdir(), 'selected-lock-'));
    roots.push(root);
    const child = join(root, 'apps/app');
    mkdirSync(child, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const init = (cwd: string) => {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.name', 'fixture');
      git(cwd, 'config', 'user.email', 'fixture@example.test');
      git(cwd, 'config', 'core.hooksPath', '/dev/null');
    };
    const commit = (cwd: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', 'metadata'); return git(cwd, 'rev-parse', 'HEAD'); };
    init(child);
    writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '1.0.0' } }));
    const pin = commit(child);
    init(root);
    writeFileSync(join(root, '.gitmodules'), '[submodule "app"]\n path = apps/app\n url = ./apps/app\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'apps/app': { dependencies: { next: version } } } });
    writeFileSync(join(root, 'package-lock.json'), lock('1.0.0'));
    const base = commit(root);
    writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '2.0.0' } }));
    commit(child);
    return { root, child, git, lock, base, pin };
  }
  it('inspects commits and exact private trees using pinned child bytes and typed controllers', () => {
    const f = metadataFixture();
    expect(mod.inspectSelectedWorkspaceLock(f.root, { oid: f.base, kind: 'commit' }).ok).toBe(true);
    writeFileSync(join(f.root, 'package-lock.json'), f.lock('2.0.0'));
    f.git(f.root, 'add', 'package-lock.json');
    const tree = f.git(f.root, 'write-tree');
    const result = mod.inspectSelectedWorkspaceLock(f.root, { oid: tree, kind: 'tree' });
    expect(result).toMatchObject({ ok: false, selectedOid: tree, treeOid: tree, errors: [], mismatches: [{
      code: 'workspace-lock-mismatch', lockfile: 'package-lock.json', manifest: 'apps/app/package.json',
      field: 'dependencies', differences: { next: { manifest: '1.0.0', lock: '2.0.0' } },
      controllingPaths: ['.gitmodules', 'apps/app'],
    }] });
    expect(result.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'gitlink', path: 'apps/app', oid: f.pin })]));
    expect(f.git(f.child, 'show', 'HEAD:package.json')).toContain('2.0.0');
    expect(() => mod.assertCommittedWorkspaceLockMatches(f.root, f.base)).not.toThrow();
  });
  it('rejects wrong object kinds, annotated tags and missing objects', () => {
    const f = metadataFixture();
    const tree = f.git(f.root, 'rev-parse', 'HEAD^{tree}');
    const blob = f.git(f.root, 'rev-parse', 'HEAD:package.json');
    f.git(f.root, 'tag', '-a', 'selected-tag', '-m', 'tag');
    for (const oid of [tree, blob, 'selected-tag'])
      expect(() => mod.inspectSelectedWorkspaceLock(f.root, { oid, kind: 'commit' })).toThrow(/object type mismatch/);
    expect(() => mod.inspectSelectedWorkspaceLock(f.root, { oid: '1'.repeat(40), kind: 'tree' })).toThrow();
    // The established commit wrapper retains its commit-ish CLI compatibility.
    expect(() => mod.assertCommittedWorkspaceLockMatches(f.root, 'selected-tag')).not.toThrow();
  });
  it.each(['mapping', 'object'])('fails closed for a missing recursive %s', defect => {
    const f = metadataFixture();
    if (defect === 'mapping') f.git(f.root, 'update-index', '--force-remove', '.gitmodules');
    else f.git(f.root, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},apps/app`);
    const tree = f.git(f.root, 'write-tree');
    expect(() => mod.inspectSelectedWorkspaceLock(f.root, { oid: tree, kind: 'tree' })).toThrow();
  });
});
describe('committed focused runner dependency preflight', () => {
  it.each(['missing-export', 'missing-target'])
    ('rejects %s from the parent gitlink even when the working submodule has the dependency', async defect => {
      const root = mkdtempSync(join(tmpdir(), 'committed-runner-import-'));
      const child = join(root, 'libs/test-config');
      const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const commit = (cwd: string, message: string) => {
        gitAt(cwd, 'add', '.');
        gitAt(cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--quiet', '-m', message);
        return gitAt(cwd, 'rev-parse', 'HEAD');
      };
      try {
        mkdirSync(join(child, 'src'), { recursive: true });
        gitAt(child, 'init', '--quiet');
        const subpath = './new-runner-helper';
        const manifest = { name: '@papercusp/test-config', exports: {} as Record<string, unknown> };
        if (defect === 'missing-target') manifest.exports[subpath] = './src/helper.mjs';
        writeFileSync(join(child, 'package.json'), JSON.stringify(manifest));
        const oldPin = commit(child, 'old dependency');
        manifest.exports[subpath] = './src/helper.mjs';
        writeFileSync(join(child, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(child, 'src/helper.mjs'), 'export const helper = true;\n');
        const newPin = commit(child, 'new dependency available only in working child');

        gitAt(root, 'init', '--quiet');
        mkdirSync(join(root, 'scripts'));
        writeFileSync(join(root, '.gitmodules'),
          '[submodule "test-config"]\n path = libs/test-config\n url = ./libs/test-config\n');
        writeFileSync(join(root, 'scripts/test-files.mjs'),
          "import { helper } from '@papercusp/test-config/new-runner-helper';\n" +
          "// import '@papercusp/test-config/comment-only';\n" +
          "throw new Error('runner must not be evaluated by preflight');\n");
        gitAt(root, 'add', '.gitmodules', 'scripts/test-files.mjs');
        gitAt(root, 'update-index', '--add', '--cacheinfo', `160000,${oldPin},libs/test-config`);
        gitAt(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--quiet', '-m', 'runner with old dependency pin');
        expect(gitAt(child, 'rev-parse', 'HEAD')).toBe(newPin);
        await expect(mod.assertCommittedFocusedRunnerImports(root)).rejects.toThrow(
          /committed focused runner dependency preflight failed.*new-runner-helper/);

        gitAt(root, 'update-index', '--cacheinfo', `160000,${newPin},libs/test-config`);
        gitAt(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--quiet', '-m', 'align dependency pin');
        await expect(mod.assertCommittedFocusedRunnerImports(root)).resolves.toEqual([
          '@papercusp/test-config/new-runner-helper',
        ]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
describe('committed reporter database route', () => {
  it('carries the original operator route when the frozen tree omits ignored configuration', () => {
    const original = mkdtempSync(join(tmpdir(), 'committed-ledger-route-'));
    try {
      mkdirSync(join(original, 'apps/operator'), { recursive: true });
      writeFileSync(join(original, 'apps/operator/.env.local'),
        'DATABASE_URL=postgres://fixture:fixture@127.0.0.1:15432/canonical\nUNRELATED_SECRET=must-not-carry\n');
      const child = mod.lintAsCommittedChildEnv({}, original);
      expect(child.DATABASE_URL).toBe('postgres://fixture:fixture@127.0.0.1:15432/canonical');
      expect(child).not.toHaveProperty('UNRELATED_SECRET');
      expect(mod.lintAsCommittedChildEnv({ DATABASE_URL: 'postgres://explicit' }, original).DATABASE_URL)
        .toBe('postgres://explicit');
      for (const isolation of [{ PAPERCUSP_PG_PORT: '25432' }, { PAPERCUSP_SKIP_PG_DISCOVERY: '1' }]) {
        expect(mod.lintAsCommittedChildEnv(isolation, original)).not.toHaveProperty('DATABASE_URL');
      }
    } finally { rmSync(original, { recursive: true, force: true }); }
  });

  it('requires an explicit reporter sink and pins a receipt file for test:file', () => {
    const receiptFile = join(tmpdir(), 'committed-test-run-receipts.jsonl');
    expect(() => mod.lintAsCommittedChildEnv({
      DATABASE_URL: 'postgres://product.invalid',
      HARNESS_ADMIN_DATABASE_URL: 'postgres://temporary.invalid',
    }, null, receiptFile)).toThrow(/PAPERCUSP_TEST_RUNS_DB_URL/);

    const preparedRootReceiptFile = join(tmpdir(), 'committed-prepared-root.json');
    const child = mod.lintAsCommittedChildEnv({
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://ledger.invalid',
    }, null, receiptFile, preparedRootReceiptFile);
    expect(child.PAPERCUSP_TEST_RUNS_DB_URL).toBe('postgres://ledger.invalid');
    expect(child.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBe(receiptFile);
    expect(child.PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT).toBe(preparedRootReceiptFile);
    expect(mod.lintAsCommittedChildEnv({
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://ledger.invalid',
      PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT: '/inherited/stale-receipt.json',
    }, null, receiptFile).PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT).toBeUndefined();
  });

  it('carries the persistent generation store into nested committed verifiers', () => {
    const original = mkdtempSync(join(tmpdir(), 'committed-generation-route-'));
    const store = join(original, 'persistent-store');
    const override = join(original, 'explicit-store');
    try {
      mkdirSync(join(original, '.papercusp'));
      writeFileSync(join(original, '.papercusp/dependency-generation-root'), store + '\n/previous/store\n');
      const child = mod.lintAsCommittedChildEnv({}, original);
      expect(child.PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe(store);
      const nested = mod.lintAsCommittedChildEnv(child);
      expect(nested.PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe(store);
      expect(mod.lintAsCommittedChildEnv({ PAPERCUSP_DEPENDENCY_GENERATION_ROOT: override }, original)
        .PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe(override);
      rmSync(join(original, '.papercusp/dependency-generation-root'));
      expect(mod.lintAsCommittedChildEnv({}, original).PAPERCUSP_DEPENDENCY_GENERATION_ROOT)
        .toBe(join(original, '.papercusp/dependency-generations'));
    } finally { rmSync(original, { recursive: true, force: true }); }
  });

  it('retains failed test:file receipts for diagnosis and reuses the stale-root sweep for cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lint-as-committed-receipt-retention-'));
    const receiptDir = mkdtempSync(join(root, `${mod.WORK_ROOT_PREFIX}receipts-`));
    const receiptFile = join(receiptDir, 'receipts.jsonl');
    const receipt = '{"outcome":"timeout","reason":"pg_insert_timeout_25000ms"}\n';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(receiptFile, receipt, { mode: 0o600 });
      expect(mod.finalizeTestReceiptDir(receiptDir, { status: 1, signal: null, error: null }))
        .toEqual({ retained: true, path: receiptDir });
      expect(readFileSync(receiptFile, 'utf8')).toBe(receipt);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`retained at ${receiptDir}`));

      const successDir = mkdtempSync(join(root, `${mod.WORK_ROOT_PREFIX}receipts-success-`));
      expect(mod.finalizeTestReceiptDir(successDir, { status: 0, signal: null, error: null }))
        .toEqual({ retained: false });
      expect(existsSync(successDir)).toBe(false);

      const swept = await mod.sweepStaleWorkRoots({
        root,
        nowMs: Date.now() + mod.KEEP_TTL_MS + 60_000,
        cwds: [],
        maxIdleKept: 0,
      });
      expect(swept.removed).toContainEqual({
        name: receiptDir.slice(root.length + 1),
        reason: 'unmarked-expired',
      });
      expect(existsSync(receiptDir)).toBe(false);
    } finally {
      errorSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a private prepared-root receipt bound to HEAD and its owner marker', () => {
    const parent = mkdtempSync(join(tmpdir(), 'committed-prepared-root-'));
    const root = join(parent, 'source');
    try {
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['init', '--quiet', root]);
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--allow-empty', '--quiet', '-m', 'prepared source'], { cwd: root });
      const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const markerPath = join(root, '.git', 'lint-as-committed-owner.json');
      const marker = JSON.stringify({ pid: process.pid, keep: false, createdAtMs: Date.now(), sha: sourceCommit });
      writeFileSync(markerPath, marker);
      const receiptPath = join(parent, 'prepared-root.json');

      expect(mod.writePreparedWorkRootReceipt(root, sourceCommit, receiptPath)).toBe(receiptPath);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt).toEqual({
        schemaVersion: 'lint-as-committed-prepared-root-v1',
        root,
        sourceCommit,
        ownerMarkerSha256: createHash('sha256').update(marker).digest('hex'),
      });
      expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
      expect(() => mod.writePreparedWorkRootReceipt(root, sourceCommit, join(root, 'prepared-root.json')))
        .toThrow('prepared work-root receipt must be outside the committed source root');
      const original = readFileSync(receiptPath, 'utf8');
      expect(() => mod.writePreparedWorkRootReceipt(root, sourceCommit, receiptPath)).toThrow();
      expect(readFileSync(receiptPath, 'utf8')).toBe(original);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  // WI-6554700010012470: a kept clone reused WITHOUT lintAsCommittedChildEnv (mutation-probe's
  // overlay, a direct test:file in the root) must still route to the operator database. The
  // failing consumer was connection.ts (getOrgPg) via the box-wide discovery file, so the
  // round-trip below is through connection.ts's own resolver, not pg-url's parser.
  it('materializes only the operator DB pins into the clone, in a form connection.ts resolves', () => {
    const parent = mkdtempSync(join(tmpdir(), 'committed-db-route-'));
    try {
      const original = join(parent, 'original');
      const clone = join(parent, 'clone');
      mkdirSync(join(original, 'apps/operator'), { recursive: true });
      mkdirSync(clone, { recursive: true });
      writeFileSync(join(original, 'apps/operator/.env.local'),
        'DATABASE_URL="postgres://fixture:fixture@127.0.0.1:15432/canonical"\nUNRELATED_SECRET=must-not-carry\n');
      const target = join(clone, 'apps/operator/.env.local');
      expect(mod.materializeOperatorDbRoute(original, clone)).toEqual({ path: target, names: ['DATABASE_URL'] });
      const written = readFileSync(target, 'utf8');
      expect(written).toContain('DATABASE_URL=postgres://fixture:fixture@127.0.0.1:15432/canonical');
      expect(written).not.toContain('UNRELATED_SECRET');
      expect(lstatSync(target).mode & 0o777).toBe(0o600);

      const env: NodeJS.ProcessEnv = { ...process.env, ROUTE_FILE: target };
      for (const name of ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL',
        'PAPERCUSP_PG_PORT', 'PAPERCUSP_SKIP_PG_DISCOVERY']) delete env[name];
      const probe = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { _resolveUrlsForTests } from '@papercusp/db-org/connection';" +
        ' const u = new URL(_resolveUrlsForTests(process.env.ROUTE_FILE).admin);' +
        ' console.log(JSON.stringify({ host: u.hostname, port: u.port, database: u.pathname }));'],
        { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout.trim().split('\n').at(-1) ?? 'null'))
        .toEqual({ host: '127.0.0.1', port: '15432', database: '/canonical' });

      const bare = join(parent, 'bare');
      mkdirSync(join(bare, 'apps/operator'), { recursive: true });
      writeFileSync(join(bare, 'apps/operator/.env.local'), 'UNRELATED_SECRET=x\n');
      expect(mod.materializeOperatorDbRoute(bare, join(parent, 'clone2'))).toBeNull();
      expect(existsSync(join(parent, 'clone2/apps/operator/.env.local'))).toBe(false);
      expect(mod.materializeOperatorDbRoute(join(parent, 'missing'), join(parent, 'clone3'))).toBeNull();
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
describe('committed workspace selection', () => {
  const manifestPath = (workspace?: string) => mod.workspaceManifestPath(workspace);
  it('selects a workspace manifest without changing root defaults', () => {
    expect(manifestPath()).toBe('package.json');
    expect(manifestPath('apps/sidecar')).toBe('apps/sidecar/package.json');
    expect(mod.parseArgs(['test', '--any', '--workspace=apps/sidecar'])).toMatchObject({
      scripts: ['test'], any: true, workspace: 'apps/sidecar', unknown: [],
    });
    expect(mod.parseArgs(['lint:probe'])).not.toHaveProperty('workspace');
  });
  it.each(['', '../sidecar', '/tmp/sidecar', 'apps/../sidecar', 'apps//sidecar', 'C:/sidecar'])
    ('refuses a selector outside the pinned directory contract: %s', (workspace) => {
      expect(() => manifestPath(workspace)).toThrow('repository-relative directory');
    });
});
const {
  parseArgs,
  detectorPathsFromCommand,
  parseGitmodules,
  planLinkExcludes,
  writeLinkExcludes,
  cloneWorkspaceTarget,
  linkNodeModulesShadow,
  lintAsCommittedChildEnv,
  materializeMobileSourceContract,
  owningSubmodule,
  showAtRef,
  summarize,
  isDirectCliInvocation,
  diagnoseNpmSwallow,
} = mod as {
  diagnoseNpmSwallow: (
    parsed: unknown,
    env?: Record<string, string | undefined>,
  ) => {
    viaNpm: boolean;
    swallowedFlags: string[];
    pathOperands: string[];
    anyInferred: boolean;
    correctedCommand: string;
  } | null;
  cloneWorkspaceTarget: (realTarget: unknown, repoRoot: unknown, workRoot: unknown) => string | null;
  linkNodeModulesShadow: (
    sharedNm: string,
    cloneNm: string,
    repoRoot: string,
    workRoot: string,
  ) => { entries: number; remapped: number; fallback: number };
  lintAsCommittedChildEnv: (environment?: Record<string, string | undefined>, repoRoot?: string | null) => Record<string, string | undefined>;
  materializeMobileSourceContract: (
    repoRoot: string,
    workRoot: string,
    environment?: Record<string, string | undefined>,
  ) => { root: string; sourceRepoRoot: string; sourceCommit: string; paths: string[] } | null;
  owningSubmodule: (path: string, submodulePaths: unknown) => string | null;
  showAtRef: (repoRoot: string, ref: string, path: string) => string | null;
  parseArgs: (argv: string[]) => {
    help: boolean;
    scripts: string[];
    forward: string[];
    ref: string;
    keep: boolean;
    any: boolean;
    unknown: string[];
    nonLint?: string[];
    selfRecursive?: string[];
    forwardAmbiguous?: boolean;
    workspaceDirs?: string[];
    checkErrors?: string[];
  };
  detectorPathsFromCommand: (command: unknown) => string[];
  parseGitmodules: (text: unknown) => { name: string; path: string; url: string | null }[];
  planLinkExcludes: (linkedPaths: unknown, submodulePaths: unknown) => Record<string, string[]>;
  writeLinkExcludes: (workRoot: string, excludePlan: Record<string, string[]>) => void;
  summarize:(results: { script: string; status: string; note?: string }[]) => {
    exitCode: number;
    failedCount: number;
    lines: string[];
  };
  isDirectCliInvocation: (entryPath?: string) => boolean;
};

describe('committed mobile producer source contract (WI-10006121)', () => {
  const sourcePath = 'tools/build-scripts/build-android.sh';

  function withFixture(run: (fixture: { parent: string; source: string; repo: string; clone: string; sha: string }) => void) {
    const parent = mkdtempSync(join(tmpdir(), 'lac-mobile-source-'));
    const source = join(parent, 'papercup-rust-mobile');
    const repo = join(parent, 'papercusp');
    const clone = join(parent, 'isolated', 'candidate');
    mkdirSync(source);
    mkdirSync(repo);
    mkdirSync(clone, { recursive: true });
    const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: source, input, encoding: 'utf8' }).trim();
    try {
      git(['init', '--quiet', '--initial-branch=staging']);
      const blob = git(['hash-object', '-w', '--stdin'], 'committed Android producer\n');
      git(['update-index', '--add', '--cacheinfo', '100644', blob, sourcePath]);
      const tree = git(['write-tree']);
      const sha = git(['-c', 'user.name=Runner fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'mobile contract fixture']);
      git(['update-ref', 'refs/heads/staging', sha]);
      mkdirSync(dirname(join(source, sourcePath)), { recursive: true });
      writeFileSync(join(source, sourcePath), 'dirty Android producer\n');
      run({ parent, source, repo, clone, sha });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }

  it('copies the committed sibling blob and records its independent source commit', () => {
    withFixture(({ source, repo, clone, sha }) => {
      const snapshot = materializeMobileSourceContract(repo, clone, {});
      expect(snapshot).not.toBeNull();
      expect(readFileSync(join(snapshot!.root, sourcePath), 'utf8')).toBe('committed Android producer\n');
      expect(snapshot!.sourceRepoRoot).toBe(realpathSync(source));
      expect(snapshot!.sourceCommit).toBe(sha);
      expect(JSON.parse(readFileSync(join(snapshot!.root, 'source-provenance.json'), 'utf8'))).toEqual({
        schemaVersion: 1, sourceRepoRoot: realpathSync(source), sourceCommit: sha, paths: [sourcePath],
      });
      expect(readFileSync(join(source, sourcePath), 'utf8')).toBe('dirty Android producer\n');
    });
  });

  it('honors the existing explicit mobile root outside the candidate parent', () => {
    withFixture(({ source, clone, sha }) => {
      const snapshot = materializeMobileSourceContract(join(clone, 'unrelated'), clone, { PAPERCUSP_MOBILE_ROOT: source });
      expect(snapshot!.sourceCommit).toBe(sha);
      expect(readFileSync(join(snapshot!.root, sourcePath), 'utf8')).toBe('committed Android producer\n');
    });
  });

  it('keeps a nested snapshot on its recorded commit after the original HEAD moves', () => {
    withFixture(({ source, repo, clone, parent, sha }) => {
      const first = materializeMobileSourceContract(repo, clone, {})!;
      // Neither a loose snapshot edit nor a newer original commit is the input
      // identified by the inherited source-provenance record.
      writeFileSync(join(first.root, sourcePath), 'tampered snapshot\n');
      const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: source, input, encoding: 'utf8' }).trim();
      const blob = git(['hash-object', '-w', '--stdin'], 'newer committed producer\n');
      git(['update-index', '--cacheinfo', '100644', blob, sourcePath]);
      const tree = git(['write-tree']);
      const newer = git(['-c', 'user.name=Runner fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', sha, '-m', 'newer producer']);
      git(['update-ref', 'refs/heads/staging', newer]);
      const nested = materializeMobileSourceContract(repo, join(parent, 'nested'), { PAPERCUSP_MOBILE_ROOT: first.root })!;
      expect(newer).not.toBe(sha);
      expect(nested.sourceCommit).toBe(sha);
      expect(readFileSync(join(nested.root, sourcePath), 'utf8')).toBe('committed Android producer\n');
    });
  });

  it('refuses an explicit missing source instead of silently using a sibling', () => {
    withFixture(({ repo, clone, parent }) => {
      expect(() => materializeMobileSourceContract(repo, clone, { PAPERCUSP_MOBILE_ROOT: join(parent, 'absent') })).toThrow('explicit mobile source root is missing');
    });
  });

  it('refuses a source contract absent at HEAD rather than copying a dirty file', () => {
    withFixture(({ repo, clone, source }) => {
      execFileSync('git', ['update-index', '--force-remove', sourcePath], { cwd: source });
      const tree = execFileSync('git', ['write-tree'], { cwd: source, encoding: 'utf8' }).trim();
      const sha = execFileSync('git', ['-c', 'user.name=Runner fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'missing source'], { cwd: source, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-ref', 'refs/heads/staging', sha], { cwd: source });
      expect(() => materializeMobileSourceContract(repo, clone, {})).toThrow('is absent at');
      expect(existsSync(join(source, sourcePath))).toBe(true);
    });
  });

  it('leaves repositories without a mobile sibling available for ordinary checks', () => {
    const parent = mkdtempSync(join(tmpdir(), 'lac-without-mobile-'));
    try {
      expect(materializeMobileSourceContract(join(parent, 'repo'), join(parent, 'clone'), {})).toBeNull();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('isolated clone module identity (EI-24824919200711849)', () => {
  it('shares committed verdict storage across source clones without sharing another repository cache', () => {
    const parent = mkdtempSync(join(tmpdir(), 'lac-verdict-origin-'));
    try {
      const first = join(parent, 'first');
      const second = join(parent, 'second');
      const alias = join(parent, 'alias');
      mkdirSync(first);
      mkdirSync(second);
      symlinkSync(first, alias, 'dir');
      const sourceEnv = { EXAMPLE: 'kept' };
      const a = lintAsCommittedChildEnv(sourceEnv, first);
      const b = lintAsCommittedChildEnv(sourceEnv, alias);
      const c = lintAsCommittedChildEnv(sourceEnv, second);
      expect(a.AFFECTED_TASK_VERDICT_CACHE_PATH).toBe(b.AFFECTED_TASK_VERDICT_CACHE_PATH);
      expect(a.AFFECTED_TASK_VERDICT_CACHE_PATH).not.toBe(c.AFFECTED_TASK_VERDICT_CACHE_PATH);
      expect(a.AFFECTED_TASK_VERDICT_CACHE_PATH).toMatch(/passing-verdicts-v2-committed-[a-f0-9]{16}\.json$/);
      expect(sourceEnv).toEqual({ EXAMPLE: 'kept' });
      expect(lintAsCommittedChildEnv({ AFFECTED_TASK_VERDICT_CACHE_PATH: '/explicit/proof.json' }, first)
        .AFFECTED_TASK_VERDICT_CACHE_PATH).toBe('/explicit/proof.json');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('marks only the child environment for clone-specific Vite resolution', () => {
    const parent = { NODE_OPTIONS: '--trace-warnings', npm_config_workspaces: 'true', EXAMPLE: 'kept' };
    expect(lintAsCommittedChildEnv(parent)).toEqual({
      NODE_OPTIONS: '--trace-warnings',
      npm_config_workspaces: undefined,
      EXAMPLE: 'kept',
      PAPERCUSP_LINT_AS_COMMITTED_CLONE: '1',
    });
    expect(parent).toEqual({ NODE_OPTIONS: '--trace-warnings', npm_config_workspaces: 'true', EXAMPLE: 'kept' });
  });

  it.each([
    ['shallow', resolve(tmpdir(), 'papercusp-lint-as-committed-probe/apps/papercusp-docs')],
    ['persistent', resolve(homedir(), '.papercusp/artifacts/tutorial/replacement/sources/operator/apps/papercusp-docs')],
  ])('resolves injected Astro page imports against the clone root (%s)', async (_geometry, projectRoot) => {
    const { normalizeExternalAstroModuleIds } = await readPublicDocsModule();
    const { pluginPage } = await import(resolve(repoRoot, 'node_modules/astro/dist/vite-plugin-pages/page.js'));
    const sharedRoute = realpathSync(resolve(repoRoot, 'node_modules/@astrojs/starlight/routes/static/404.astro'));
    const component = relative(projectRoot, sharedRoute).split(sep).join('/');
    const virtualId = `\0virtual:astro:page:${component.replace(/\./g, '@_@')}`;
    // Exercise Astro's actual route writer: it prefixes the project-relative
    // component with '/', even when the component traverses outside the clone.
    const page = pluginPage({ routesList: { routes: [{ component, type: 'page' }] } });
    const { code } = page.load.handler(virtualId);
    const match = /import \* as _page from ("(?:[^"\\]|\\.)*");/.exec(code);
    expect(match).not.toBeNull();
    const request = JSON.parse(match![1]);
    expect(request).toContain('/../');
    const normalizer = normalizeExternalAstroModuleIds(projectRoot);
    expect(normalizer.resolveId(request, virtualId)).toBe(sharedRoute);
    expect(normalizer.resolveId(`${request}?astro&type=style&index=0`, virtualId)).toBe(`/@fs${sharedRoute}?astro&type=style&index=0`);
    const localComponent = 'src/pages/index.astro';
    const localVirtualId = `\0virtual:astro:page:${localComponent.replace(/\./g, '@_@')}`;
    const localPage = pluginPage({ routesList: { routes: [{ component: localComponent, type: 'page' }] } });
    const localRequest = JSON.parse(/import \* as _page from ("(?:[^"\\]|\\.)*");/.exec(localPage.load.handler(localVirtualId).code)![1]);
    expect(normalizer.resolveId(localRequest, localVirtualId)).toBe(resolve(projectRoot, localComponent));
    expect(normalizer.resolveId(sharedRoute)).toBe(sharedRoute);
    expect(normalizer.resolveId(`${sharedRoute}?astro&type=style&index=0`)).toBe(`/@fs${sharedRoute}?astro&type=style&index=0`);
  });

  it('normalizes external Astro IDs in clone mode so virtual requests share the compile key', async () => {
    const envKey = 'PAPERCUSP_LINT_AS_COMMITTED_CLONE';
    const before = process.env[envKey];
    try {
      delete process.env[envKey];
      const normalVite = (await readPublicDocsModule()).default.vite;
      expect(normalVite?.resolve?.preserveSymlinks).toBeUndefined();
      expect(normalVite?.plugins?.some(({ name }) => name === 'papercusp-clone-astro-id-normalizer')).toBeFalsy();

      process.env[envKey] = '1';
      const cloneVite = (await readPublicDocsModule()).default.vite;
      expect(cloneVite?.resolve?.preserveSymlinks).toBe(false);

      const normalizer = cloneVite?.plugins?.find(({ name }) => name === 'papercusp-clone-astro-id-normalizer');
      expect(normalizer?.enforce).toBe('pre');
      const sharedComponent = realpathSync(resolve(repoRoot, 'node_modules/@astrojs/starlight/components/Page.astro'));
      const virtualStyleId = `${sharedComponent}?astro&type=style&index=0&lang.css`;
      const mainComponentId = normalizer?.resolveId?.(sharedComponent);
      expect(mainComponentId).toBe(sharedComponent);
      const astroUtilsPath = resolve(repoRoot, 'node_modules/astro/dist/vite-plugin-utils/index.js');
      const { normalizeFilename } = await import(astroUtilsPath);
      const cloneAppRoot = resolve(tmpdir(), 'papercusp-lint-as-committed-probe/apps/papercusp-docs');
      const cloneRootUrl = pathToFileURL(`${cloneAppRoot}/`);
      const normalizedVirtualStyleId = await normalizer?.resolveId?.(virtualStyleId);
      expect(normalizedVirtualStyleId).toBe(`/@fs${virtualStyleId}`);
      if (typeof normalizedVirtualStyleId !== 'string') throw new Error('style resolution must return an id string');
      expect(normalizer?.resolveId?.(`/@fs${virtualStyleId}`)).toBe(`/@fs${virtualStyleId}`);
      expect(normalizeFilename(normalizedVirtualStyleId?.split('?', 1)[0] ?? '', cloneRootUrl)).toBe(mainComponentId);

      const sharedScript = realpathSync(resolve(dirname(sharedComponent), '../components-internals/SidebarPersistState.ts'));
      const delegatedResolutions: Array<{ id: string; importer: string; options: { skipSelf: boolean } }> = [];
      const resolvedScript = await normalizer?.resolveId?.call(
        {
          resolve: async (id: string, importer: string, options: { skipSelf: boolean }) => {
            delegatedResolutions.push({ id, importer, options });
            return { id: sharedScript };
          },
        },
        '../components-internals/SidebarPersistState',
        `${sharedComponent}?astro&type=script&index=0&lang.ts`,
      );
      expect(resolvedScript).toEqual({ id: sharedScript });
      expect(delegatedResolutions).toEqual([{
        id: '../components-internals/SidebarPersistState',
        importer: sharedComponent,
        options: { skipSelf: true },
      }]);

      const sharedRoute = realpathSync(resolve(repoRoot, 'node_modules/@astrojs/starlight/routes/static/404.astro'));
      const sharedCommon = realpathSync(resolve(dirname(sharedRoute), '../common.astro'));
      expect(normalizer?.resolveId?.('../common.astro', `${sharedRoute}?astro&type=page`)).toBe(`/@fs${sharedCommon}?astro&type=page`);
      const relativeSharedRoute = relative(resolve(repoRoot, 'apps/papercusp-docs'), sharedRoute);
      expect(relativeSharedRoute).toContain('../');
      expect(normalizer?.resolveId?.('../common.astro', `${relativeSharedRoute}?astro&type=page`)).toBe(`/@fs${sharedCommon}?astro&type=page`);
      const virtualRouteQuery = '?astro&type=page';
      const noncanonicalFilesystemRoute = `/@fs/${relative(cloneAppRoot, sharedRoute)}${virtualRouteQuery}`;
      expect(noncanonicalFilesystemRoute).toContain('/../');
      expect(normalizer?.resolveId?.(noncanonicalFilesystemRoute)).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);

      const relativeTraversalRoute = `${relative(resolve(repoRoot, 'apps/papercusp-docs'), sharedRoute)}${virtualRouteQuery}`;
      expect(relativeTraversalRoute).toContain('../');
      const normalizedTraversalRoute = await normalizer?.resolveId?.(relativeTraversalRoute);
      expect(normalizedTraversalRoute).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);
      if (typeof normalizedTraversalRoute !== 'string') throw new Error('route resolution must return an id string');
      expect(normalizer?.resolveId?.(normalizedTraversalRoute ?? '')).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);

      const localComponent = resolve(repoRoot, 'apps/papercusp-docs/src/components/Local.astro');
      expect(normalizer?.resolveId?.(localComponent)).toBeNull();
      expect(normalizer?.resolveId?.(`${localComponent}?raw`)).toBeNull();
    } finally {
      if (before === undefined) delete process.env[envKey];
      else process.env[envKey] = before;
    }
  });
});

describe('parseArgs', () => {
  it('normalizes explicit dependency workspace flags without changing command forwarding', () => {
    const args = parseArgs(['test:file', '--any', '--workspace-dir=libs/runtime',
      '--workspace-dir=apps/operator', '--workspace-dir=libs/runtime', '--', '--workspace-dir=forwarded']);
    expect(args.workspaceDirs).toEqual(['apps/operator', 'libs/runtime']);
    expect(args.forward).toEqual(['--workspace-dir=forwarded']);
    expect(args.unknown).toEqual([]);
    expect(parseArgs(['--materialize-only', '--workspace-dir=../outside']).checkErrors)
      .toEqual([expect.stringContaining('invalid --workspace-dir')]);
  });

  it('collects positional script names and defaults the ref to HEAD', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.scripts).toEqual(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.ref).toBe('HEAD');
    expect(a.keep).toBe(false);
  });

  it('parses --ref, --keep and --any', () => {
    const a = parseArgs(['lint:tsc', '--ref=origin/staging', '--keep', '--any']);
    expect(a.ref).toBe('origin/staging');
    expect(a.keep).toBe(true);
    expect(a.any).toBe(true);
    expect(a.scripts).toEqual(['lint:tsc']);
  });

  it('flags a non-lint script for refusal — the blast-radius guard', () => {
    // Running an arbitrary npm script inside an extracted tree with symlinked
    // node_modules is a fine place for a read-only scanner and a bad place for a
    // build/migrate/deploy. The guard makes that an explicit choice, not a typo.
    const a = parseArgs(['db:migrate']);
    expect(a.nonLint).toEqual(['db:migrate']);
  });

  it('--any waives the non-lint refusal', () => {
    const a = parseArgs(['db:migrate', '--any']);
    expect(a.nonLint).toEqual([]);
  });

  it('flags self-recursion — the runner matches its own lint:* prefix', () => {
    // Found empirically: sweeping every lint:* through this tool picks up the runner
    // itself, whose inner no-arg run exits 2 on its usage guard and reports as
    // "FAIL — exit 2", indistinguishable from a real violation at the ref.
    const a = parseArgs(['lint:as-committed']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual(['lint:as-committed']);
  });

  it('does not flag ordinary lints as self-recursive', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:mdx']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual([]);
  });

  it('separates unknown flags from script names so a typo cannot become a script name', () => {
    const a = parseArgs(['lint:mdx', '--ref']); // --ref without '=' is not a ref
    expect(a.unknown).toEqual(['--ref']);
    expect(a.scripts).toEqual(['lint:mdx']);
    expect(a.ref).toBe('HEAD');
  });

  // ── `--` forwarding: what makes a TEST runnable as committed ──

  it('forwards everything after a bare -- to the script, verbatim', () => {
    // The motivating case: `test:file` takes operands, so without forwarding there is
    // no way to ask "does this test pass AT THE COMMIT" rather than "in my dirty tree".
    const a = parseArgs(['test:file', '--any', '--', 'packages/x/lib/a.test.ts']);
    expect(a.scripts).toEqual(['test:file']);
    expect(a.forward).toEqual(['packages/x/lib/a.test.ts']);
    expect(a.any).toBe(true);
  });

  it('stops interpreting its OWN flags after the separator', () => {
    // `--keep` and `--ref=` past the separator belong to the inner script; swallowing
    // them here would silently change which commit is tested while appearing to
    // configure the inner run.
    const a = parseArgs(['test:file', '--any', '--ref=origin/staging', '--', 'a.test.ts', '--keep', '--ref=nope']);
    expect(a.ref).toBe('origin/staging');
    expect(a.keep).toBe(false);
    expect(a.forward).toEqual(['a.test.ts', '--keep', '--ref=nope']);
  });

  it('defaults forward to empty when no separator is present', () => {
    expect(parseArgs(['lint:mdx']).forward).toEqual([]);
  });

  it('REFUSES to forward one operand list to several scripts', () => {
    // Guessing here fails silently: both scripts run, one against operands meant for
    // the other, and the summary reports on whatever came back.
    const a = parseArgs(['lint:a', 'lint:b', '--', 'x.test.ts']);
    expect(a.forwardAmbiguous).toBe(true);
  });

  it('does not flag ambiguity for a single script, or when nothing is forwarded', () => {
    expect(parseArgs(['test:file', '--any', '--', 'x.test.ts']).forwardAmbiguous).toBe(false);
    expect(parseArgs(['lint:a', 'lint:b']).forwardAmbiguous).toBe(false);
  });

  it('--help returns an empty forward list rather than an undefined one', () => {
    // The early return is a separate code path from the main loop; an undefined
    // `forward` there would throw on `.length` at the ambiguity guard.
    expect(parseArgs(['--help']).forward).toEqual([]);
  });

  it('keeps explicit checks separate and applies the existing command guards to each', () => {
    const check = (value: unknown) => '--check=' + JSON.stringify(value);
    const parsed = parseArgs([
      check({ script: 'test:file', args: ['a.test.ts'] }),
      check({ script: 'lint:probe', workspace: 'apps/operator', args: ['two words', '--keep'] }),
    ]);
    expect(parsed).toMatchObject({
      scripts: ['test:file', 'lint:probe'], nonLint: ['test:file'], forward: [],
      checks: [
        { script: 'test:file', args: ['a.test.ts'] },
        { script: 'lint:probe', workspace: 'apps/operator', args: ['two words', '--keep'] },
      ],
    });
    expect(parseArgs([check({ script: 'lint:as-committed' })]).selfRecursive).toEqual(['lint:as-committed']);
    for (const value of [null, [], {}, { script: '--help' }, { script: 'lint:x', args: [1] },
      { script: 'lint:x', workspace: '../escape' }, { script: 'lint:x', env: {} }]) {
      expect(parseArgs([check(value)])).toHaveProperty('checkErrors.0');
    }
    for (const extra of [['lint:x'], ['--'], ['--materialize-only']]) {
      expect(parseArgs([check({ script: 'lint:x' }), ...extra])).toHaveProperty('checkErrors.0');
    }
  });
});

describe('diagnoseNpmSwallow (EI-25262907465098145 — npm ate --any and the separator)', () => {
  const npmEnv = (extra: Record<string, string> = {}) => ({ npm_lifecycle_event: 'lint:as-committed', ...extra });

  it('a correct invocation is not flagged', () => {
    const parsed = parseArgs(['test:file', '--any', '--', 'packages/x/lib/a.test.ts']);
    expect(diagnoseNpmSwallow(parsed, npmEnv())).toBeNull();
    expect(diagnoseNpmSwallow(parseArgs(['lint:mdx', '--keep']), npmEnv({ npm_config_keep: 'true' }))).toBeNull();
    expect(diagnoseNpmSwallow(parseArgs(['--help']), npmEnv({ npm_config_keep: 'true' }))).toBeNull();
  });

  it('a file operand with no separator means npm consumed the --, even though --any left no trace', () => {
    // What `npm run lint:as-committed test:file --any -- a.test.ts` delivers on npm 11:
    // the flag is gone with no env trace, and the operand arrives as a positional.
    const d = diagnoseNpmSwallow(parseArgs(['test:file', 'packages/x/lib/a.test.ts']), npmEnv());
    expect(d).not.toBeNull();
    expect(d!.pathOperands).toEqual(['packages/x/lib/a.test.ts']);
    expect(d!.anyInferred).toBe(true);
    expect(d!.correctedCommand).toBe('npm run lint:as-committed -- test:file --any -- packages/x/lib/a.test.ts');
  });

  it('recovers --keep and --ref= from npm_config_* when npm launched this script', () => {
    const d = diagnoseNpmSwallow(
      parseArgs(['test:file', 'a.test.ts']),
      npmEnv({ npm_config_keep: 'true', npm_config_ref: 'origin/staging' }),
    );
    expect(d!.swallowedFlags).toEqual(['--keep', '--ref=origin/staging']);
    expect(d!.correctedCommand).toBe(
      'npm run lint:as-committed -- test:file --keep --ref=origin/staging --any -- a.test.ts',
    );
    // A lint script needs no --any, and a lost --keep alone is still a refusal: running
    // without it silently deletes the tree the caller asked to keep.
    const lint = diagnoseNpmSwallow(parseArgs(['lint:mdx']), npmEnv({ npm_config_keep: 'true' }));
    expect(lint!.swallowedFlags).toEqual(['--keep']);
    expect(lint!.anyInferred).toBe(false);
    expect(lint!.correctedCommand).toBe('npm run lint:as-committed -- lint:mdx --keep');
  });

  it('ignores INHERITED npm_config_* when npm did not launch this script', () => {
    // A direct `node scripts/lint-as-committed.mjs` under an outer `npm run test:file --keep`
    // inherits npm_config_keep. That flag was for the outer command, not this one.
    const inherited = { npm_lifecycle_event: 'test:file', npm_config_keep: 'true', npm_config_ref: 'x' };
    expect(diagnoseNpmSwallow(parseArgs(['lint:mdx']), inherited)).toBeNull();
    expect(diagnoseNpmSwallow(parseArgs(['lint:mdx']), {})).toBeNull();
    // The structural signal still applies: a path is never a script name.
    const d = diagnoseNpmSwallow(parseArgs(['test:file', 'a.test.ts']), inherited);
    expect(d!.viaNpm).toBe(false);
    expect(d!.swallowedFlags).toEqual([]);
  });

  it('end-to-end: the real npm swallow is refused with a runnable corrected command', () => {
    // Runs real npm, because the env/argv shape npm produces is the thing under test.
    // It exits 2 before any git work, so it is cheap.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('npm_config_') || k === 'npm_lifecycle_event') delete env[k];
    const run = spawnSync(
      'npm',
      ['run', '--silent', 'lint:as-committed', 'test:file', '--any', '--keep', '--', 'packages/x/lib/a.test.ts'],
      { cwd: repoRoot, encoding: 'utf8', env, timeout: 60_000, killSignal: 'SIGKILL' },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toContain('npm consumed part of this command');
    expect(run.stderr).toContain('npm run lint:as-committed -- test:file --keep --any -- packages/x/lib/a.test.ts');
    expect(run.stderr).not.toContain('Pass --any if you really mean it');
  });
});

describe('detectorPathsFromCommand', () => {
  it('extracts a plain node script path', () => {
    expect(detectorPathsFromCommand('node scripts/check-no-owner-name-tags.mjs')).toEqual([
      'scripts/check-no-owner-name-tags.mjs',
    ]);
  });

  it('extracts a nested app-local script path run via tsx', () => {
    expect(detectorPathsFromCommand('node apps/operator/scripts/check-vitest-mock-paths.mjs')).toEqual([
      'apps/operator/scripts/check-vitest-mock-paths.mjs',
    ]);
  });

  it('extracts every file in a multi-file command', () => {
    const cmd =
      'node scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts apps/operator/app/_lints/css-tokens.test.ts';
    expect(detectorPathsFromCommand(cmd)).toEqual([
      'scripts/test-files.mjs',
      'apps/operator/app/_lints/design-primitives.test.ts',
      'apps/operator/app/_lints/css-tokens.test.ts',
    ]);
  });

  it('ignores bare binaries, which this tool cannot version against a git ref', () => {
    // knip/vitest come from node_modules, which is symlinked, not archived. Claiming
    // to have versioned them would be a lie the header explicitly refuses to tell.
    expect(detectorPathsFromCommand('knip --no-config-hints')).toEqual([]);
  });

  it('does not duplicate a path repeated in one command', () => {
    expect(detectorPathsFromCommand('node scripts/a.mjs && node scripts/a.mjs')).toEqual(['scripts/a.mjs']);
  });

  it('is total on a non-string command', () => {
    expect(detectorPathsFromCommand(undefined)).toEqual([]);
    expect(detectorPathsFromCommand(null)).toEqual([]);
  });
});

describe('parseGitmodules (EI-21033860565861795 — the submodule-blindness bug)', () => {
  it('extracts name/path/url from a real .gitmodules stanza', () => {
    const text = [
      '[submodule "libs/papercusp"]',
      '\tpath = libs/papercusp',
      '\turl = git@github.com:Papercusp/papercusp.git',
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([
      { name: 'libs/papercusp', path: 'libs/papercusp', url: 'git@github.com:Papercusp/papercusp.git' },
    ]);
  });

  it('handles a submodule name that differs from its path — the config key is the NAME', () => {
    // Real case in this repo: [submodule "libs/git-graph"] lives at
    // libs/generic/git-graph. `submodule.<name>.url` must be keyed on the name, not
    // the path, or the local-checkout override silently targets nothing.
    const text = ['[submodule "libs/git-graph"]', '\tpath = libs/generic/git-graph', '\turl = git@github.com:Papercusp/git-graph.git'].join(
      '\n',
    );
    expect(parseGitmodules(text)).toEqual([
      { name: 'libs/git-graph', path: 'libs/generic/git-graph', url: 'git@github.com:Papercusp/git-graph.git' },
    ]);
  });

  it('parses several stanzas in one file', () => {
    const text = [
      '[submodule "a"]',
      '\tpath = libs/a',
      '\turl = git@github.com:x/a.git',
      '[submodule "b"]',
      '\tpath = libs/b',
      '\turl = git@github.com:x/b.git',
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([
      { name: 'a', path: 'libs/a', url: 'git@github.com:x/a.git' },
      { name: 'b', path: 'libs/b', url: 'git@github.com:x/b.git' },
    ]);
  });

  it('drops a stanza with no `path =` line — git itself ignores those', () => {
    const text = ['[submodule "no-path"]', '\turl = git@github.com:x/y.git'].join('\n');
    expect(parseGitmodules(text)).toEqual([]);
  });

  it('is total: empty string, non-string, and a file with no submodules all yield []', () => {
    expect(parseGitmodules('')).toEqual([]);
    expect(parseGitmodules(undefined)).toEqual([]);
    expect(parseGitmodules(null)).toEqual([]);
    expect(parseGitmodules('# just a comment\n')).toEqual([]);
  });

  it("this repo's OWN committed .gitmodules parses to a nonempty list that includes libs/papercusp", () => {
    // Not a golden-file test of the whole registry (that would break on every
    // legitimate submodule add/remove) — just proof the parser reads THIS repo's
    // real format, and finds the exact submodule the filed bug's repro depends on.
    const text = readFileSync(join(repoRoot, '.gitmodules'), 'utf8');
    const parsed = parseGitmodules(text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.find((s) => s.path === 'libs/papercusp')).toBeTruthy();
  });
});

describe('planLinkExcludes (WI-10004898 — linked node_modules made every extracted tree dirty)', () => {
  it('routes a top-level link to the superproject exclude, anchored', () => {
    expect(planLinkExcludes(['node_modules', 'packages/operator-core/node_modules'], [])).toEqual({
      '': ['/node_modules', '/packages/operator-core/node_modules'],
    });
  });

  it('routes a link inside a submodule to THAT submodule, relative to its root', () => {
    expect(planLinkExcludes(['libs/papercusp/node_modules', 'node_modules'], ['libs/papercusp'])).toEqual({
      'libs/papercusp': ['/node_modules'],
      '': ['/node_modules'],
    });
  });

  it('picks the DEEPEST containing submodule, and never matches a sibling that merely shares a prefix', () => {
    const plan = planLinkExcludes(
      ['libs/papercusp/libs/db/node_modules', 'libs/papercusp-extra/node_modules'],
      ['libs/papercusp', 'libs/papercusp/libs/db'],
    );
    expect(plan).toEqual({
      'libs/papercusp/libs/db': ['/node_modules'],
      '': ['/libs/papercusp-extra/node_modules'],
    });
  });

  it('is total on junk input', () => {
    expect(planLinkExcludes(undefined, undefined)).toEqual({});
    expect(planLinkExcludes(['', 42, 'node_modules'], [null, ''])).toEqual({ '': ['/node_modules'] });
  });
});

describe('writeLinkExcludes (EI-25175171560777563 — absorbed Git metadata)', () => {
  it.each(['directory', 'pointer'] as const)('keeps infrastructure links ignored with a .git %s', (layout) => {
    const root = mkdtempSync(join(tmpdir(), 'lint-link-excludes-'));
    try {
      const repository = join(root, 'libs', 'sub');
      const metadata = join(root, 'metadata');
      mkdirSync(repository, { recursive: true });
      execFileSync('git', ['init', '-q', ...(layout === 'pointer' ? [`--separate-git-dir=${metadata}`] : []), repository]);
      if (layout === 'pointer') {
        // Absorbed submodules use a relative gitdir pointer rather than a directory.
        writeFileSync(join(repository, '.git'), 'gitdir: ../../metadata\n');
        expect(lstatSync(join(repository, '.git')).isFile()).toBe(true);
      }
      const excludePath = resolve(repository, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: repository, encoding: 'utf8',
      }).trim());
      writeFileSync(excludePath, '# existing exclusion\n/existing-link\n');
      const dependencyRoot = join(root, 'dependencies');
      mkdirSync(dependencyRoot);
      symlinkSync(dependencyRoot, join(repository, 'node_modules'), 'dir');
      writeFileSync(join(repository, 'visible.txt'), 'must remain visible\n');

      writeLinkExcludes(root, planLinkExcludes(['libs/sub/node_modules'], ['libs/sub']));

      expect(readFileSync(excludePath, 'utf8')).toContain('/existing-link\n');
      expect(execFileSync('git', ['check-ignore', 'node_modules'], { cwd: repository, encoding: 'utf8' }).trim())
        .toBe('node_modules');
      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repository, encoding: 'utf8',
      }).trim()).toBe('?? visible.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cloneWorkspaceTarget (EI-24790229053787032 — workspace links must resolve into the extracted tree)', () => {
  it('maps a workspace package inside the shared checkout to the same path in the extracted tree', () => {
    expect(cloneWorkspaceTarget('/r/shared/libs/generic/search', '/r/shared', '/tmp/clone')).toBe(
      '/tmp/clone/libs/generic/search',
    );
  });

  it('leaves anything that is not a workspace package alone', () => {
    // a real dependency living in a node_modules
    expect(cloneWorkspaceTarget('/r/shared/node_modules/.pnpm/x', '/r/shared', '/tmp/clone')).toBeNull();
    // outside the checkout, including a sibling that merely shares the prefix
    expect(cloneWorkspaceTarget('/r/elsewhere/pkg', '/r/shared', '/tmp/clone')).toBeNull();
    expect(cloneWorkspaceTarget('/r/shared-other/pkg', '/r/shared', '/tmp/clone')).toBeNull();
    // the checkout root itself
    expect(cloneWorkspaceTarget('/r/shared', '/r/shared', '/tmp/clone')).toBeNull();
  });

  it('is total on junk input', () => {
    expect(cloneWorkspaceTarget(undefined, '/r', '/c')).toBeNull();
    expect(cloneWorkspaceTarget('/r/a', '', '/c')).toBeNull();
    expect(cloneWorkspaceTarget('/r/a', '/r', 42)).toBeNull();
  });
});

describe('linkNodeModulesShadow (EI-24790229053787032 — a whole-directory link ran the SHARED tree)', () => {
  function writePkg(dir: string, marker: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
  }

  function fixture(): { root: string; shared: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), 'lac-shadow-'));
    const shared = join(root, 'shared');
    const clone = join(root, 'clone');
    // shared checkout: two workspace packages, one real dependency
    writePkg(join(shared, 'libs', 'foo'), 'shared-foo');
    writePkg(join(shared, 'libs', 'gone'), 'shared-gone');
    writePkg(join(shared, 'node_modules', 'leftpad'), 'leftpad');
    mkdirSync(join(shared, 'node_modules', '@papercusp'), { recursive: true });
    symlinkSync('../../libs/foo', join(shared, 'node_modules', '@papercusp', 'foo'));
    symlinkSync('../../libs/gone', join(shared, 'node_modules', '@papercusp', 'gone'));
    // extracted tree: has its own (committed) foo, lacks gone (an uninitialised submodule)
    writePkg(join(clone, 'libs', 'foo'), 'clone-foo');
    mkdirSync(join(clone, 'app'), { recursive: true });
    return { root, shared, clone };
  }

  it('resolves a workspace package to the extracted tree copy, everything else to the shared install', () => {
    const { root, shared, clone } = fixture();
    try {
      const stats = linkNodeModulesShadow(join(shared, 'node_modules'), join(clone, 'node_modules'), shared, clone);
      expect(stats).toEqual({ entries: 3, remapped: 1, fallback: 1 });
      expect(lstatSync(join(clone, 'node_modules')).isSymbolicLink()).toBe(false);

      // The failure this guards is a RUNTIME resolution, so assert what require() actually loads.
      const req = createRequire(join(clone, 'app', 'x.js'));
      expect(req('@papercusp/foo')).toBe('clone-foo');
      expect(realpathSync(req.resolve('@papercusp/foo'))).toBe(realpathSync(join(clone, 'libs', 'foo', 'index.js')));
      // absent in the extracted tree: falls back to the shared package (counted above, not silent)
      expect(req('@papercusp/gone')).toBe('shared-gone');
      // npm traverses a real package shell; runtime contents remain linked to the install.
      expect(lstatSync(join(clone, 'node_modules', 'leftpad')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(clone, 'node_modules', 'leftpad', 'index.js')).isSymbolicLink()).toBe(true);
      expect(req('leftpad')).toBe('leftpad');
      expect(req.resolve('leftpad')).toBe(realpathSync(join(shared, 'node_modules', 'leftpad', 'index.js')));
      expect(req.resolve('@papercusp/foo')).toBe(realpathSync(join(clone, 'libs', 'foo', 'index.js')));

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: the previous whole-directory link loads the SHARED copy (the bug)', () => {
    const { root, shared, clone } = fixture();
    try {
      symlinkSync(join(shared, 'node_modules'), join(clone, 'node_modules'), 'dir');
      expect(createRequire(join(clone, 'app', 'x.js'))('@papercusp/foo')).toBe('shared-foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves npm hoisted and nested graph edges while linking installed runtime bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-npm-graph-'));
    const shared = join(root, 'shared');
    const clone = join(root, 'clone');
    const broken = join(root, 'broken');
    const put = (dir: string, manifest: Record<string, unknown>) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    };
    let attemptNumber = 0;
    const measure = (cwd: string) => {
      const fixture = relative(root, cwd);
      // Two clone measurements have different expected verdicts. Keep each
      // launch's timing/config evidence separate rather than mixing their logs.
      const logs = join(root, `npm-logs-${++attemptNumber}-${fixture}`);
      const started = Date.now();
      process.stderr.write('CASE_TRACE ' + JSON.stringify({ case: 'npm-shadow-graph', event: 'launch', fixture }) + '\n');
      const run = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json',
        '--timing', '--loglevel=verbose', `--logs-dir=${logs}`], {
        cwd, encoding: 'utf8', timeout: 15_000,
      });
      const evidence = fixtureProcessEvidence(run, started);
      const npmLogs = fixtureNpmLogs(logs);
      const outcome = { case: 'npm-shadow-graph', event: 'exit', fixture, attemptNumber, ...evidence };
      process.stderr.write('CASE_TRACE ' + JSON.stringify({ ...outcome,
        npmTiming: npmLogs.filter(log => log.name.endsWith('-timing.json')) }) + '\n');
      // Preserve npm's startup/config/timing evidence before fixture cleanup.
      // An expired process deadline must identify the stalled phase, rather
      // than leave only spawnSync's ETIMEDOUT after the logs have been removed.
      const diagnostic = () => JSON.stringify({ ...outcome, npmLogs });
      expect(run.error, run.error ? diagnostic() : undefined).toBeUndefined();
      expect(run.signal, run.signal ? diagnostic() : undefined).toBeNull();
      let tree;
      try { tree = JSON.parse(run.stdout); }
      catch { throw new Error(`npm graph did not produce JSON: ${diagnostic()}`); }
      return { status: run.status, tree };
    };
    try {
      for (const dir of [shared, clone, broken]) {
        put(dir, { name: 'graph-root', version: '1.0.0', dependencies: { parent: '1.0.0' } });
      }
      put(join(shared, 'node_modules/parent'), {
        name: 'parent', version: '1.0.0', dependencies: { leaf: '1.0.0', nested: '1.0.0' },
      });
      put(join(shared, 'node_modules/leaf'), { name: 'leaf', version: '1.0.0' });
      put(join(shared, 'node_modules/parent/node_modules/nested'), {
        name: 'nested', version: '1.0.0', dependencies: { leaf: '1.0.0' },
      });
      writeFileSync(join(shared, 'node_modules/leaf/index.js'), "module.exports = 'installed-leaf';\n");
      writeFileSync(join(shared, 'node_modules/.package-lock.json'), JSON.stringify({
        name: 'graph-root', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: {
          'node_modules/parent': { version: '1.0.0', dependencies: { leaf: '1.0.0', nested: '1.0.0' } },
          'node_modules/leaf': { version: '1.0.0' },
          'node_modules/parent/node_modules/nested': { version: '1.0.0', dependencies: { leaf: '1.0.0' } },
        },
      }));
      mkdirSync(join(broken, 'node_modules'));
      for (const name of ['parent', 'leaf']) {
        symlinkSync(join(shared, 'node_modules', name), join(broken, 'node_modules', name));
      }
      const control = measure(broken);
      expect(control.status).toBe(1);
      expect(control.tree.problems).toEqual(expect.arrayContaining([
        expect.stringContaining('missing: leaf@1.0.0'),
        expect.stringContaining('extraneous: leaf@1.0.0'),
      ]));
      const physical = measure(shared);
      expect(physical.tree.problems ?? []).toEqual([]);
      expect(physical.status).toBe(0);

      linkNodeModulesShadow(join(shared, 'node_modules'), join(clone, 'node_modules'), shared, clone);
      const result = measure(clone);
      expect(result.status).toBe(0);
      expect(result.tree.problems ?? []).toEqual([]);
      const parent = result.tree.dependencies.parent;
      expect(parent.dependencies.leaf.version).toBe('1.0.0');
      expect(parent.dependencies.nested.dependencies.leaf.version).toBe('1.0.0');
      expect(existsSync(join(clone, 'node_modules/.package-lock.json'))).toBe(false);
      const provenance = join(clone, 'node_modules/.papercusp-installed-package-lock.json');
      expect(lstatSync(provenance).isSymbolicLink()).toBe(true);
      expect(realpathSync(provenance)).toBe(join(shared, 'node_modules/.package-lock.json'));
      expect(createRequire(join(clone, 'entry.js'))('leaf')).toBe('installed-leaf');
      expect(realpathSync(join(clone, 'node_modules/leaf/index.js')))
        .toBe(join(shared, 'node_modules/leaf/index.js'));

      // A real unsatisfied edge must remain an error; shells fix topology, not integrity.
      put(join(shared, 'node_modules/parent'), {
        name: 'parent', version: '1.0.0', dependencies: { leaf: '2.0.0', nested: '1.0.0' },
      });
      const invalid = measure(clone);
      expect(invalid.status).toBe(1);
      expect(invalid.tree.problems).toEqual(expect.arrayContaining([
        expect.stringContaining('invalid: leaf@1.0.0'),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('showAtRef (WI-10004908 — submodule test operands were refused as absent at the ref)', () => {
  const gitOut = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });

  it('owningSubmodule picks the deepest containing submodule and ignores prefix-sharing siblings', () => {
    const subs = ['libs/papercusp', 'libs/papercusp/libs/db'];
    expect(owningSubmodule('libs/papercusp/libs/db/sql/1.sql', subs)).toBe('libs/papercusp/libs/db');
    expect(owningSubmodule('libs/papercusp/README.md', subs)).toBe('libs/papercusp');
    expect(owningSubmodule('libs/papercusp-extra/x.ts', subs)).toBeNull();
    expect(owningSubmodule('package.json', undefined)).toBeNull();
  });

  it('reads a superproject path exactly as git show does', () => {
    expect(showAtRef(repoRoot, 'HEAD', 'package.json')).toBe(gitOut(repoRoot, ['show', 'HEAD:package.json']));
  });

  it('reads a path INSIDE a submodule from the submodule at the pinned commit, not null', () => {
    const subRoot = 'libs/papercusp';
    const subRelFile = 'libs/db/src/connection.ts';
    // Calibration: the instrument this fix replaces really is blind here, so a pass below
    // cannot be the old code path answering by accident.
    expect(() => gitOut(repoRoot, ['show', `HEAD:${subRoot}/${subRelFile}`])).toThrow();
    const pin = gitOut(repoRoot, ['rev-parse', `HEAD:${subRoot}`]).trim();
    const committed = gitOut(join(repoRoot, subRoot), ['show', `${pin}:${subRelFile}`]);
    expect(committed.length).toBeGreaterThan(0);
    expect(showAtRef(repoRoot, 'HEAD', `${subRoot}/${subRelFile}`)).toBe(committed);
  });

  it('still answers null for a path absent at the ref, inside or outside a submodule', () => {
    expect(showAtRef(repoRoot, 'HEAD', 'no-such-dir/definitely-absent-WI-10004908.ts')).toBeNull();
    expect(showAtRef(repoRoot, 'HEAD', 'libs/papercusp/no-such-dir/definitely-absent-WI-10004908.ts')).toBeNull();
  });
});

describe('summarize — fail-closed', () => {
  it('exits 0 only when every lint actually passed', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(0);
    expect(s.failedCount).toBe(0);
  });

  it('exits nonzero on a genuine lint failure', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'fail', note: 'exit 1' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  // ── the two negative controls this file exists for ──

  it('NEGATIVE CONTROL: a script absent at the ref FAILS — it must never read as a skip', () => {
    // "It only exists in your working tree" is the exact finding worth surfacing. If
    // this ever returned 0, the tool would print green for a lint the gate cannot run.
    const s = summarize([{ script: 'lint:only-local', status: 'missing', note: 'not in package.json at abc1234' }]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
    expect(s.lines[0]).toContain('MISSING@REF');
  });

  it('NEGATIVE CONTROL: a run that errored FAILS — an un-run lint is not a passing lint', () => {
    const s = summarize([{ script: 'lint:a', status: 'error', note: 'spawn npm ENOENT' }]);
    expect(s.exitCode).toBe(1);
    expect(s.lines[0]).toContain('ERROR');
  });

  it('one missing lint poisons an otherwise-green batch', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'missing' },
      { script: 'lint:c', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  it('an empty result set is not a green — nothing ran, so nothing was verified', () => {
    // Guarded deliberately: summarize([]) returning exitCode 0 is only safe because the
    // CLI refuses an empty script list up front (exit 2). This pins the pairing so a
    // future edit that drops that refusal cannot silently produce "All 0 lint(s) pass".
    expect(parseArgs([]).scripts).toEqual([]);
    expect(summarize([]).failedCount).toBe(0);
  });
});

describe('isDirectCliInvocation', () => {
  it('is false when imported (as this test does) so an import never extracts a tree', () => {
    expect(isDirectCliInvocation('/usr/bin/vitest')).toBe(false);
    expect(isDirectCliInvocation(undefined)).toBe(false);
  });

  it('is true for a direct CLI run', () => {
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs')).toBe(true);
    expect(isDirectCliInvocation('scripts/lint-as-committed.mjs')).toBe(true);
  });

  it('does not match a lookalike basename', () => {
    // The boundary is a path separator (or string start), not a bare suffix — so a
    // file whose name merely ENDS with the script name is not the script.
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs.bak')).toBe(false);
    expect(isDirectCliInvocation('/repo/scripts/not-lint-as-committed.mjs')).toBe(false);
  });
});

describe('the npm script is registered', () => {
  it('package.json exposes lint:as-committed pointing at this script', () => {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(resolve(here, '../../../package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['lint:as-committed']).toBe('node scripts/lint-as-committed.mjs');
  });
});

describe('end-to-end — submodule content is materialised, not silently empty (EI-21033860565861795)', () => {
  // WI-40086's exact repro: an isolated-tree run fabricated TS2307 for
  // `libs/papercusp/libs/db/src/connection` because `git clone --no-checkout` +
  // `checkout --detach` leaves a submodule as an EMPTY gitlink directory — the real
  // checkpoint writer, and current-tree lint, both resolve the module fine. This is
  // deliberately NOT unit-tested against a mock (see the file header): the bug lives
  // in the extraction mechanism itself, so the only faithful regression is running
  // the real CLI against a real submodule-carrying fixture and reading back what it
  // actually materialised. Keep unrelated monorepo dependencies out of this check:
  // their builds previously exhausted its child deadline before this assertion.
  it('extracts REAL, committed content for a git-submodule path, not an empty gitlink dir', () => {
    const parent = mkdtempSync(join(tmpdir(), 'lac-submodule-e2e-'));
    const repoRoot = join(parent, 'source');
    const subRoot = 'libs/papercusp';
    const subRelFile = 'libs/db/src/connection.ts';
    const subFile = `${subRoot}/${subRelFile}`;
    const gitAt = (root: string, args: string[], input?: string) => execFileSync('git', args, {
      cwd: root, input, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commitFiles = (root: string, files: Record<string, string>, prior?: string) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
        const blob = gitAt(root, ['hash-object', '-w', '--stdin'], content);
        gitAt(root, ['update-index', '--add', '--cacheinfo', '100644', blob, path]);
      }
      const tree = gitAt(root, ['write-tree']);
      const sha = gitAt(root, ['-c', 'user.name=Submodule fixture', '-c', 'user.email=fixture@example.invalid',
        'commit-tree', tree, ...(prior ? ['-p', prior] : []), '-m', 'submodule fixture']);
      gitAt(root, ['update-ref', 'refs/heads/staging', sha]);
      return sha;
    };
    try {
      mkdirSync(join(repoRoot, subRoot), { recursive: true });
      gitAt(join(repoRoot, subRoot), ['init', '--quiet', '--initial-branch=staging']);
      const subPin = commitFiles(join(repoRoot, subRoot), {
        '.gitignore': 'dist/\n',
        [subRelFile]: 'export const committedConnection = true;\n',
        'package.json': JSON.stringify({ name: '@papercusp/sse',
          exports: { '.': { require: './dist/index.js', default: './dist/index.js' } },
          scripts: { build: 'node build.cjs' } }),
        'source.cjs': 'module.exports = { sseResponse: () => "committed" };\n',
        'build.cjs': "const fs = require('node:fs'); fs.mkdirSync('dist', {recursive:true}); fs.copyFileSync('source.cjs', 'dist/index.js');\n",
      });
      gitAt(repoRoot, ['init', '--quiet', '--initial-branch=staging']);
      gitAt(repoRoot, ['update-index', '--add', '--cacheinfo', '160000', subPin, subRoot]);
      const main = commitFiles(repoRoot, {
        '.gitignore': 'node_modules/\n',
        '.gitmodules': `[submodule "papercusp"]\n path = ${subRoot}\n url = ./${subRoot}\n`,
        'package.json': JSON.stringify({ private: true, workspaces: [subRoot],
          scripts: { 'lint:probe': 'node probe.cjs' } }),
        'probe.cjs': 'require("node:assert/strict").equal(require("@papercusp/sse").sseResponse(), "committed");\n',
        'libs/test-config/src/index.ts': 'export {};\n',
      });
      gitAt(repoRoot, ['update-ref', 'refs/heads/main', main]);
      commitFiles(repoRoot, { 'candidate.txt': 'separate candidate commit\n' }, main);
      mkdirSync(join(repoRoot, 'node_modules/@papercusp'), { recursive: true });
      symlinkSync('../../libs/papercusp', join(repoRoot, 'node_modules/@papercusp/sse'));
      // A dirty donor must not replace either the gitlink's committed blob or
      // the pinned workspace's build input.
      writeFileSync(join(repoRoot, subFile), 'dirty connection source\n');
      writeFileSync(join(repoRoot, subRoot, 'source.cjs'), 'module.exports = { sseResponse: () => "dirty" };\n');
    // Sanity first: if this checkout itself doesn't have the submodule (or the file
    // the bug's repro depends on), the assertions below would pass for the wrong
    // reason — every path missing, not just the extracted one.
    expect(existsSync(join(repoRoot, subRoot, '.git'))).toBe(true);
    expect(existsSync(join(repoRoot, subFile))).toBe(true);
    // The submodule's pinned commit, resolved from the SUPERPROJECT's tree (a gitlink
    // resolves like a blob entry, to the commit sha it points at) — and the committed
    // content itself, read from the SUBMODULE's OWN repository at that pin. A single
    // `git show <ref>:<path>` from repoRoot cannot do this in one step: git does not
    // recurse a pathspec across a submodule boundary, which is exactly why this whole
    // fix (and this test) has to treat the submodule as a second repository.
    const pin = execFileSync('git', ['rev-parse', `HEAD:${subRoot}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    const committed = execFileSync('git', ['show', `${pin}:${subRelFile}`], {
      cwd: join(repoRoot, subRoot),
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    // NOTE: no leading `--` here. `npm run lint:as-committed -- lint:x` works because
    // NPM's own `--` is consumed by npm itself before the script sees argv; invoking
    // the script directly (as this test does) must pass the script name bare, or this
    // tool's OWN `--` forwarding logic swallows it as an (empty) script list.
    //
    // This real lint also reads the pinned workspace export, so an empty
    // gitlink, a borrowed dirty source, or a missing build must fail.
    const run = spawnSync('node', [scriptPath, 'lint:probe', '--keep'], {
      cwd: repoRoot,
      env: currentRunnerEnvironment(),
      encoding: 'utf8',
      timeout: 150_000,
      killSignal: 'SIGKILL',
    });
    // Case traces bound assertion text. Put the exact process outcome and the
    // latest setup phase first so a killed suite still preserves its cause.
    const outcome = JSON.stringify({ error: run.error && {
      name: run.error.name, message: run.error.message,
      code: 'code' in run.error ? run.error.code : undefined,
    }, status: run.status, signal: run.signal });
    const diagnostic = `${outcome}\nrunner stderr tail:\n${run.stderr?.slice(-1200)}\nrunner stdout tail:\n${run.stdout?.slice(-1200)}`;
    expect(run.error, diagnostic).toBeUndefined();
    expect(run.status, diagnostic).toBe(0);
    // Proof the new step actually engaged, not just that nothing crashed — a future
    // edit that silently skips submodule init would still reach this lint fine (it
    // never touches libs/papercusp), so this line is load-bearing, not decorative.
    expect(run.stdout).toMatch(/initialised \d+ submodule\(s\) from local checkouts/);

    const kept = run.stdout.match(/--keep: extracted tree left at (\S+)/);
    expect(kept).not.toBeNull();
    const workRoot = kept![1];
    try {
      const extracted = readFileSync(join(workRoot, subFile), 'utf8');
      expect(extracted.length).toBeGreaterThan(0);
      // Not just "some content" — the COMMITTED content: `--ref` defaults to HEAD, so
      // this must byte-match what's pinned there (`committed`, resolved above), the
      // exact bytes the release gate itself would see. That equality is the whole
      // point of this tool.
      expect(extracted).toBe(committed);
      // WI-10006131: real reporters must see the superproject, rather than treating
      // a materialised submodule's standalone .git directory as the run root.
      expect(lstatSync(join(workRoot, subRoot, '.git')).isFile()).toBe(true);
      expect(computeWorkspaceRootFrom(dirname(join(workRoot, subFile)))).toBe(workRoot);
      expect(computeWorkspaceRootFrom(join(workRoot, 'libs/test-config/src'))).toBe(workRoot);
      // Populating a standalone clone is not enough: the parent repository must mark
      // the submodule active or recursive Git scanners silently omit its real files.
      const tracked = execFileSync('git', ['ls-files', '-z', '--recurse-submodules', '--', subFile], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).split('\0').filter((p) => existsSync(join(workRoot, p)));
      expect(tracked).toContain(subFile);
      // WI-10004898: the extracted tree must be CLEAN to the same `git status` the test-run
      // reporter samples for worktree_dirty, or no run inside it can ever be current proof.
      // The linked node_modules are what dirtied it, so first prove the links exist (a tree
      // with nothing linked would be trivially clean and this assertion vacuous).
      expect(run.stdout, `runner stderr:\n${run.stderr}`).toMatch(/copied [1-9]\d* node_modules dir\(s\)/);
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      expect(status).toBe('');
      // WI-10005625: metadata and ignored runtime exports are prerequisites too.
      const snapshottedMain = run.stdout.match(/main snapshot: ([0-9a-f]{40})/);
      expect(snapshottedMain).not.toBeNull();
      expect(execFileSync('git', ['rev-parse', 'main^{commit}'], { cwd: workRoot, encoding: 'utf8' }).trim()).toBe(snapshottedMain![1]);
      expect(run.stdout).toContain('building pinned runtime exports: @papercusp/sse');
      const requireClone = createRequire(join(workRoot, 'package.json'));
      expect(requireClone('@papercusp/sse').sseResponse).toBeTypeOf('function');
      expect(realpathSync(requireClone.resolve('@papercusp/sse'))).toBe(realpathSync(join(workRoot, subRoot, 'dist/index.js')));
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('end-to-end — independent main and pinned runtime prerequisites (WI-10005625)', () => {
  const gitFixture = (cwd: string, args: string[], input?: string) => execFileSync('git', args, {
    cwd, input, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  // Real git history with plumbing: no mocks, install, network, or shared-tree writes.
  function snapshot(root: string, files: Record<string, string>, parent?: string): string {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
      const blob = gitFixture(root, ['hash-object', '-w', '--stdin'], content);
      gitFixture(root, ['update-index', '--add', '--cacheinfo', '100644', blob, name]);
    }
    const tree = gitFixture(root, ['write-tree']);
    const sha = gitFixture(root, ['-c', 'user.name=Runner fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'runner fixture']);
    gitFixture(root, ['update-ref', 'refs/heads/staging', sha]);
    return sha;
  }

  function fixture(build?: string, withMain = true, parent = tmpdir()) {
    const root = mkdtempSync(join(parent, 'lac-prerequisites-'));
    gitFixture(root, ['init', '--quiet', '--initial-branch=staging']);
    const files = {
      '.gitignore': 'node_modules/\nlibs/runtime/dist/\n',
      'package.json': JSON.stringify({ private: true, scripts: { 'lint:probe': 'node probe.cjs' } }),
      'probe.cjs': 'console.log("initial fixture");\n',
      'libs/runtime/package.json': JSON.stringify({ name: '@fixture/runtime', type: 'module',
        exports: { '.': { types: './source.d.ts', import: './source.mjs', require: './dist/index.cjs', default: './dist/index.cjs' } },
        scripts: build === undefined ? {} : { build } }),
      'libs/runtime/source.cjs': 'module.exports = "pinned-source";\n',
      'libs/runtime/build.cjs': "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.cjs', 'module.exports = ' + JSON.stringify(require('./source.cjs')) + ';\\n');\n",
    };
    const main = snapshot(root, files);
    if (withMain) gitFixture(root, ['update-ref', 'refs/heads/main', main]);
    files['probe.cjs'] = `
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
${withMain ? `assert.equal(execFileSync('git', ['rev-parse', 'main^{commit}'], { encoding: 'utf8' }).trim(), ${JSON.stringify(main)});` : "assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], { stdio: 'pipe' }));"}
assert.equal(require('@fixture/runtime'), 'pinned-source');
assert.equal(realpathSync(require.resolve('@fixture/runtime')), realpathSync(resolve('libs/runtime/dist/index.cjs')));
assert.equal(readFileSync('libs/runtime/source.cjs', 'utf8'), 'module.exports = "pinned-source";\\n');
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), '');
console.log('CLONE_PREREQUISITES_OK');
`;
    const head = snapshot(root, files, main);
    mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
    symlinkSync('../../libs/runtime', join(root, 'node_modules/@fixture/runtime'));
    mkdirSync(join(root, 'libs/runtime/dist'), { recursive: true });
    writeFileSync(join(root, 'libs/runtime/dist/index.cjs'), 'module.exports = "shared-stale-dist";\n');
    writeFileSync(join(root, 'libs/runtime/source.cjs'), 'module.exports = "shared-dirty-source";\n');
    return { root, main, head };
  }

  const commandRuntimeRoots = new Set<string>();
  afterEach(() => {
    for (const root of commandRuntimeRoots) rmSync(root, { recursive: true, force: true });
    commandRuntimeRoots.clear();
  });

  function commandEnvironment(overrides: NodeJS.ProcessEnv = {}) {
    // These small black-box fixtures must sweep their own scratch and share
    // their own admission locks, rather than wait on or reclaim host artifacts.
    const runtime = mkdtempSync(join(realpathSync(tmpdir()), 'lac-command-runtime-'));
    commandRuntimeRoots.add(runtime);
    return currentRunnerEnvironment({
      TMPDIR: runtime,
      PAPERCUSP_FS_MUTEX_LOCK_DIR: join(runtime, 'mutex'),
      PAPERCUSP_RELEASE_RETENTION_ROOT: join(runtime, 'leases'),
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(runtime, 'copy.lock'),
      ...overrides,
    });
  }

  function run(root: string, arbitrary = false) {
    return spawnSync(process.execPath, [scriptPath, 'lint:probe', ...(arbitrary ? ['--any'] : [])], {
      cwd: root, env: commandEnvironment(), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
  }

  it.each((['compatible', 'mismatched'] as const).flatMap(state =>
    (['explicit', 'recorded'] as const).map(route => ({ state, route }))))(
    'uses a $state dependency donor with the $route generation route without changing source authority', ({ state, route }) => {
    const f = fixture('node build.cjs');
    const env = commandEnvironment();
    const store = join(env.TMPDIR!, 'generations');
    if (route === 'explicit') env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = store;
    else delete env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
    const donor = mkdtempSync(join(env.TMPDIR!, mod.WORK_ROOT_PREFIX + 'explicit-donor-'));
    try {
      cpSync(f.root, donor, { recursive: true, verbatimSymlinks: true });
      // Only the canonical source records this route. A retained donor is a
      // disposable reader and cannot resolve a persistent store of its own.
      mkdirSync(join(f.root, '.papercusp'), { recursive: true });
      writeFileSync(join(f.root, '.papercusp/dependency-generation-root'), store + '\n');
      // The selected retained donor is the oldest idle kept tree, beyond the
      // runner's cap. Its own sweep must protect this input until copying ends.
      const now = Date.now();
      writeFileSync(join(donor, mod.OWNER_MARKER), JSON.stringify({
        pid: 2147483647, keep: true, createdAtMs: now - 3600_000,
        sha: f.head, dependencyMode: 'independent-copy-v1',
      }));
      const spareTrees = Array.from({ length: mod.MAX_IDLE_KEPT_TREES + 1 }, (_, i) => {
        const tree = join(env.TMPDIR!, mod.WORK_ROOT_PREFIX + 'idle-' + i);
        mkdirSync(join(tree, '.git'), { recursive: true });
        writeFileSync(join(tree, mod.OWNER_MARKER), JSON.stringify({
          pid: 2147483647, keep: true, createdAtMs: now - i * 1000,
        }));
        return tree;
      });
      const dependency = 'node_modules/fixture-dependency/index.cjs';
      for (const [root, value] of [[f.root, 'source-install'], [donor, 'donor-install']]) {
        mkdirSync(dirname(join(root, dependency)), { recursive: true });
        writeFileSync(join(root, dependency), `module.exports = ${JSON.stringify(value)};\n`);
      }
      // The donor has neither this commit nor its probe. The source checkout's
      // loose lockfile also differs, so selecting it as the donor must fail.
      const probe = readFileSync(join(f.root, 'probe.cjs'), 'utf8');
      snapshot(f.root, { 'probe.cjs': probe + `
require('node:assert/strict').equal(require('fixture-dependency/index.cjs'), 'donor-install');
require('node:assert/strict').deepEqual(
  require('node:fs').readdirSync(process.env.PAPERCUSP_RELEASE_RETENTION_ROOT).filter(name => name.startsWith('lease-agent-pin-')), []);
console.log('EXPLICIT_DONOR_SOURCE_OK');
` }, f.head);
      writeFileSync(join(f.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
      if (state === 'mismatched') writeFileSync(join(donor, 'package-lock.json'), '{"lockfileVersion":2}\n');
      const result = spawnSync(process.execPath, [scriptPath, 'lint:probe',
        '--workspace-dir=libs/runtime', '--dependency-donor=' + donor], {
        cwd: f.root, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      });
      const output = result.stdout + result.stderr;
      expect(existsSync(donor), output).toBe(true);
      expect(existsSync(spareTrees.at(-1)!)).toBe(false);
      // Both success and rejected materialization release the temporary pin.
      expect(readdirSync(env.PAPERCUSP_RELEASE_RETENTION_ROOT!).filter(name => name.startsWith('lease-agent-pin-'))).toEqual([]);
      if (state === 'compatible') {
        expect(result.status, output).toBe(0);
        expect(output).toContain('EXPLICIT_DONOR_SOURCE_OK');
        expect(output).toContain('CLONE_PREREQUISITES_OK');
      } else {
        expect(result.status, output).not.toBe(0);
        expect(output).toContain('dependency inputs differ');
        expect(output).not.toContain('EXPLICIT_DONOR_SOURCE_OK');
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
      rmSync(donor, { recursive: true, force: true });
    }
  }, 45_000);

  it.each(['--dependency-donor=', '--dependency-donor=/unused'])(
    'refuses an explicit donor without an exact workspace input scope (%s)', flag => {
      const result = spawnSync(process.execPath, [scriptPath, 'lint:probe', flag], {
        cwd: repoRoot, env: commandEnvironment(), encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain('--dependency-donor requires a non-empty path and --workspace-dir');
    });

  it.each(['pass', 'missing', 'failure', 'source-drift', 'receipts'] as const)(
    'shares one preparation across explicit checks while preserving %s evidence', async state => {
      const f = fixture('node build.cjs');
      try {
        const received = join(f.root, 'received.jsonl');
        const installed = join(f.root, 'node_modules/fixture-dependency/index.cjs');
        mkdirSync(dirname(installed), { recursive: true });
        writeFileSync(installed, 'module.exports = "original-install";\n');
        const { installLockNameForRoot } = await import(pathToFileURL(
          join(repoRoot, 'scripts/lib/install-lock-name.mjs')).href);
        const script = state === 'receipts' ? 'test:file' : 'lint:probe';
        snapshot(f.root, {
          ...(state === 'receipts' ? {
            'package.json': JSON.stringify({ private: true, scripts: { 'test:file': 'node probe.cjs' } }),
            'scripts/test-files.mjs': '// Fixture command; no external test runner or database.\n',
          } : {}),
          'probe.cjs': `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const arg = process.argv[2];
assert.equal(require('@fixture/runtime'), 'pinned-source');
assert.equal(require('fixture-dependency/index.cjs'), 'original-install');
const receipt = process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
const witness = process.env.PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT;
if (${JSON.stringify(state)} === 'receipts') {
  assert.ok(fs.existsSync(receipt));
  assert.equal(JSON.parse(fs.readFileSync(witness, 'utf8')).root, process.cwd());
}
fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ root: process.cwd(), pid: process.pid, arg, receipt, witness }) + '\\n');
(async () => {
  if (arg === 'first') {
    const { withFsMutex } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/lib/fs-mutex.mjs')).href)});
    await withFsMutex(${JSON.stringify(installLockNameForRoot(f.root))}, () => {
      fs.writeFileSync(${JSON.stringify(installed)}, 'module.exports = "new-install";\\n');
    }, { timeoutMs: 200, retryMs: 10 });
    if (${JSON.stringify(state)} === 'source-drift') fs.appendFileSync('probe.cjs', '// changed source\\n');
    if (${JSON.stringify(state)} === 'failure') process.exitCode = 7;
  } else assert.equal(arg, 'second with spaces');
})().catch(error => { console.error(error); process.exitCode = 9; });
` }, f.head);
        const result = spawnSync(process.execPath, [scriptPath,
          ...(state === 'receipts' ? ['--any'] : []),
          '--check=' + JSON.stringify({ script, args: ['first'] }),
          '--check=' + JSON.stringify({ script, args: [state === 'missing' ? 'absent.test.ts' : 'second with spaces'] }),
        ], { cwd: f.root, env: commandEnvironment(state === 'receipts'
          ? { PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://ledger.invalid' } : {}),
          encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
        const output = result.stdout + result.stderr;
        expect(result.status, output).toBe(state === 'pass' || state === 'receipts' ? 0 : 1);
        expect(result.stderr.match(/COMMITTED_DEPENDENCY_COPY state=started mode=donor path=node_modules/g)).toHaveLength(1);
        const executions = readFileSync(received, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(executions).toHaveLength(state === 'missing' || state === 'source-drift' ? 1 : 2);
        if (executions.length === 2) {
          expect(executions[0].root).toBe(executions[1].root);
          expect(executions[0].pid).not.toBe(executions[1].pid);
          expect(executions[1].arg).toBe('second with spaces');
        }
        if (state === 'receipts') {
          expect(executions[0].receipt).not.toBe(executions[1].receipt);
          expect(executions[0].witness).not.toBe(executions[1].witness);
          for (const execution of executions) expect(existsSync(dirname(execution.receipt))).toBe(false);
        }
        expect(output).toContain(`${script} [check 2]`);
        if (state === 'source-drift') expect(output).toContain('tracked source changed between checks');
        if (state === 'missing') expect(output).toContain('operand(s) absent');
        if (state === 'failure') expect(output).toContain('exit 7');
        expect(existsSync(executions[0].root)).toBe(false);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }, 40_000);

  it.each([
    ['root', 'matching'], ['root', 'stale'],
    ['workspace', 'matching'], ['workspace', 'stale'],
  ] as const)('checks a %s %s workspace lock before dependency preparation', (scope, state) => {
    const f = fixture('node build.cjs');
    try {
      const rootManifest = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
      rootManifest.workspaces = ['libs/runtime'];
      const workspaceManifest = JSON.parse(readFileSync(join(f.root, 'libs/runtime/package.json'), 'utf8'));
      const target = scope === 'root' ? rootManifest : workspaceManifest;
      target.devDependencies = { 'fixture-dep': state === 'stale' ? '1.0.0' : '2.0.0' };
      snapshot(f.root, {
        'package.json': JSON.stringify(rootManifest),
        'libs/runtime/package.json': JSON.stringify(workspaceManifest),
        'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
          '': scope === 'root' ? { devDependencies: { 'fixture-dep': '2.0.0' } } : {},
          'libs/runtime': scope === 'workspace' ? { devDependencies: { 'fixture-dep': '2.0.0' } } : {},
        } }),
      }, f.head);
      if (state === 'stale') {
        // Repairing the mutable donor must not hide invalid committed inputs.
        target.devDependencies['fixture-dep'] = '2.0.0';
        writeFileSync(join(f.root, scope === 'root' ? 'package.json' : 'libs/runtime/package.json'),
          JSON.stringify(target));
      }
      const result = run(f.root);
      if (state === 'matching') {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT');
        expect(result.stderr).toContain('fixture-dep');
        expect(result.stderr).toContain(scope === 'root' ? '<root>' : 'libs/runtime');
        expect(result.stderr).not.toContain('COMMITTED_DEPENDENCY_PHASE');
        expect(result.stdout).not.toMatch(/copied \d+ node_modules|building pinned runtime exports|CLONE_PREREQUISITES_OK/);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it.each(['valid', 'corrupt', 'selected-valid', 'selected-corrupt'] as const)('consumes a %s exact-input generation without borrowing its source', async variant => {
    const parent = mkdtempSync(join(tmpdir(), 'lac-generation-custody-'));
    const store = join(parent, 'generations');
    const f = fixture('node build.cjs');
    const workRoot = join(parent, 'snapshot');
    const helper = join(repoRoot, 'apps/operator/bin/release/dependency-generation.sh');
    const priorStore = process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
    const priorMutexRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    const workspaceDirs = variant.startsWith('selected-') ? ['libs/runtime'] : [];
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phases = () => diagnostics.mock.calls
      .filter(([line]) => typeof line === 'string' && line.startsWith('COMMITTED_DEPENDENCY_PHASE '))
      .map(([line]) => JSON.parse((line as string).slice('COMMITTED_DEPENDENCY_PHASE '.length)) as {
        phase: string; state: string; elapsedMs: number;
      });
    const makeWritable = (path: string) => {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) makeWritable(join(path, entry));
    };
    try {
      mkdirSync(join(f.root, 'node_modules/transitive'), { recursive: true });
      writeFileSync(join(f.root, 'node_modules/transitive/package.json'), '{"name":"transitive","version":"1.0.0"}');
      writeFileSync(join(f.root, 'node_modules/transitive/index.cjs'), 'module.exports = require("@fixture/runtime");\n');
      const head = snapshot(f.root, {
        'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
          'node_modules/transitive': { version: '1.0.0' },
          'node_modules/@fixture/runtime': { resolved: 'libs/runtime', link: true },
        } }),
      }, f.head);
      const published = spawnSync('bash', [helper, '--integration', f.root, '--generation-root', store,
        ...workspaceDirs.flatMap(path => ['--workspace-dir', path])], {
        env: currentRunnerEnvironment(), encoding: 'utf8', timeout: 30000,
      });
      const publicationDiagnostic = JSON.stringify({ error: published.error?.message,
        status: published.status, signal: published.signal }) + '\n' + published.stdout + published.stderr;
      expect(published.status, publicationDiagnostic).toBe(0);
      const identity = published.stdout.match(/identity=(v1-[0-9a-f]{64})/)![1];
      const generation = join(store, identity);
      const dependency = 'node_modules/transitive/index.cjs';
      gitFixture(f.root, ['clone', '--local', '--shared', '--quiet', f.root, workRoot]);
      const markerPath = join(workRoot, '.git/lint-as-committed-owner.json');
      const marker = { sha: head, sourceRepoRoot: f.root };
      writeFileSync(markerPath, JSON.stringify(marker));
      process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = store;
      if (variant.endsWith('corrupt')) {
        const selector = join(store, '.inputs', readdirSync(join(store, '.inputs'))[0]);
        writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
        await expect(mod.materializeIndependentDependencies(f.root, workRoot, { workspaceDirs })).rejects.toThrow(/independent dependency materialization failed/);
        expect(phases()).toEqual([
          { phase: 'generation-selection-and-copy', state: 'started', elapsedMs: expect.any(Number) },
          { phase: 'generation-selection-and-copy', state: 'failed', elapsedMs: expect.any(Number) },
        ]);
        expect(existsSync(join(workRoot, 'node_modules'))).toBe(false);
        expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(marker);
        return;
      }
      // A mutable donor cannot supply these bytes or even be enumerated now.
      rmSync(join(f.root, 'node_modules'), { recursive: true });
      const prepared = await mod.materializeIndependentDependencies(f.root, workRoot, { workspaceDirs });
      expect(phases().map(({ phase, state }) => [phase, state])).toEqual([
        ['generation-selection-and-copy', 'started'],
        ['repair-links', 'started'], ['repair-links', 'complete'],
        ['generation-selection-and-copy', 'complete'],
        ['workspace-build', 'started'], ['workspace-build', 'complete'],
        ['validate-and-publish', 'started'], ['validate-and-publish', 'complete'],
      ]);
      expect(phases().every(({ elapsedMs }) => Number.isInteger(elapsedMs) && elapsedMs >= 0)).toBe(true);
      mod.prepareWorkspaceExports(workRoot, prepared.workspacePaths);
      const clonedDependency = join(workRoot, dependency);
      expect(statSync(clonedDependency).ino).not.toBe(statSync(join(generation, 'tree', dependency)).ino);
      const requireClone = createRequire(join(workRoot, 'package.json'));
      expect(requireClone('transitive/index.cjs')).toBe('pinned-source');
      expect(realpathSync(requireClone.resolve('@fixture/runtime'))).toBe(join(workRoot, 'libs/runtime/dist/index.cjs'));
      writeFileSync(clonedDependency, 'module.exports = "clone-only";\n');
      expect(readFileSync(join(generation, 'tree', dependency), 'utf8')).toContain('require("@fixture/runtime")');
      const artifact = join(parent, 'artifact');
      writeFileSync(artifact, 'retained');
      await mod.retainCommittedWorkRoot(workRoot, head, artifact);
      const swept = spawnSync('bash', ['-c', 'source "$1"; dependency_generation_apply_retention "$2" "$3" 0',
        'retention-fixture', helper, store, f.root], { encoding: 'utf8', timeout: 30000 });
      expect(swept.status, swept.stdout + swept.stderr).toBe(0);
      expect(existsSync(generation)).toBe(false);
      // The retention directory selects records, while its writer uses the
      // global papercusp-disk-retention name. Isolate that mutex as well.
      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(parent, 'mutexes');
      expect(await mod.cleanupCommittedWorkRoot(workRoot, false, { dir: join(parent, 'retention-pins') })).toBe(false);
      delete requireClone.cache[requireClone.resolve('transitive/index.cjs')];
      expect(requireClone('transitive/index.cjs')).toBe('clone-only');
    } finally {
      diagnostics.mockRestore();
      if (priorStore === undefined) delete process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
      else process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = priorStore;
      if (priorMutexRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = priorMutexRoot;
      makeWritable(parent);
      rmSync(parent, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);

  it.each(['escaping-link', 'incomplete-copy', 'linked-root'] as const)
    ('refuses independent dependency custody for %s before publishing its marker', async defect => {
      const f = fixture('node build.cjs');
      const parent = mkdtempSync(join(tmpdir(), 'lac-independent-custody-'));
      const workRoot = join(parent, 'snapshot');
      const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        gitFixture(f.root, ['clone', '--local', '--shared', '--quiet', f.root, workRoot]);
        const markerPath = join(workRoot, '.git/lint-as-committed-owner.json');
        const marker = { sha: f.head, sourceRepoRoot: f.root };
        writeFileSync(markerPath, JSON.stringify(marker));
        if (defect === 'linked-root') {
          rmSync(join(f.root, 'node_modules'), { recursive: true });
          mkdirSync(join(f.root, 'installed'));
          symlinkSync('installed', join(f.root, 'node_modules'));
        } else {
          const target = defect === 'escaping-link' ? parent : './missing-package';
          symlinkSync(target, join(f.root, 'node_modules/broken-package'));
        }
        await expect(mod.materializeIndependentDependencies(f.root, workRoot)).rejects.toThrow(
          defect === 'linked-root' ? /independent dependency materialization failed/ :
            defect === 'escaping-link' ? /escapes its snapshot/ : /absent from its snapshot/,
        );
        const phases = diagnostics.mock.calls.map(([line]) => JSON.parse(
          (line as string).slice('COMMITTED_DEPENDENCY_PHASE '.length),
        ) as { phase: string; state: string });
        expect(phases.at(-1)).toMatchObject({
          phase: defect === 'incomplete-copy' ? 'validate-and-publish' : 'donor-copy',
          state: 'failed',
        });
        expect(phases).not.toContainEqual(expect.objectContaining({ phase: 'validate-and-publish', state: 'complete' }));
        expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(marker);
        if (defect !== 'linked-root') expect(lstatSync(join(workRoot, 'node_modules')).isDirectory()).toBe(true);
      } finally {
        diagnostics.mockRestore();
        rmSync(parent, { recursive: true, force: true });
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 30_000);

  it('releases the donor reader before the committed command while preserving independent dependency bytes', async () => {
    const f = fixture('node build.cjs');
    const installed = join(f.root, 'node_modules/fixture-dependency/index.cjs');
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, 'module.exports = "original-install";\n');
    const ready = join(f.root, 'reader-ready');
    const release = join(f.root, 'reader-release');
    const lockDir = join(f.root, 'mutexes');
    const { installLockNameForRoot } = await import(pathToFileURL(join(repoRoot, 'scripts/lib/install-lock-name.mjs')).href);
    const lockName = installLockNameForRoot(f.root);
    const probe = `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.ok(!(process.env.PAPERCUSP_INSTALL_MUTEX_HELD ?? '').split(',').includes(${JSON.stringify(lockName)}));
assert.equal(require('@fixture/runtime'), 'pinned-source');
const dependency = require.resolve('fixture-dependency/index.cjs');
assert.equal(require(dependency), 'original-install');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(timer);
    delete require.cache[dependency];
    assert.equal(require(dependency), 'original-install');
    assert.ok(fs.readFileSync(${JSON.stringify(installed)}, 'utf8').includes('new-install'));
    console.log('INDEPENDENT_DEPENDENCIES_OK');
  }
}, 10);
setTimeout(() => { if (!fs.existsSync(${JSON.stringify(release)})) process.exit(9); }, 15000).unref();
`;
    // Keep the pinned build behind the writer, so writer admission proves the
    // reader is released before either the build or the committed command ends.
    // Waiting for the command's ready file would include unrelated npm startup.
    const build = readFileSync(join(f.root, 'libs/runtime/build.cjs'), 'utf8');
    snapshot(f.root, {
      'probe.cjs': probe,
      'libs/runtime/build.cjs': `
const releaseGate = new Int32Array(new SharedArrayBuffer(4));
while (!require('node:fs').existsSync(${JSON.stringify(release)})) {
  Atomics.wait(releaseGate, 0, 0, 20);
}
${build}`,
    }, f.head);
    // A private mutex must guard private cleanup targets too. Otherwise startup
    // can sweep unrelated shared snapshots before this fixture reaches ready.
    const childTmp = mkdtempSync(join(tmpdir(), 'lac-reader-scratch-'));
    const childEnv = currentRunnerEnvironment({
      TMPDIR: childTmp,
      PAPERCUSP_RELEASE_RETENTION_ROOT: join(f.root, 'retention-pins'),
      PAPERCUSP_FS_MUTEX_LOCK_DIR: lockDir,
    });
    const child = spawn(process.execPath, [scriptPath, 'lint:probe'], {
      cwd: f.root, env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    try {
      const buildStarted = '"phase":"workspace-build","state":"started"';
      const deadline = Date.now() + 15000;
      while (!output.includes(buildStarted) && child.exitCode === null && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      if (!output.includes(buildStarted)) throw new Error(`Workspace build did not start (exit=${child.exitCode}): ${output}`);
      expect(output).toContain(` -> ${childTmp}/${mod.WORK_ROOT_PREFIX}`);
      // Reify the actual donor while the pinned build remains paused. The
      // command must later read the independent bytes after this writer completes.
      const writer = `const startedAt = performance.now();
console.log('WRITER_STARTED at=' + Date.now());
const { withFsMutex } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/lib/fs-mutex.mjs')).href)});
import { writeFileSync } from 'node:fs';
console.log('WRITER_IMPORTED elapsedMs=' + (performance.now() - startedAt));
await withFsMutex(${JSON.stringify(lockName)}, () => {
  writeFileSync(${JSON.stringify(installed)}, 'module.exports = "new-install";\\n');
  console.log('WRITER_ACQUIRED');
}, { timeoutMs: 200, retryMs: 10,
  onAcquired: timing => console.log('WRITER_ADMISSION ' + JSON.stringify(timing)),
  onTimedOut: timing => console.error('WRITER_TIMEOUT ' + JSON.stringify(timing)),
});
console.log('WRITER_RELEASED elapsedMs=' + (performance.now() - startedAt));`;
      const attempt = (phase: string) => {
        const started = Date.now();
        process.stderr.write('CASE_TRACE ' + JSON.stringify({ case: 'donor-writer', event: 'launch', phase, startedAt: started }) + '\n');
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {
          env: { ...process.env, PAPERCUSP_FS_MUTEX_LOCK_DIR: lockDir }, encoding: 'utf8', timeout: 5000,
        });
        const evidence = { case: 'donor-writer', event: 'exit', phase, ...fixtureProcessEvidence(run, started) };
        process.stderr.write('CASE_TRACE ' + JSON.stringify(evidence) + '\n');
        expect(run.status, JSON.stringify(evidence)).toBe(0);
        expect(run.stdout).toContain('WRITER_RELEASED');
        return run;
      };
      const concurrent = attempt('during-paused-build');
      expect(concurrent.stdout).toContain('WRITER_ACQUIRED');
      expect(child.exitCode).toBeNull();
      writeFileSync(release, 'release');
      expect(await exited, output).toBe(0);
      expect(existsSync(ready)).toBe(true);
      expect(output).toContain('INDEPENDENT_DEPENDENCIES_OK');
      // These records must reach the CLI's captured stderr, including when a
      // later timeout prevents setup from returning a final summary.
      expect(output).toContain('COMMITTED_DEPENDENCY_COPY state=started mode=donor path=node_modules');
      expect(output).toContain('COMMITTED_DEPENDENCY_COPY state=complete mode=donor path=node_modules elapsedSec=');
      expect(output).toContain('"phase":"workspace-build","state":"complete"');
      const acquired = attempt('after-command-exit');
      expect(acquired.stdout).toContain('WRITER_ACQUIRED');
    } finally {
      writeFileSync(release, 'release');
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
      rmSync(childTmp, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30000);

  function retainedFixture(rootName = 'snapshot') {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), 'lac-resume-'));
    // The real publisher imports direct sibling checkout pins during retention.
    // Keep that census inside this fixture, as the dependency-generation suite
    // does, rather than resolving every unrelated directory in shared /tmp.
    const f = fixture('node build.cjs', true, parent);
    const workRoot = join(parent, rootName);
    const manifest = JSON.parse(readFileSync(join(f.root, 'libs/runtime/package.json'), 'utf8'));
    f.head = snapshot(f.root, {
      'libs/runtime/package.json': JSON.stringify({ ...manifest, bin: { 'runtime-bin': 'dist/index.cjs' } }),
    }, f.head);
    mkdirSync(join(f.root, 'node_modules/.bin'));
    symlinkSync('../@fixture/runtime/dist/index.cjs', join(f.root, 'node_modules/.bin/runtime-bin'));
    for (const name of ['alpha', 'beta', 'gamma'])
      writeFileSync(join(f.root, 'node_modules', name + '.txt'), 'payload-v1');
    gitFixture(f.root, ['clone', '--local', '--shared', '--quiet', f.root, workRoot]);
    cpSync(join(f.root, 'node_modules'), join(workRoot, 'node_modules'), {
      recursive: true, dereference: false, verbatimSymlinks: true,
    });
    const markerPath = join(workRoot, '.git/lint-as-committed-owner.json');
    const marker = { sha: f.head, sourceRepoRoot: f.root };
    writeFileSync(markerPath, JSON.stringify(marker));
    const checkpointDir = join(parent, 'verification');
    const priorMutex = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    const priorRacy = process.env.DEPENDENCY_GENERATION_RACY_WINDOW_SEC;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(parent, 'mutexes');
    // The separate racy-window control below exercises conservative rehashing.
    process.env.DEPENDENCY_GENERATION_RACY_WINDOW_SEC = '0';
    const diagnostics = vi.spyOn(console, 'error').mockImplementation((line, ...args) => {
      if (typeof line !== 'string' || !/^COMMITTED_DEPENDENCY_(PHASE|VERIFICATION) /.test(line) || args.length)
        throw new Error('Unexpected retained-verification diagnostic: ' + String(line));
    });
    const options = (maxBatches = 64) => ({
      resumeVerification: { checkpointDir, batchSize: 6, maxBatches, maxDurationMs: 30_000 },
    });
    const cleanup = () => {
      diagnostics.mockRestore();
      if (priorMutex === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = priorMutex;
      if (priorRacy === undefined) delete process.env.DEPENDENCY_GENERATION_RACY_WINDOW_SEC;
      else process.env.DEPENDENCY_GENERATION_RACY_WINDOW_SEC = priorRacy;
      rmSync(parent, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    };
    return { ...f, parent, workRoot, markerPath, marker, checkpointDir, options, cleanup, diagnostics };
  }

  it('resolves the persistent generation store through a selected source reader', () => {
    const f = retainedFixture();
    const store = join(f.parent, 'persistent-store');
    const override = join(f.parent, 'explicit-store');
    try {
      writeFileSync(f.markerPath, JSON.stringify({
        ...f.marker,
        dependencyMode: 'independent-copy-v1',
        dependencyScope: { mode: 'selected', workspaceDirs: ['libs/runtime'] },
      }));
      mkdirSync(join(f.root, '.papercusp'), { recursive: true });
      writeFileSync(join(f.root, '.papercusp/dependency-generation-root'), store + '\n');

      // Config belongs to the original source; this selected reader cannot
      // satisfy an unscoped physical dependency-donor request.
      expect(() => mod.committedWorkRootDependencyDonor(f.workRoot)).toThrow('donor scope does not cover');
      expect(mod.lintAsCommittedChildEnv({}, f.workRoot).PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe(store);
      expect(mod.lintAsCommittedChildEnv({ PAPERCUSP_DEPENDENCY_GENERATION_ROOT: override }, f.workRoot)
        .PAPERCUSP_DEPENDENCY_GENERATION_ROOT).toBe(override);
      rmSync(join(f.root, '.papercusp/dependency-generation-root'));
      expect(mod.lintAsCommittedChildEnv({}, f.workRoot).PAPERCUSP_DEPENDENCY_GENERATION_ROOT)
        .toBe(join(f.root, '.papercusp/dependency-generations'));
    } finally { f.cleanup(); }
  });

  function expectUnpreparedRetainedMarker(f: ReturnType<typeof retainedFixture>) {
    const marker = JSON.parse(readFileSync(f.markerPath, 'utf8'));
    expect(marker).toMatchObject(f.marker);
    expect(marker).not.toHaveProperty('dependencyMode');
  }

  it.each([
    { side: 'donor', phase: 'before-hash', statCall: 1 },
    { side: 'donor', phase: 'after-hash', statCall: 2 },
    { side: 'destination', phase: 'before-hash', statCall: 1 },
    { side: 'destination', phase: 'after-hash', statCall: 2 },
  ])('retains exact metadata failure evidence for $side $phase', async ({ side, phase, statCall }) => {
    const f = retainedFixture();
    const path = 'node_modules/alpha.txt';
    const target = join(side === 'donor' ? f.root : f.workRoot, path);
    const mode = statSync(target).mode & 0o7777;
    const handle = await openFile(target, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalStat = prototype.stat;
    let targetStats = 0;
    // Change the real file at the descriptor-check boundary. GNU find's census
    // and the verifier's before/after reads still use actual filesystem state.
    const stat = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: { fd: number }, options) {
      if (readlinkSync('/proc/self/fd/' + this.fd) === target && ++targetStats === statCall)
        chmodSync(target, mode ^ 0o100);
      return originalStat.call(this, options);
    });
    const build = vi.fn();
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: build,
      })).rejects.toMatchObject({
        code: 'DEPENDENCY_METADATA_CHANGED',
        dependencyMetadata: { side, phase, path, differences: expect.objectContaining({
          mode: { expected: mode.toString(8), actual: (mode ^ 0o100).toString(8) },
        }) },
      });
      expect(targetStats).toBe(statCall);
      expect(build).not.toHaveBeenCalled();
      expectUnpreparedRetainedMarker(f);
    } finally { stat.mockRestore(); f.cleanup(); }
  }, 60_000);

  it('refuses donor ctime churn from another install reader without publishing a prepared copy', async () => {
    const f = retainedFixture();
    const target = join(f.root, 'node_modules/alpha.txt');
    const original = statSync(target, { bigint: true });
    const { withFsMutexRead } = await import(pathToFileURL(join(repoRoot, 'scripts/lib/fs-mutex.mjs')).href);
    const { installLockNameForRoot } = await import(pathToFileURL(join(repoRoot, 'scripts/lib/install-lock-name.mjs')).href);
    const handle = await openFile(target, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalStat = prototype.stat;
    let linked = false;
    const stat = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: { fd: number }, options) {
      if (!linked && readlinkSync('/proc/self/fd/' + this.fd) === target) {
        await withFsMutexRead(installLockNameForRoot(f.root), async () => {
          linkSync(target, join(f.parent, 'reader-snapshot.txt'));
          linked = true;
        });
      }
      return originalStat.call(this, options);
    });
    const build = vi.fn();
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: build,
      })).rejects.toMatchObject({
        code: 'DEPENDENCY_METADATA_CHANGED',
        dependencyMetadata: { side: 'donor', phase: 'before-hash', path: 'node_modules/alpha.txt',
          differences: { ctimeNs: { expected: String(original.ctimeNs), actual: expect.any(String) } } },
      });
      expect(linked).toBe(true);
      expect(statSync(target, { bigint: true }).mtimeNs).toBe(original.mtimeNs);
      expect(readFileSync(target)).toEqual(readFileSync(join(f.workRoot, 'node_modules/alpha.txt')));
      expect(build).not.toHaveBeenCalled();
      expectUnpreparedRetainedMarker(f);
    } finally { stat.mockRestore(); f.cleanup(); }
  }, 60_000);

  it('keeps nested CLI Git objects readable after its disposable source reader is retired', () => {
    const f = fixture('node build.cjs');
    const subPath = 'libs/child';
    const subRoot = join(f.root, subPath);
    mkdirSync(subRoot, { recursive: true });
    gitFixture(subRoot, ['init', '--quiet', '--initial-branch=staging']);
    const subPin = snapshot(subRoot, { 'pinned.cjs': 'module.exports = "pinned-child";\n' });
    gitFixture(f.root, ['update-index', '--add', '--cacheinfo', '160000', subPin, subPath]);
    snapshot(f.root, {
      '.gitmodules': `[submodule "child"]\n path = ${subPath}\n url = ./${subPath}\n`,
    }, f.head);
    const env = commandEnvironment();
    env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = join(env.TMPDIR!, 'generations');
    const roots: string[] = [];
    const prepare = (cwd: string) => {
      const result = spawnSync(process.execPath, [scriptPath,
        '--materialize-only', '--workspace-dir=libs/runtime'], {
        cwd, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      });
      const output = result.stdout + result.stderr;
      const root = output.match(/Committed source prepared at (.+); no lint or test was run\./)?.[1];
      if (root) roots.push(root);
      expect(result.status, output).toBe(0);
      expect(root, output).toBeTruthy();
      return root!;
    };
    try {
      const reader = prepare(f.root);
      const nested = prepare(reader);
      rmSync(reader, { recursive: true, force: true });
      // HEAD's hex value alone survives a missing alternate. Reading a pinned
      // blob proves the nested checkout still has its actual Git objects.
      const blob = spawnSync('git', ['show', 'HEAD:libs/runtime/source.cjs'], {
        cwd: nested, encoding: 'utf8', timeout: 5000,
      });
      expect(blob.status, blob.stderr).toBe(0);
      expect(blob.stdout).toBe('module.exports = "pinned-source";\n');
      const childBlob = spawnSync('git', ['show', 'HEAD:pinned.cjs'], {
        cwd: join(nested, subPath), encoding: 'utf8', timeout: 5000,
      });
      expect(childBlob.status, childBlob.stderr).toBe(0);
      expect(childBlob.stdout).toBe('module.exports = "pinned-child";\n');
      expect(realpathSync(readFileSync(join(nested, '.git/objects/info/alternates'), 'utf8').trim()))
        .toBe(realpathSync(join(f.root, '.git/objects')));
      expect(JSON.parse(readFileSync(join(nested, mod.OWNER_MARKER), 'utf8')).sourceRepoRoot)
        .toBe(realpathSync(f.root));
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 75_000);

  it('materializes selected dependency scope through the maintained CLI', () => {
    const f = fixture('node build.cjs');
    let preparedRoot: string | undefined;
    try {
      const unrelated = join(f.root, 'apps/unrelated');
      mkdirSync(join(unrelated, 'node_modules/leaf'), { recursive: true });
      writeFileSync(join(unrelated, 'package.json'), '{"name":"unrelated"}');
      writeFileSync(join(unrelated, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(unrelated, 'node_modules/leaf/index.cjs'), 'module.exports = true;');
      const result = spawnSync(process.execPath, [scriptPath, '--materialize-only', '--workspace-dir=libs/runtime'], {
        cwd: f.root, env: commandEnvironment(), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      });
      const output = result.stdout + result.stderr;
      preparedRoot = output.match(/Committed source prepared at (.+); no lint or test was run\./)?.[1];
      expect(result.status, output).toBe(0);
      expect(preparedRoot).toBeTruthy();
      expect(JSON.parse(readFileSync(join(preparedRoot!, '.git/lint-as-committed-owner.json'), 'utf8')))
        .toMatchObject({ sha: f.head, dependencyMode: 'independent-copy-v1',
          dependencyScope: { mode: 'selected', workspaceDirs: ['libs/runtime'] } });
      expect(existsSync(join(preparedRoot!, 'apps/unrelated/node_modules'))).toBe(false);
      expect(readFileSync(join(preparedRoot!, 'libs/runtime/dist/index.cjs'), 'utf8')).toContain('pinned-source');
      expect(gitFixture(preparedRoot!, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    } finally {
      if (preparedRoot) rmSync(preparedRoot, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 40_000);

  it.each(['selected-library', 'selected-app', 'full'] as const)
    ('respects asset lifecycle scope through the maintained CLI (%s)', scope => {
      const f = fixture('node build.cjs');
      const app = 'apps/asset-app';
      let preparedRoot: string | undefined;
      const manifest = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
      snapshot(f.root, {
        'package.json': JSON.stringify({ ...manifest, workspaces: ['libs/runtime', app] }),
        [app + '/package.json']: JSON.stringify({ name: '@fixture/asset-app',
          scripts: { postinstall: 'node scripts/setup-fixture-runtime.cjs' } }),
        [app + '/.gitignore']: 'public/\n',
        [app + '/scripts/setup-fixture-runtime.cjs']: `
const fs = require('node:fs');
const asset = require('asset-bits');
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/runtime-ready', asset);
`,
      }, f.head);
      symlinkSync('../../' + app, join(f.root, 'node_modules/@fixture/asset-app'));
      mkdirSync(join(f.root, app, 'node_modules/asset-bits'), { recursive: true });
      writeFileSync(join(f.root, app, 'node_modules/asset-bits/index.js'), 'module.exports = "pinned-asset";');
      const selection = scope === 'full' ? [] : ['--workspace-dir=' + (scope === 'selected-app' ? app : 'libs/runtime')];
      try {
        const result = spawnSync(process.execPath, [scriptPath, 'lint:probe', '--any', '--keep', ...selection], {
          cwd: f.root, env: commandEnvironment(), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
        });
        const output = result.stdout + result.stderr;
        preparedRoot = output.match(/--keep: extracted tree left at (\S+)/)?.[1];
        expect(result.status, output).toBe(0);
        expect(preparedRoot, output).toBeTruthy();
        expect(output).toContain('CLONE_PREREQUISITES_OK');
        const assetPath = join(preparedRoot!, app, 'public/runtime-ready');
        if (scope === 'selected-library') {
          expect(existsSync(join(preparedRoot!, app, 'node_modules'))).toBe(false);
          expect(existsSync(assetPath)).toBe(false);
          expect(output).not.toContain('preparing pinned runtime assets: @fixture/asset-app');
        } else {
          expect(readFileSync(assetPath, 'utf8')).toBe('pinned-asset');
          expect(output).toContain('preparing pinned runtime assets: @fixture/asset-app');
        }
      } finally {
        if (preparedRoot) rmSync(preparedRoot, { recursive: true, force: true });
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 40_000);

  it.each(['copy', 'resume'] as const)('prepares only selected workspace dependencies with durable scope (%s)', async mode => {
    const f = retainedFixture();
    const selected = 'libs/runtime/node_modules/leaf/index.cjs';
    const unrelated = 'apps/unrelated/node_modules/leaf/index.cjs';
    for (const path of [selected, unrelated]) {
      mkdirSync(dirname(join(f.root, path)), { recursive: true });
      writeFileSync(join(f.root, path), 'module.exports = "independent-leaf";');
    }
    mkdirSync(join(f.root, 'apps/unrelated'), { recursive: true });
    writeFileSync(join(f.root, 'apps/unrelated/package.json'), '{"name":"unrelated"}');
    writeFileSync(join(f.root, 'apps/unrelated/package-lock.json'), '{"lockfileVersion":3}');
    const scope = { mode: 'selected', workspaceDirs: ['libs/runtime'] };
    try {
      const result = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        workspaceDirs: ['libs/runtime', 'libs/runtime'],
        ...(mode === 'resume' ? { resumeVerification: {
          ...f.options().resumeVerification, materializeMissing: true,
        } } : {}),
        prepareWorkspace: (s: { workspacePaths: Set<string> }) =>
          mod.prepareWorkspaceExports(f.workRoot, s.workspacePaths),
      });
      expect(result.paths.slice().sort()).toEqual(['libs/runtime/node_modules', 'node_modules']);
      expect(readFileSync(join(f.workRoot, selected))).toEqual(readFileSync(join(f.root, selected)));
      expect(statSync(join(f.workRoot, selected)).ino).not.toBe(statSync(join(f.root, selected)).ino);
      expect(existsSync(join(f.workRoot, unrelated))).toBe(false);
      expect(result.dependencyScope).toEqual(scope);
      const marker = JSON.parse(readFileSync(f.markerPath, 'utf8'));
      expect(marker).toMatchObject({ dependencyMode: 'independent-copy-v1', dependencyScope: scope });
      const receiptPath = join(f.parent, 'prepared.json');
      mod.writePreparedWorkRootReceipt(f.workRoot, f.head, receiptPath);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).dependencyScope).toEqual(scope);
      expect(() => mod.committedWorkRootDependencyDonor(f.workRoot)).toThrow('donor scope does not cover');
      expect(mod.committedWorkRootDependencyDonor(f.workRoot, { workspaceDirs: ['libs/runtime'] })).toBe(f.workRoot);
      expect(mod.committedWorkRootDependencyDonor(f.workRoot, { sourceObjects: true })).toBe(f.root);
      if (mode === 'resume') {
        expect(result.status).toBe('complete');
        expect(JSON.parse(readFileSync(join(f.checkpointDir, 'manifest.json'), 'utf8')).data.scope).toEqual(scope);
      }
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['package-lock.json', 'patches/root.patch', 'libs/runtime/package-lock.json',
    'libs/runtime/patches/local.patch'])('rejects selected-scope input drift at %s', async path => {
    const f = retainedFixture();
    mkdirSync(dirname(join(f.root, path)), { recursive: true });
    writeFileSync(join(f.root, path), 'changed input');
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), workspaceDirs: ['libs/runtime'],
      })).rejects.toThrow('dependency inputs differ');
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('rejects widening the workspace scope of an interrupted verification journal', async () => {
    const f = retainedFixture();
    try {
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(1), workspaceDirs: ['libs/runtime'],
      });
      expect(paused.status).toBe('incomplete');
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toMatchObject({ code: 'DEPENDENCY_JOURNAL_BINDING_CHANGED',
          dependencyJournalBinding: { diagnosticStatus: 'available', changes: {
            scope: { previous: expect.stringMatching(/^[a-f0-9]{64}$/), current: expect.stringMatching(/^[a-f0-9]{64}$/) },
          } } });
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['sourceCommit', 'materializer', 'inputs', 'trees', 'semantic'] as const)
    ('explains retained journal binding drift in %s without replacing saved proof', async component => {
      const f = retainedFixture();
      const { verifyRetainedDependencies } = await import(resolve(repoRoot, 'scripts/lib/committed-dependency-verification.mjs'));
      const materializer = join(f.parent, 'materializer.sh');
      writeFileSync(materializer, 'source ' + JSON.stringify(join(repoRoot, 'apps/operator/bin/release/dependency-generation.sh')) + '\n');
      const context = { sourceCommit: f.head, materializer, verifySource: vi.fn() };
      const verify = () => verifyRetainedDependencies(f.root, f.workRoot, f.options(1).resumeVerification, context);
      try {
        expect((await verify()).status).toBe('incomplete');
        const manifestPath = join(f.checkpointDir, 'manifest.json');
        const before = readFileSync(manifestPath);
        const manifest = JSON.parse(before.toString()).data;
        expect(manifest.bindingComponents.verifierFingerprint).toMatch(/^[a-f0-9]{64}$/);
        const batchPath = join(f.checkpointDir, 'batch-00000000.json');
        const batchBefore = readFileSync(batchPath);
        if (component === 'sourceCommit') context.sourceCommit = 'different-source';
        if (component === 'materializer') writeFileSync(materializer, readFileSync(materializer, 'utf8') + '# changed helper\n');
        if (component === 'inputs') for (const root of [f.root, f.workRoot])
          writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
        if (component === 'trees') {
          const saved = join(f.parent, 'old-dependencies');
          renameSync(join(f.workRoot, 'node_modules'), saved);
          cpSync(saved, join(f.workRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
        }
        if (component === 'semantic') for (const root of [f.root, f.workRoot])
          writeFileSync(join(root, 'node_modules/alpha.txt'), 'longer matching payload');
        await expect(verify()).rejects.toMatchObject({
          code: 'DEPENDENCY_JOURNAL_BINDING_CHANGED',
          dependencyJournalBinding: { previousBinding: manifest.binding,
            currentBinding: expect.stringMatching(/^[a-f0-9]{64}$/), diagnosticStatus: 'available',
            changes: { [component]: { previous: manifest.bindingComponents[component], current: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
        });
        expect(readFileSync(manifestPath)).toEqual(before);
        expect(readFileSync(batchPath)).toEqual(batchBefore);
        expectUnpreparedRetainedMarker(f);
      } finally { f.cleanup(); }
    }, 60_000);

  it('keeps legacy aggregate-only journals fail-closed with explicit unavailable diagnostics', async () => {
    const f = retainedFixture();
    try {
      expect((await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(1), workspaceDirs: ['libs/runtime'],
      })).status).toBe('incomplete');
      const manifestPath = join(f.checkpointDir, 'manifest.json');
      const entry = JSON.parse(readFileSync(manifestPath, 'utf8'));
      delete entry.data.bindingComponents;
      entry.sha256 = createHash('sha256').update(JSON.stringify(entry.data)).digest('hex');
      writeFileSync(manifestPath, JSON.stringify(entry));
      const before = readFileSync(manifestPath);
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toMatchObject({ code: 'DEPENDENCY_JOURNAL_BINDING_CHANGED',
          dependencyJournalBinding: { diagnosticStatus: 'unavailable-legacy-or-invalid-components', changes: null } });
      expect(readFileSync(manifestPath)).toEqual(before);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['../runtime', '/tmp/runtime', 'libs//runtime', 'libs/runtime/../runtime'])
    ('rejects invalid dependency workspace scope %s before retaining source', async path => {
      const f = retainedFixture();
      try {
        await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
          ...f.options(), workspaceDirs: [path],
        })).rejects.toThrow('invalid workspaceDirs');
        expect(existsSync(f.checkpointDir)).toBe(false);
        expectUnpreparedRetainedMarker(f);
      } finally { f.cleanup(); }
    });

  it.each(['donor', 'destination'])('verifies retained release bookkeeping on only the %s', async side => {
    const f = retainedFixture();
    const root = side === 'donor' ? f.root : f.workRoot;
    try {
      writeFileSync(join(root, 'node_modules/.papercusp-source-package-lock.json'), '{"lockfileVersion":3}');
      const result = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: (s: { workspacePaths: Set<string> }) =>
          mod.prepareWorkspaceExports(f.workRoot, s.workspacePaths),
      });
      expect(result.status).toBe('complete');
      expect(readFileSync(join(f.workRoot, 'node_modules/alpha.txt'), 'utf8')).toBe('payload-v1');
      expect(JSON.parse(readFileSync(f.markerPath, 'utf8')).dependencyMode).toBe('independent-copy-v1');
    } finally { f.cleanup(); }
  }, 60_000);

  it('keeps nested release bookkeeping names in the retained runtime census', async () => {
    const f = retainedFixture();
    const nested = join(f.root, 'node_modules/leaf/.papercusp-source-package-lock.json');
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, 'runtime package data');
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow('dependency census differs');
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('does not let retained release bookkeeping mask changed runtime bytes', async () => {
    const f = retainedFixture();
    try {
      writeFileSync(join(f.root, 'node_modules/.papercusp-source-package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(f.workRoot, 'node_modules/alpha.txt'), 'payload-v2');
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow('dependency bytes differ: node_modules/alpha.txt');
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('resumes verified batches without recopying and releases its reader before workspace preparation', async () => {
    const f = retainedFixture();
    const files = ['alpha', 'beta', 'gamma'].map(name => join(f.workRoot, 'node_modules', name + '.txt'));
    const before = files.map(path => ({ inode: statSync(path).ino, bytes: readFileSync(path) }));
    const build = vi.fn((copied: { workspacePaths: Set<string> }) => {
      const lockHelper = pathToFileURL(join(repoRoot, 'scripts/lib/fs-mutex.mjs')).href;
      const installHelper = pathToFileURL(join(repoRoot, 'scripts/lib/install-lock-name.mjs')).href;
      const writer = [
        'import {withFsMutex} from ' + JSON.stringify(lockHelper) + ';',
        'import {installLockNameForRoot} from ' + JSON.stringify(installHelper) + ';',
        'await withFsMutex(installLockNameForRoot(' + JSON.stringify(f.root) + '), () => {}, {timeoutMs: 250});',
      ].join('\n');
      const attempt = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {
        env: currentRunnerEnvironment(), encoding: 'utf8', timeout: 5000,
      });
      expect(attempt.status, attempt.stderr).toBe(0);
      mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths);
    });
    try {
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot,
        { ...f.options(1), prepareWorkspace: build });
      expect(paused.status).toBe('incomplete');
      expect(paused.progress.hashedFiles).toBeGreaterThan(0);
      expect(paused.progress).toMatchObject({ phase: 'hash-batches', scannedTrees: 1, totalTrees: 1 });
      expect(build).not.toHaveBeenCalled();
      expectUnpreparedRetainedMarker(f);
      const prepared = await mod.materializeIndependentDependencies(f.root, f.workRoot,
        { ...f.options(), prepareWorkspace: build });
      expect(prepared.status).toBe('complete');
      expect(prepared.verification.reusedBatches).toBeGreaterThan(0);
      expect(f.diagnostics).toHaveBeenCalledWith(expect.stringMatching(/^COMMITTED_DEPENDENCY_VERIFICATION /));
      expect(build).toHaveBeenCalledOnce();
      expect(realpathSync(join(f.workRoot, 'node_modules/.bin/runtime-bin')))
        .toBe(join(f.workRoot, 'libs/runtime/dist/index.cjs'));
      expect(JSON.parse(readFileSync(f.markerPath, 'utf8')).dependencyMode).toBe('independent-copy-v1');
      for (const [index, path] of files.entries()) {
        expect(statSync(path).ino).toBe(before[index].inode);
        expect(readFileSync(path)).toEqual(before[index].bytes);
      }
    } finally { f.cleanup(); }
  }, 60_000);

  it('retains resumed dependency work across idle sweeps until its journal is removed', async () => {
    const f = retainedFixture(mod.WORK_ROOT_PREFIX + 'active-resume');
    Object.assign(f.marker, { pid: 0, keep: true, createdAtMs: Date.now() });
    writeFileSync(f.markerPath, JSON.stringify(f.marker));
    const sweep = () => mod.sweepStaleWorkRoots({
      root: f.parent, cwds: [f.root], isAlive: () => false, maxIdleKept: 0,
    });
    try {
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1));
      expect(paused.status).toBe('incomplete');
      const first = await sweep();
      expect(first.removed).toEqual([]);
      expect(existsSync(f.workRoot)).toBe(true);
      const prepared = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(),
        prepareWorkspace: (s: { workspacePaths: Set<string> }) =>
          mod.prepareWorkspaceExports(f.workRoot, s.workspacePaths),
      });
      expect(prepared.status).toBe('complete');
      expect(prepared.verification.reusedBatches).toBeGreaterThan(0);
      expect((await sweep()).removed).toEqual([]);
      expect(await mod.cleanupCommittedWorkRoot(f.workRoot)).toBe(false);
      rmSync(f.checkpointDir, { recursive: true, force: true });
      expect((await sweep()).removed).toContainEqual({
        name: mod.WORK_ROOT_PREFIX + 'active-resume', reason: 'keep-over-cap',
      });
      expect(existsSync(f.workRoot)).toBe(false);
    } finally { f.cleanup(); }
  }, 60_000);

  it('finishes an interrupted two-root copy without replacing the completed root or publishing early', async () => {
    const f = retainedFixture();
    const retained = join(f.workRoot, 'node_modules/alpha.txt');
    const before = statSync(retained).ino;
    const missing = 'libs/runtime/node_modules/leaf/index.cjs';
    mkdirSync(dirname(join(f.root, missing)), { recursive: true });
    writeFileSync(join(f.root, missing), 'module.exports = "recovered-leaf";');
    const build = vi.fn((copied: { workspacePaths: Set<string> }) =>
      mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths));
    const options = (maxBatches = 64) => ({ ...f.options(maxBatches), prepareWorkspace: build,
      resumeVerification: { ...f.options(maxBatches).resumeVerification, materializeMissing: true } });
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow('dependency tree census differs');
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, options(1));
      expect(paused.status).toBe('incomplete');
      expect(paused.progress.materializedTrees).toBe(1);
      expect(build).not.toHaveBeenCalled();
      expectUnpreparedRetainedMarker(f);
      const leafInode = statSync(join(f.workRoot, missing)).ino;
      const complete = await mod.materializeIndependentDependencies(f.root, f.workRoot, options());
      expect(complete.status).toBe('complete');
      expect(complete.verification.materializedTrees).toBe(0);
      expect(complete.verification.reusedBatches).toBeGreaterThan(0);
      expect(complete.paths).toEqual(['libs/runtime/node_modules', 'node_modules']);
      expect(build).toHaveBeenCalledOnce();
      expect(statSync(retained).ino).toBe(before);
      expect(readFileSync(retained, 'utf8')).toBe('payload-v1');
      expect(statSync(join(f.workRoot, missing)).ino).toBe(leafInode);
      expect(leafInode).not.toBe(statSync(join(f.root, missing)).ino);
      expect(readFileSync(join(f.workRoot, missing))).toEqual(readFileSync(join(f.root, missing)));
      expect(JSON.parse(readFileSync(f.markerPath, 'utf8')).dependencyMode).toBe('independent-copy-v1');
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['tampered-root', 'input-drift', 'extra-root'] as const)
    ('keeps partial-root recovery fail-closed for %s', async defect => {
      const f = retainedFixture();
      const missing = 'libs/runtime/node_modules/leaf/index.cjs';
      mkdirSync(dirname(join(f.root, missing)), { recursive: true });
      writeFileSync(join(f.root, missing), 'module.exports = "recovered-leaf";');
      if (defect === 'tampered-root') writeFileSync(join(f.workRoot, 'node_modules/alpha.txt'), 'payload-v2');
      if (defect === 'input-drift') writeFileSync(join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
      if (defect === 'extra-root') mkdirSync(join(f.workRoot, 'libs/node_modules'), { recursive: true });
      const build = vi.fn();
      try {
        await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
          ...f.options(), prepareWorkspace: build,
          resumeVerification: { ...f.options().resumeVerification, materializeMissing: true },
        })).rejects.toThrow(defect === 'tampered-root' ? 'dependency bytes differ' :
          defect === 'input-drift' ? 'dependency inputs differ' : 'dependency tree census differs');
        expect(build).not.toHaveBeenCalled();
        expectUnpreparedRetainedMarker(f);
        if (defect !== 'tampered-root') expect(existsSync(join(f.workRoot, missing))).toBe(false);
      } finally { f.cleanup(); }
    }, 60_000);

  it('reuses verified batches across serial and parallel census scheduling', async () => {
    const f = retainedFixture();
    const priorJobs = process.env.DEPENDENCY_GENERATION_WALK_JOBS;
    try {
      for (const root of [f.root, f.workRoot]) {
        const leaf = join(root, 'libs/runtime/node_modules/leaf');
        mkdirSync(leaf, { recursive: true });
        writeFileSync(join(leaf, 'package.json'), '{"name":"leaf","version":"1.0.0"}');
        writeFileSync(join(leaf, 'index.cjs'), 'module.exports = "independent-leaf";');
      }
      process.env.DEPENDENCY_GENERATION_WALK_JOBS = '1';
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1));
      expect(paused.status).toBe('incomplete');
      expect(paused.progress).toMatchObject({ phase: 'hash-batches', scannedTrees: 2, totalTrees: 2 });
      process.env.DEPENDENCY_GENERATION_WALK_JOBS = '4';
      const complete = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: (copied: { workspacePaths: Set<string> }) =>
          mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths),
      });
      expect(complete.status).toBe('complete');
      expect(complete.paths).toEqual(['libs/runtime/node_modules', 'node_modules']);
      expect(complete.verification.reusedBatches).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(f.markerPath, 'utf8')).dependencyMode).toBe('independent-copy-v1');
    } finally {
      if (priorJobs === undefined) delete process.env.DEPENDENCY_GENERATION_WALK_JOBS;
      else process.env.DEPENDENCY_GENERATION_WALK_JOBS = priorJobs;
      f.cleanup();
    }
  }, 60_000);

  it.each(['valid', 'corrupt-selector', 'different-bytes', 'live-donor-hardlink-churn',
    'selected-valid', 'selected-wrong-scope', 'selected-corrupt-selector'] as const)
    ('resumes against a leased exact-input generation without source lockfiles using its supplied environment (%s)', async variant => {
      const f = retainedFixture();
      const helper = join(repoRoot, 'apps/operator/bin/release/dependency-generation.sh');
      const store = join(f.parent, 'generations');
      const priorStore = process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
      const selected = variant.startsWith('selected-');
      const makeWritable = (path: string) => {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) return;
        chmodSync(path, 0o700);
        for (const name of readdirSync(path)) makeWritable(join(path, name));
      };
      try {
        expect(dirname(f.root)).toBe(f.parent);
        expect(dirname(f.workRoot)).toBe(f.parent);
        // The real publisher requires every installed entry to realize a lock.
        // Put the generic byte fixtures inside a genuine installed package.
        for (const root of [f.root, f.workRoot]) {
          const payload = join(root, 'node_modules/payload');
          mkdirSync(payload);
          writeFileSync(join(payload, 'package.json'), '{"name":"payload","version":"1.0.0"}');
          for (const name of ['alpha', 'beta', 'gamma']) {
            const path = join(root, 'node_modules', name + '.txt');
            writeFileSync(join(payload, name + '.txt'), readFileSync(path));
            rmSync(path);
          }
        }
        const head = snapshot(f.root, { 'package-lock.json': JSON.stringify({
          lockfileVersion: 3, packages: {
            'node_modules/payload': { version: '1.0.0' },
            'node_modules/@fixture/runtime': { resolved: 'libs/runtime', link: true },
          },
        }) }, f.head);
        gitFixture(f.workRoot, ['fetch', '--quiet', f.root, head]);
        gitFixture(f.workRoot, ['checkout', '--detach', '--quiet', head]);
        f.marker.sha = head;
        writeFileSync(f.markerPath, JSON.stringify(f.marker));
        const publishScope = selected && variant !== 'selected-wrong-scope' ? ['--workspace-dir', 'libs/runtime'] : [];
        const published = spawnSync('bash', [helper, '--integration', f.root, '--generation-root', store, ...publishScope], {
          env: currentRunnerEnvironment(), encoding: 'utf8', timeout: 30_000,
        });
        const publicationDiagnostic = JSON.stringify({ error: published.error?.message,
          status: published.status, signal: published.signal }) + '\n' + published.stdout + published.stderr;
        expect(published.status, publicationDiagnostic).toBe(0);
        const identity = published.stdout.match(/identity=(v1-[0-9a-f]{64})/)![1];
        const generation = join(store, identity);
        expect(existsSync(join(generation, 'tree/package.json'))).toBe(false);
        expect(existsSync(join(generation, 'tree/package-lock.json'))).toBe(false);
        if (variant === 'selected-wrong-scope') {
          // Even an aliased scoped key cannot authorize a full publication.
          const scopedInput = spawnSync('bash', ['-c',
            'set -euo pipefail\nsource "$1"\n' +
            'dependency_generation_configure_workspace_dirs "$2" libs/runtime\n' +
            'dependency_generation_verification_selector_key "$2"', '--', helper, f.workRoot], {
            env: currentRunnerEnvironment(), encoding: 'utf8', timeout: 10_000,
          });
          expect(scopedInput.status, scopedInput.stderr).toBe(0);
          const input = scopedInput.stdout.trim();
          expect(input).toMatch(/^scoped-[a-f0-9]{64}$/);
          const selectors = join(store, '.inputs');
          const original = readFileSync(join(selectors, readdirSync(selectors)[0]), 'utf8');
          writeFileSync(join(selectors, input), original.replace(/^input=.*$/m, 'input=' + input));
        }
        // The caller's resolved store must survive a different process default,
        // including when verification resumes without copying dependencies.
        process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = join(f.parent, 'unselected-generations');
        // The generation owns independent bytes. A separate install reader can
        // change the mutable donor's ctime without changing this proof source.
        const livePayload = join(f.root, 'node_modules/payload/alpha.txt');
        const immutablePayload = join(generation, 'tree/node_modules/payload/alpha.txt');
        const generationStat = statSync(immutablePayload, { bigint: true });
        if (variant === 'live-donor-hardlink-churn') {
          const donorStat = statSync(livePayload, { bigint: true });
          expect(generationStat.ino).not.toBe(donorStat.ino);
          linkSync(livePayload, join(f.parent, 'live-reader-snapshot.txt'));
          expect(statSync(livePayload, { bigint: true }).ctimeNs).not.toBe(donorStat.ctimeNs);
          expect(statSync(immutablePayload, { bigint: true }).ctimeNs).toBe(generationStat.ctimeNs);
        } else {
          // No mutable install may supply the comparison after publication.
          rmSync(join(f.root, 'node_modules'), { recursive: true });
        }
        const retained = join(f.workRoot, 'node_modules/payload/alpha.txt');
        const inode = statSync(retained).ino;
        const options = (maxBatches = 64) => ({
          environment: { ...process.env, PAPERCUSP_DEPENDENCY_GENERATION_ROOT: store },
          workspaceDirs: selected ? ['libs/runtime'] : [],
          resumeVerification: { ...f.options(maxBatches).resumeVerification, generation: true },
        });
        const leases = () => existsSync(join(store, '.leases')) ? readdirSync(join(store, '.leases')) : [];
        if (variant === 'corrupt-selector' || variant === 'selected-corrupt-selector' || variant === 'selected-wrong-scope') {
          if (variant === 'corrupt-selector' || variant === 'selected-corrupt-selector') {
            const selector = join(store, '.inputs', readdirSync(join(store, '.inputs'))[0]);
            writeFileSync(selector, readFileSync(selector, 'utf8').replace(/^token=.*$/m, 'token=v3:' + '0'.repeat(64)));
          }
          await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, options()))
            .rejects.toThrow(variant === 'selected-wrong-scope' ? /invalid publication token/ : /census failed/);
        } else if (variant === 'different-bytes') {
          writeFileSync(retained, 'PAYLOAD-V1');
          await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, options()))
            .rejects.toThrow(/dependency bytes differ/);
        } else {
          const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, options(1));
          expect(paused.status).toBe('incomplete');
          expect(paused.progress.hashedFiles).toBeGreaterThan(0);
          expect(leases()).toEqual([]);
          expectUnpreparedRetainedMarker(f);
          const complete = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
            ...options(), prepareWorkspace: (copied: { workspacePaths: Set<string> }) =>
              mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths),
          });
          expect(complete.status).toBe('complete');
          expect(complete.verification.reusedBatches).toBeGreaterThan(0);
          expect(JSON.parse(readFileSync(f.markerPath, 'utf8')).dependencyMode).toBe('independent-copy-v1');
        }
        expect(leases()).toEqual([]);
        expect(statSync(retained).ino).toBe(inode);
        if (variant === 'corrupt-selector' || variant === 'selected-corrupt-selector' || variant === 'different-bytes' || variant === 'selected-wrong-scope')
          expectUnpreparedRetainedMarker(f);
      } finally {
        if (priorStore === undefined) delete process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT;
        else process.env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT = priorStore;
        makeWritable(store);
        f.cleanup();
      }
    }, 60_000);

  it.each(['donor', 'destination'] as const)('rehashes and rejects same-size %s changes with restored mtime', async side => {
    const f = retainedFixture();
    try {
      const paused = await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1));
      expect(paused.status).toBe('incomplete');
      const path = join(side === 'donor' ? f.root : f.workRoot, 'node_modules/alpha.txt');
      const stat = statSync(path);
      writeFileSync(path, 'PAYLOAD-V1');
      utimesSync(path, stat.atime, stat.mtime);
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow(/dependency bytes differ/);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['source', 'commit', 'inputs', 'extra', 'missing', 'escaping-link', 'linked-root',
    'donor-hardlink', 'new-alias'] as const)('fails closed on retained-copy %s drift', async defect => {
    const f = retainedFixture();
    try {
      expect((await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1))).status)
        .toBe('incomplete');
      const modules = join(f.workRoot, 'node_modules');
      if (defect === 'source') writeFileSync(join(f.workRoot, 'libs/runtime/source.cjs'), 'changed source\n');
      if (defect === 'commit') gitFixture(f.workRoot, ['update-ref', 'refs/heads/staging', f.main]);
      if (defect === 'inputs') writeFileSync(join(f.root, 'package-lock.json'), '{"lockfileVersion":3}');
      if (defect === 'extra') writeFileSync(join(modules, 'unexpected.txt'), 'extra');
      if (defect === 'missing') rmSync(join(modules, 'gamma.txt'));
      if (defect === 'escaping-link') {
        rmSync(join(modules, '.bin/runtime-bin'));
        symlinkSync(f.parent, join(modules, '.bin/runtime-bin'));
      }
      if (defect === 'linked-root') {
        rmSync(modules, { recursive: true });
        symlinkSync(join(f.root, 'node_modules'), modules);
      }
      if (defect === 'donor-hardlink' || defect === 'new-alias') {
        rmSync(join(modules, 'beta.txt'));
        linkSync(join(defect === 'donor-hardlink' ? f.root : f.workRoot, 'node_modules/alpha.txt'),
          join(modules, 'beta.txt'));
      }
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow(/retained|recorded artifact/);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('rejects a corrupted completed journal batch without publishing provenance', async () => {
    const f = retainedFixture();
    try {
      await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1));
      const batch = readdirSync(f.checkpointDir).find(name => /^batch-.*\.json$/.test(name))!;
      const path = join(f.checkpointDir, batch);
      const data = JSON.parse(readFileSync(path, 'utf8'));
      data.data.files = 999;
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, f.options()))
        .rejects.toThrow(/journal integrity/);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('preserves internal hardlinks while keeping the copy independent', async () => {
    const f = retainedFixture();
    try {
      linkSync(join(f.root, 'node_modules/alpha.txt'), join(f.root, 'node_modules/twin.txt'));
      linkSync(join(f.workRoot, 'node_modules/alpha.txt'), join(f.workRoot, 'node_modules/twin.txt'));
      const done = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: (copied: { workspacePaths: Set<string> }) =>
          mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths),
      });
      expect(done.status).toBe('complete');
      expect(statSync(join(f.workRoot, 'node_modules/alpha.txt')).ino)
        .toBe(statSync(join(f.workRoot, 'node_modules/twin.txt')).ino);
      expect(statSync(join(f.workRoot, 'node_modules/alpha.txt')).ino)
        .not.toBe(statSync(join(f.root, 'node_modules/alpha.txt')).ino);
    } finally { f.cleanup(); }
  }, 60_000);

  it('does not publish dependency provenance after a workspace build failure', async () => {
    const f = retainedFixture();
    try {
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: () => { throw new Error('fixture workspace failure'); },
      })).rejects.toThrow(/fixture workspace failure/);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it.each(['inside', 'symlink', 'public'] as const)('rejects an unsafe %s checkpoint directory', async defect => {
    const f = retainedFixture();
    try {
      let checkpointDir = f.checkpointDir;
      if (defect === 'inside') checkpointDir = join(f.workRoot, 'verification');
      if (defect === 'public') mkdirSync(checkpointDir, { mode: 0o755 });
      if (defect === 'symlink') {
        const actual = join(f.parent, 'private-journal');
        mkdirSync(actual, { mode: 0o700 });
        symlinkSync(actual, checkpointDir);
      }
      await expect(mod.materializeIndependentDependencies(f.root, f.workRoot, {
        resumeVerification: { ...f.options().resumeVerification, checkpointDir },
      })).rejects.toThrow(/checkpoint|outside both/);
      expectUnpreparedRetainedMarker(f);
    } finally { f.cleanup(); }
  }, 60_000);

  it('does not reuse metadata in the maintained racy window', async () => {
    const f = retainedFixture();
    try {
      await mod.materializeIndependentDependencies(f.root, f.workRoot, f.options(1));
      process.env.DEPENDENCY_GENERATION_RACY_WINDOW_SEC = '3600';
      const done = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: (copied: { workspacePaths: Set<string> }) => mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths),
      });
      expect(done.status).toBe('complete');
      expect(done.verification.reusedBatches).toBe(0);
      expect(done.verification.hashedFiles).toBe(3);
    } finally { f.cleanup(); }
  }, 60_000);

  it('resumes across process death and ignores an unpublished torn temporary journal file', async () => {
    const f = retainedFixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const program = [
        'import {materializeIndependentDependencies} from ' + JSON.stringify(pathToFileURL(scriptPath).href) + ';',
        'const result = await materializeIndependentDependencies(' + JSON.stringify(f.root) + ', ' +
          JSON.stringify(f.workRoot) + ', ' + JSON.stringify(f.options(1)) + ');',
        'console.log("RESUME_PAUSED " + JSON.stringify(result));',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      child = spawn(process.execPath, ['--input-type=module', '-e', program], {
        env: currentRunnerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      });
      const processChild = child;
      let output = '';
      await new Promise<void>((done, reject) => {
        processChild.on('error', reject);
        processChild.stdout!.on('data', chunk => {
          output += chunk;
          if (output.includes('RESUME_PAUSED ')) processChild.kill('SIGKILL');
        });
        processChild.stderr!.on('data', chunk => { output += chunk; });
        processChild.on('close', (_code, signal) =>
          signal === 'SIGKILL' ? done() : reject(new Error(output)));
      });
      writeFileSync(join(f.checkpointDir, 'batch-unpublished.tmp'), '{"data":', { mode: 0o600 });
      expectUnpreparedRetainedMarker(f);
      const done = await mod.materializeIndependentDependencies(f.root, f.workRoot, {
        ...f.options(), prepareWorkspace: (copied: { workspacePaths: Set<string> }) => mod.prepareWorkspaceExports(f.workRoot, copied.workspacePaths),
      });
      expect(done.status).toBe('complete');
      expect(done.verification.reusedBatches).toBeGreaterThan(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.cleanup();
    }
  }, 60_000);

  it('refuses insufficient temporary headroom before cloning or running the committed command', () => {
    const f = fixture('node build.cjs');
    try {
      const result = spawnSync(process.execPath, [scriptPath, 'lint:probe'], {
        cwd: f.root, encoding: 'utf8', timeout: 30_000,
        env: currentRunnerEnvironment({ PAPERCUSP_DISK_ALARM_CRITICAL_GB: '1000000000000000' }),
      });
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain('no temporary directory has critical disk headroom');
      expect(result.stdout).not.toContain('extracted ');
      expect(result.stdout).not.toContain('CLONE_PREREQUISITES_OK');
      expect(result.stderr).not.toContain('No space left on device');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('relocates an unsafe TMPDIR before materialising a committed command', () => {
    const f = fixture('node build.cjs');
    try {
      const childEnv = commandEnvironment({ TMPDIR: f.root });
      const safeFallback = dirname(childEnv.PAPERCUSP_FS_MUTEX_LOCK_DIR!);
      // Exercise the real relocation policy without scanning shared host roots.
      const preload = 'data:text/javascript,' + encodeURIComponent(
        `import { PAPERCUSP_TMPDIR_CANDIDATES } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'libs/test-config/src/tmpdir-guard.ts')).href)};` +
        `PAPERCUSP_TMPDIR_CANDIDATES.splice(0, PAPERCUSP_TMPDIR_CANDIDATES.length, ${JSON.stringify(safeFallback)});`,
      );
      const result = spawnSync(process.execPath, ['--import', preload, scriptPath, 'lint:probe'], {
        cwd: f.root, encoding: 'utf8', timeout: 30_000,
        env: childEnv,
      });
      const diagnostic = JSON.stringify({ error: result.error?.message, status: result.status,
        signal: result.signal }) + '\n' + result.stderr?.slice(-1000) + '\n' + result.stdout?.slice(-1000);
      expect(result.status, diagnostic).toBe(0);
      expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
      const materialized = result.stdout.match(/materialised committed tree in [^\n]* -> (.+)/)?.[1];
      expect(materialized).toBeDefined();
      expect(materialized!.startsWith(safeFallback + sep)).toBe(true);
      expect(materialized!.startsWith(f.root + sep)).toBe(false);
      expect(gitFixture(f.root, ['status', '--porcelain'])).not.toContain('papercusp-lint-as-committed-');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('honors a dependent artifact registered during the running command (removed=%s)', (removed) => {
    const f = fixture('node build.cjs');
    let extracted: string | undefined;
    try {
      const artifact = join(f.root, 'dependent-proof.log');
      snapshot(f.root, { 'probe.cjs': `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
(async () => {
  const { retainCommittedWorkRoot } = await import(${JSON.stringify(pathToFileURL(scriptPath).href)});
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(${JSON.stringify(artifact)}, 'dependent proof');
  await retainCommittedWorkRoot(process.cwd(), sha, ${JSON.stringify(artifact)});
  ${removed ? `fs.rmSync(${JSON.stringify(artifact)});` : ''}
  console.log('DEPENDENT_SOURCE=' + process.cwd());
})().catch(error => { console.error(error); process.exitCode = 1; });
` }, f.head);
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      extracted = result.stdout.match(/DEPENDENT_SOURCE=(\S+)/)?.[1];
      expect(extracted).toBeDefined();
      expect([...commandRuntimeRoots].some(root => extracted!.startsWith(root + sep))).toBe(true);
      expect(existsSync(extracted!)).toBe(!removed);
      if (!removed) {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extracted, encoding: 'utf8' }).trim();
        expect(mod.verifyCommittedWorkRoot(extracted, sha, ['probe.cjs']).sha).toBe(sha);
      }
    } finally {
      if (extracted) rmSync(extracted, { recursive: true, force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 40_000);

  it('builds pinned workspace bins before final dependency link validation despite dirty shared output', () => {
    const f = fixture('node build.cjs');
    try {
      const manifestPath = join(f.root, 'libs/runtime/package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.bin = { 'fixture-runtime': './dist/cli.cjs' };
      snapshot(f.root, {
        'libs/runtime/package.json': JSON.stringify(manifest),
        'libs/runtime/build.cjs': readFileSync(join(f.root, 'libs/runtime/build.cjs'), 'utf8') +
          "fs.writeFileSync('dist/cli.cjs', 'console.log(' + JSON.stringify(require('./source.cjs')) + ');\\n');\n",
        'probe.cjs': readFileSync(join(f.root, 'probe.cjs'), 'utf8') +
          "assert.equal(execFileSync(process.execPath, ['node_modules/.bin/fixture-runtime'], { encoding: 'utf8' }).trim(), 'pinned-source');\nconsole.log('PINNED_WORKSPACE_BIN_OK');\n",
      }, f.head);
      mkdirSync(join(f.root, 'node_modules/.bin'));
      symlinkSync('../@fixture/runtime/dist/cli.cjs', join(f.root, 'node_modules/.bin/fixture-runtime'));
      writeFileSync(join(f.root, 'libs/runtime/dist/cli.cjs'), 'console.log("shared-stale-bin");\n');
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('PINNED_WORKSPACE_BIN_OK');
      expect(result.stdout).toContain('building pinned runtime exports: @fixture/runtime');
      expect(readFileSync(join(f.root, 'libs/runtime/dist/cli.cjs'), 'utf8')).toContain('shared-stale-bin');
      expect(readFileSync(join(f.root, 'libs/runtime/source.cjs'), 'utf8')).toContain('shared-dirty-source');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it('pins main separately from HEAD and builds require exports from committed source despite dirty shared source/dist', () => {
    const f = fixture('node build.cjs');
    try {
      expect(f.main).not.toBe(f.head);
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`main snapshot: ${f.main}`);
      expect(result.stdout).toContain('building pinned runtime exports: @fixture/runtime');
      expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
      expect(readFileSync(join(f.root, 'libs/runtime/source.cjs'), 'utf8')).toContain('shared-dirty-source');
      expect(readFileSync(join(f.root, 'libs/runtime/dist/index.cjs'), 'utf8')).toContain('shared-stale-dist');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it('reports the child signal when the real committed runner is interrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-signal-detail-'));
    const fakeBin = join(root, 'bin');
    gitFixture(root, ['init', '--quiet', '--initial-branch=staging']);
    try {
      snapshot(root, {
        '.gitignore': 'node_modules/',
        'package.json': JSON.stringify({ private: true, scripts: { 'lint:probe': 'node probe.cjs' } }),
        'probe.cjs': 'console.log("the npm shim should interrupt before this runs");',
      });
      mkdirSync(fakeBin);
      const npmShim = join(fakeBin, 'npm');
      writeFileSync(npmShim, ['#!/bin/sh', 'kill -TERM $$', ''].join(String.fromCharCode(10)));
      chmodSync(npmShim, 0o755);

      const childEnv = commandEnvironment({
        PATH: `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
        PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, 'mutex'),
        PAPERCUSP_RELEASE_RETENTION_ROOT: join(root, 'leases'),
      });

      const result = spawnSync(process.execPath, [scriptPath, 'lint:probe'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: childEnv,
      });

      expect(result.signal, result.stdout + result.stderr).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain('terminated by signal SIGTERM (no exit status)');
      expect(result.stdout + result.stderr).toContain('1 of 1 check(s) did NOT pass as committed');
      expect(result.stdout + result.stderr).not.toContain('All 1 check(s) pass AS COMMITTED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('runs the pinned workspace script and refuses an absent workspace-relative operand', () => {
    const f = fixture('node build.cjs');
    try {
      snapshot(f.root, {
        'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'], scripts: {} }),
        'apps/sidecar/package.json': JSON.stringify({ name: '@fixture/sidecar', private: true,
          scripts: { 'lint:probe': 'node probe.cjs' } }),
        'apps/sidecar/probe.cjs': 'console.log("PINNED_WORKSPACE_OK");\n',
      }, gitFixture(f.root, ['rev-parse', 'HEAD']));
      writeFileSync(join(f.root, 'apps/sidecar/probe.cjs'), 'throw new Error("dirty workspace must not run");\n');
      const invoke = (operand: string) => spawnSync(process.execPath,
        [scriptPath, 'lint:probe', '--workspace=apps/sidecar', '--', operand],
        { cwd: f.root, env: commandEnvironment(), encoding: 'utf8', timeout: 30_000 });
      const pass = invoke('probe.cjs');
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      expect(pass.stdout).toContain('PINNED_WORKSPACE_OK');
      const missing = invoke('absent.cjs');
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toContain('apps/sidecar/absent.cjs');
      expect(missing.stdout).not.toContain('PINNED_WORKSPACE_OK');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('does not fabricate main when the source repository has no main branch', () => {
    const f = fixture('node build.cjs', false);
    try {
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).not.toContain('main snapshot:');
      expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it('preserves deep package-local dependency versions in the committed clone', () => {
    const f = fixture('node build.cjs');
    const packagePath = 'libs/generic/deep/local/package';
    try {
      snapshot(f.root, {
        'package.json': JSON.stringify({ private: true, scripts: { 'lint:probe': 'node probe.cjs' },
          dependencies: { '@fixture/runtime': 'file:libs/runtime', '@fixture/deep': `file:${packagePath}`, 'graph-leaf': '2.0.0' } }),
        [`${packagePath}/package.json`]: JSON.stringify({ name: '@fixture/deep', version: '1.0.0',
          main: 'index.cjs', dependencies: { 'graph-leaf': '1.0.0' } }),
        [`${packagePath}/index.cjs`]: 'module.exports = require("graph-leaf/package.json").version;\n',
        'probe.cjs': `const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
assert.equal(require('@fixture/deep'), '1.0.0');
assert.equal(require('graph-leaf/package.json').version, '2.0.0');
const result = spawnSync('npm', ['ls', 'graph-leaf', '--omit=dev', '--all', '--json'], { encoding: 'utf8', timeout: 15000 });
assert.ifError(result.error);
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.deepEqual(JSON.parse(result.stdout).problems ?? [], []);
console.log('DEEP_LOCAL_GRAPH_OK');\n`,
      }, f.head);
      symlinkSync(`../../${packagePath}`, join(f.root, 'node_modules/@fixture/deep'));
      for (const [dir, version] of [
        ['node_modules/graph-leaf', '2.0.0'],
        [`${packagePath}/node_modules/graph-leaf`, '1.0.0'],
      ]) {
        mkdirSync(join(f.root, dir), { recursive: true });
        writeFileSync(join(f.root, dir, 'package.json'), JSON.stringify({ name: 'graph-leaf', version }));
      }
      expect(createRequire(join(f.root, 'package.json'))('@fixture/deep')).toBe('1.0.0');
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('DEEP_LOCAL_GRAPH_OK');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each(['string', 'map'])('builds a bin-only package and its companion native assets from the pinned tree (%s)', (shape) => {
    const f = fixture('node build.cjs');
    try {
      snapshot(f.root, {
        'libs/runtime/package.json': JSON.stringify({ name: '@fixture/runtime',
          bin: shape === 'string' ? './dist/cli.cjs' : { fixture: './dist/cli.cjs' },
          scripts: { build: 'node build-native.cjs' } }),
        'libs/runtime/build-native.cjs': `const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
for (const name of ['cli.cjs', 'native-client.cjs', 'native-extension.mjs']) fs.writeFileSync('dist/' + name, 'pinned-native');
`,
        'probe.cjs': `const assert = require('node:assert/strict');
const fs = require('node:fs');
for (const name of ['cli.cjs', 'native-client.cjs', 'native-extension.mjs']) assert.equal(fs.readFileSync('libs/runtime/dist/' + name, 'utf8'), 'pinned-native');
console.log('PINNED_NATIVE_OK');
`,
      }, f.head);
      writeFileSync(join(f.root, 'libs/runtime/build-native.cjs'), 'throw new Error("shared dirty builder");\n');
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('PINNED_NATIVE_OK');
      expect(existsSync(join(f.root, 'libs/runtime/dist/native-client.cjs'))).toBe(false);
      expect(readFileSync(join(f.root, 'libs/runtime/build-native.cjs'), 'utf8')).toContain('shared dirty builder');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each(['valid-cache', 'corrupt-cache', 'corrupt-installed'])('reuses only bytes accepted by the committed runtime model pin (%s)', (variant) => {
    const f = fixture('node build.cjs');
    const valid = variant === 'valid-cache';
    const model = 'independent pinned model fixture\n';
    const digest = createHash('sha256').update(model).digest('hex');
    try {
      const manifest = JSON.parse(readFileSync(join(f.root, 'libs/runtime/package.json'), 'utf8'));
      manifest.scripts.postinstall = 'bash scripts/setup-porcupine-runtime.sh';
      // Use known fixture bytes with the real setup algorithm, and a closed
      // loopback endpoint so a corrupt seed cannot be rescued by the network.
      const setup = readFileSync(resolve(repoRoot, 'apps/operator/scripts/setup-porcupine-runtime.sh'), 'utf8')
        .replace(/PORCUPINE_SHA256="[a-f0-9]{64}"/, `PORCUPINE_SHA256="${digest}"`)
        .replace(/^URL=.*$/m, 'URL="http://127.0.0.1:9/unavailable-model"');
      snapshot(f.root, {
        '.gitignore': 'node_modules/\nlibs/runtime/dist/\nlibs/runtime/public/\n',
        'libs/runtime/package.json': JSON.stringify(manifest),
        'libs/runtime/scripts/setup-porcupine-runtime.sh': setup,
        ...(variant === 'corrupt-installed' ? {
          'libs/runtime/build.cjs': readFileSync(join(f.root, 'libs/runtime/build.cjs'), 'utf8') +
            "fs.mkdirSync('public/porcupine', { recursive: true }); fs.writeFileSync('public/porcupine/porcupine_params.pv', 'corrupt installed model');\n",
        } : {}),
        'probe.cjs': readFileSync(join(f.root, 'probe.cjs'), 'utf8') + `\nassert.equal(readFileSync('libs/runtime/public/porcupine/porcupine_params.pv', 'utf8'), ${JSON.stringify(model)});\nconsole.log('PINNED_MODEL_OK');\n`,
      }, f.head);
      mkdirSync(join(f.root, 'libs/runtime/public/porcupine'), { recursive: true });
      const source = join(f.root, 'libs/runtime/public/porcupine/porcupine_params.pv');
      if (variant !== 'corrupt-installed') writeFileSync(source, valid ? model : 'corrupt model');
      const result = run(f.root, true);
      expect(result.status, result.stdout + result.stderr).toBe(valid ? 0 : 2);
      if (valid) {
        expect(result.stdout).toContain('reused cached model (sha256 verified)');
        expect(result.stdout).toContain('PINNED_MODEL_OK');
      } else {
        expect(result.stdout).not.toContain('PINNED_MODEL_OK');
        expect(result.stderr).toContain(variant === 'corrupt-installed' ? 'committed postinstall failed' : 'committed runtime seed failed');
      }
      if (variant === 'corrupt-installed') expect(existsSync(source)).toBe(false);
      else expect(readFileSync(source, 'utf8')).toBe(valid ? model : 'corrupt model');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each([0, 7])('prepares declared runtime assets before arbitrary commands and refuses a failing lifecycle (exit %s)', (exitCode) => {
    const f = fixture('node build.cjs');
    try {
      const manifest = JSON.parse(readFileSync(join(f.root, 'libs/runtime/package.json'), 'utf8'));
      manifest.scripts.postinstall = 'node setup-vditor-runtime.cjs';
      snapshot(f.root, {
        '.gitignore': 'node_modules/\nlibs/runtime/dist/\nlibs/runtime/public/\n',
        'libs/runtime/package.json': JSON.stringify(manifest),
        'libs/runtime/setup-vditor-runtime.cjs': `const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/mirror.js', require('./source.cjs'));
process.exitCode = ${exitCode};
`,
        'probe.cjs': readFileSync(join(f.root, 'probe.cjs'), 'utf8') + `
assert.equal(readFileSync('libs/runtime/public/mirror.js', 'utf8'), 'pinned-source');
console.log('PINNED_ASSETS_OK');
`,
      }, f.head);
      mkdirSync(join(f.root, 'libs/runtime/public'), { recursive: true });
      writeFileSync(join(f.root, 'libs/runtime/public/mirror.js'), 'shared stale assets');
      writeFileSync(join(f.root, 'libs/runtime/setup-vditor-runtime.cjs'), 'throw new Error("shared dirty setup");\n');
      const result = run(f.root, true);
      expect(result.status, result.stdout + result.stderr).toBe(exitCode === 0 ? 0 : 2);
      expect(result.stdout).toContain('preparing pinned runtime assets: @fixture/runtime');
      if (exitCode === 0) expect(result.stdout).toContain('PINNED_ASSETS_OK');
      else {
        expect(result.stderr).toContain('committed postinstall failed');
        expect(result.stdout).not.toContain('─── lint:probe');
        expect(result.stdout).not.toContain('CLONE_PREREQUISITES_OK');
      }
      expect(readFileSync(join(f.root, 'libs/runtime/public/mirror.js'), 'utf8')).toBe('shared stale assets');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each([
    { name: 'absent build', build: undefined, reason: 'no committed build script' },
    { name: 'failed build', build: 'node -e "process.exitCode = 7"', reason: 'committed build failed' },
    { name: 'successful build with no output', build: 'node -e "console.log(\'NO_OUTPUT\')"', reason: 'did not emit runtime export' },
    { name: 'build mutating pinned source', build: 'node build.cjs && node -e "require(\'node:fs\').writeFileSync(\'source.cjs\', \'changed\')"', reason: 'committed build changed source' },
  ])('refuses $name before executing the requested detector', ({ build, reason }) => {
    const f = fixture(build);
    try {
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain(reason);
      expect(result.stdout).not.toContain('─── lint:probe');
      expect(result.stdout).not.toContain('CLONE_PREREQUISITES_OK');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);
});

// WI-10005705: extracted ~1.4 GB trees outlived their runs (--keep, process.exit inside the
// try, signal kills) and refilled the root disk. These pin the lifecycle that removes them.
describe('extracted-tree lifecycle (WI-10005705)', () => {
  type Verdict = { remove: boolean; reason: string };
  type Marker = { pid?: number; keep?: boolean; createdAtMs?: number } | null;
  const { classifyWorkRoot, sweepStaleWorkRoots, sweepStaleWorkRootsWithRetentionPins, WORK_ROOT_PREFIX, OWNER_MARKER, KEEP_TTL_MS, MAX_AGE_MS } = mod as {
    classifyWorkRoot: (a: { inUse: boolean; marker: Marker; ownerAlive: boolean; ageMs: number }) => Verdict;
    sweepStaleWorkRoots: (o: {
      root: string;
      nowMs: number;
      cwds: string[] | null;
      isAlive: (pid: number) => boolean;
      maxIdleKept?: number;
    }) => Promise<{ removed: { name: string; reason: string }[]; kept: { name: string; reason: string }[] }>;
    sweepStaleWorkRootsWithRetentionPins: (
      o: { root: string; nowMs: number; cwds: string[]; isAlive: (pid: number) => boolean },
      pins: { dir: string; nowMs: number; timeoutMs?: number },
    ) => Promise<{ removed: { name: string; reason: string }[]; kept: { name: string; reason: string }[] }>;
    WORK_ROOT_PREFIX: string;
    OWNER_MARKER: string;
    KEEP_TTL_MS: number;
    MAX_AGE_MS: number;
  };
  const H = 3600_000;

  it('keeps an active acceptance pin through self-sweep and exit cleanup until explicit release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-active-retention-pin-'));
    try {
      const source = join(root, `${WORK_ROOT_PREFIX}acceptance`);
      const leases = join(root, 'leases');
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'locks'));
      vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', leases);
      const nowMs = Date.now();
      mkdirSync(join(source, '.git'), { recursive: true });
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({
        pid: 101, keep: true, sha: 'a'.repeat(40), createdAtMs: nowMs - MAX_AGE_MS - H,
      }));
      const pin = createRetentionPin({
        path: source,
        owner: 'test-owner',
        reason: 'acceptance snapshot is still referenced',
        expiresAt: new Date(nowMs + H).toISOString(),
      }, { dir: leases, nowMs });

      const swept = await sweepStaleWorkRootsWithRetentionPins(
        { root, nowMs, cwds: [], isAlive: () => false },
        { dir: leases, nowMs },
      );
      expect(swept.removed).toEqual([]);
      expect(swept.kept).toContainEqual({ name: `${WORK_ROOT_PREFIX}acceptance`, reason: 'pinned' });
      expect(existsSync(source)).toBe(true);
      expect(await mod.cleanupCommittedWorkRoot(source)).toBe(false);
      expect(existsSync(source)).toBe(true);

      expect(removeRetentionPin(pin.id, 'test-owner', { dir: leases })).toBe(true);
      expect(await mod.cleanupCommittedWorkRoot(source)).toBe(true);
      expect(existsSync(source)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defers optional sweep and exit cleanup while a pin writer stays active', async () => {
    const { withFsMutex } = await import('../../../scripts/lib/fs-mutex.mjs');
    const root = mkdtempSync(join(tmpdir(), 'lac-busy-retention-pin-'));
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'locks'));
      vi.stubEnv('PAPERCUSP_DISABLE_FS_MUTEX', '');
      vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(root, 'leases'));
      const source = join(root, `${WORK_ROOT_PREFIX}deferred`);
      const nowMs = Date.now();
      mkdirSync(join(source, '.git'), { recursive: true });
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({
        pid: 101, keep: false, createdAtMs: nowMs - MAX_AGE_MS - H,
      }));
      await withFsMutex('papercusp-disk-retention', async () => {
        expect(await mod.cleanupCommittedWorkRoot(source, false, { timeoutMs: 50 })).toBe(false);
        const swept = await sweepStaleWorkRootsWithRetentionPins(
          { root, nowMs, cwds: [], isAlive: () => false },
          { dir: join(root, 'leases'), nowMs, timeoutMs: 50 },
        );
        expect(swept).toEqual({ removed: [], kept: [], deferred: true });
        expect(existsSync(source)).toBe(true);
      });
      expect(warnings).toHaveBeenCalledTimes(2);
      for (const [, diagnostic] of warnings.mock.calls) {
        expect(diagnostic).toEqual(expect.objectContaining({
          code: 'ETIMEDOUT',
          message: expect.stringContaining('papercusp-disk-retention'),
          timeoutMs: 50,
          waitedMs: expect.any(Number),
        }));
        expect(diagnostic.waitedMs).toBeGreaterThanOrEqual(50);
        expect(diagnostic.message).toContain('holder (last observed):');
      }
      expect(await mod.cleanupCommittedWorkRoot(source)).toBe(true);
      expect(existsSync(source)).toBe(false);
    } finally {
      warnings.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains dependent source past the age and idle cap, then releases it when the artifact disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-dependent-'));
    try {
      const source = join(root, `${WORK_ROOT_PREFIX}source`);
      const artifact = join(root, 'portal-release');
      mkdirSync(join(source, '.git'), { recursive: true });
      mkdirSync(artifact);
      const sha = 'a'.repeat(40);
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({
        pid: 101, keep: true, sha, createdAtMs: 0, retainedFor: [{ path: artifact, sha }],
      }));
      const options = { root, nowMs: MAX_AGE_MS + H, cwds: [], isAlive: () => false, maxIdleKept: 0 };
      expect((await mod.sweepStaleWorkRoots(options)).kept).toContainEqual({ name: `${WORK_ROOT_PREFIX}source`, reason: 'dependent-artifact' });
      expect(existsSync(source)).toBe(true);
      rmSync(artifact, { recursive: true });
      expect((await mod.sweepStaleWorkRoots(options)).removed).toContainEqual({ name: `${WORK_ROOT_PREFIX}source`, reason: 'max-age' });
      expect(existsSync(source)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes deletion with a retention hold being registered (EI-26972693430783811)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-retention-delete-race-'));
    const source = join(root, `${WORK_ROOT_PREFIX}source`);
    const artifact = join(root, 'candidate');
    const sha = 'a'.repeat(40);
    const marker = { pid: 101, keep: true, sha, createdAtMs: 0 };
    const { withFsMutex } = await import('../../../scripts/lib/fs-mutex.mjs');
    let sweeping: Promise<{ removed: unknown[]; kept: unknown[] }> | undefined;
    let deletedDuringRegistration = false;
    try {
      mkdirSync(join(source, '.git'), { recursive: true });
      mkdirSync(artifact);
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify(marker));
      const mutex = 'committed-source-retention-' + createHash('sha256').update(source).digest('hex').slice(0, 24);
      await withFsMutex(mutex, async () => {
        sweeping = Promise.resolve(mod.sweepStaleWorkRoots({
          root, nowMs: MAX_AGE_MS + H, cwds: [], isAlive: () => false,
        }));
        // Let cleanup attempt deletion while the actual marker writer's lock is held.
        await new Promise(resolve => setTimeout(resolve, 100));
        deletedDuringRegistration = !existsSync(source);
        if (!deletedDuringRegistration) {
          writeFileSync(join(source, OWNER_MARKER), JSON.stringify({
            ...marker, retainedFor: [{ path: artifact, sha }],
          }));
        }
      });
      const result = await sweeping!;
      expect(deletedDuringRegistration).toBe(false);
      expect(result.removed).toEqual([]);
      expect(result.kept).toContainEqual({ name: `${WORK_ROOT_PREFIX}source`, reason: 'dependent-artifact' });
      expect(existsSync(source)).toBe(true);
    } finally {
      await sweeping;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exit cleanup waits for a competing retention writer before deciding to delete', async () => {
    const { withFsMutex } = await import('../../../scripts/lib/fs-mutex.mjs');
    const root = mkdtempSync(join(tmpdir(), 'lac-exit-retention-'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'locks'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(root, 'leases'));
    const source = join(root, 'source');
    const artifact = join(root, 'artifact');
    mkdirSync(join(source, '.git'), { recursive: true });
    mkdirSync(artifact);
    const sha = 'a'.repeat(40);
    const marker = join(source, OWNER_MARKER);
    writeFileSync(marker, JSON.stringify({ sha, keep: false }));
    let releaseWriter!: () => void;
    let writerEntered!: () => void;
    const release = new Promise<void>(done => { releaseWriter = done; });
    const entered = new Promise<void>(done => { writerEntered = done; });
    const mutexName = 'committed-source-retention-' + createHash('sha256').update(realpathSync(source)).digest('hex').slice(0, 24);
    const writer = withFsMutex(mutexName, async () => {
      writerEntered();
      await release;
      writeFileSync(marker, JSON.stringify({ sha, keep: true, retainedFor: [{ path: artifact, sha }] }));
    });
    let cleanup: Promise<boolean> | undefined;
    try {
      await entered;
      cleanup = Promise.resolve().then(() => mod.cleanupCommittedWorkRoot(source));
      // Give cleanup a turn while the real cross-process mutex is still held.
      await new Promise(done => setTimeout(done, 50));
      expect(existsSync(source)).toBe(true);
      releaseWriter();
      await writer;
      expect(await cleanup).toBe(false);
      expect(existsSync(source)).toBe(true);
      rmSync(artifact, { recursive: true });
      expect(await mod.cleanupCommittedWorkRoot(source)).toBe(true);
      expect(existsSync(source)).toBe(false);
    } finally {
      releaseWriter();
      await Promise.allSettled([writer, ...(cleanup ? [cleanup] : [])]);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('exit cleanup preserves an explicitly kept tree without an artifact hold', async () => {
    const source = mkdtempSync(join(tmpdir(), 'lac-exit-keep-'));
    try {
      expect(await mod.cleanupCommittedWorkRoot(source, true)).toBe(false);
      expect(existsSync(source)).toBe(true);
    } finally { rmSync(source, { recursive: true, force: true }); }
  });

  it('preflights commit identity and imports before registering a dependent artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-preflight-'));
    try {
      const source = join(root, 'source');
      const artifact = join(root, 'portal-release');
      mkdirSync(source);
      mkdirSync(artifact);
      execFileSync('git', ['init', '--quiet', source]);
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: source });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({ pid: 101, keep: true, sha, createdAtMs: 0 }));
      mkdirSync(join(source, 'packages', 'core'), { recursive: true });
      symlinkSync(artifact, join(source, 'escape'), 'dir');
      expect(() => mod.verifyCommittedWorkRoot(join(root, 'missing'), sha)).toThrow('source root is missing');
      expect(() => mod.verifyCommittedWorkRoot(source, 'b'.repeat(40))).toThrow('commit does not match');
      expect(() => mod.verifyCommittedWorkRoot(source, sha, ['missing'])).toThrow('dependency is missing');
      expect(() => mod.verifyCommittedWorkRoot(source, sha, ['escape'])).toThrow('escapes');
      expect(() => mod.verifyCommittedWorkRoot(source, sha, ['../portal-release'])).toThrow('inside');
      expect(mod.verifyCommittedWorkRoot(source, sha, ['packages/core']).sha).toBe(sha);
      expect(() => mod.retainCommittedWorkRoot(source, sha, source)).toThrow('outside');
      expect(() => mod.retainCommittedWorkRoot(source, sha, join(root, 'missing'))).toThrow();
      await mod.retainCommittedWorkRoot(source, sha, artifact);
      await mod.retainCommittedWorkRoot(source, sha, artifact);
      expect(JSON.parse(readFileSync(join(source, OWNER_MARKER), 'utf8')).retainedFor).toEqual([{ path: realpathSync(artifact), sha }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves concurrent artifact holds and never exposes partially written retention JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-concurrent-retention-'));
    let monitor: ReturnType<typeof setInterval> | undefined;
    try {
      const source = join(root, 'source'); mkdirSync(source);
      execFileSync('git', ['init', '--quiet', source]);
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: source });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      const marker = join(source, OWNER_MARKER);
      writeFileSync(marker, JSON.stringify({ pid: process.pid, keep: true, sha, createdAtMs: Date.now() }));
      const artifacts = Array.from({ length: 8 }, (_, i) => join(root, 'artifact-' + i));
      for (const artifact of artifacts) mkdirSync(artifact);
      const readErrors: string[] = [];
      monitor = setInterval(() => { try { JSON.parse(readFileSync(marker, 'utf8')); } catch (error) { readErrors.push(String(error)); } }, 1);
      const settled = await Promise.allSettled(artifacts.map(artifact => new Promise<void>((resolveChild, reject) => {
        const code = `const {retainCommittedWorkRoot}=await import(${JSON.stringify(pathToFileURL(scriptPath).href)}); await retainCommittedWorkRoot(${JSON.stringify(source)},${JSON.stringify(sha)},${JSON.stringify(artifact)});`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
          cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolveChild() : reject(new Error(stderr)));
      })));
      clearInterval(monitor); monitor = undefined;
      expect(settled.filter(row => row.status === 'rejected')).toEqual([]);
      expect(readErrors).toEqual([]);
      const retained = JSON.parse(readFileSync(marker, 'utf8')).retainedFor;
      expect(retained.map((entry: { path: string }) => entry.path).sort()).toEqual(artifacts.map(p => realpathSync(p)).sort());
      expect(retained.every((entry: { sha: string }) => entry.sha === sha)).toBe(true);
    } finally {
      if (monitor) clearInterval(monitor);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('materializes without replaying a command and explicitly retains its dependent artifact', () => {
    expect(mod.parseArgs(['--materialize-only', '--ref=recorded', '--retain-for=/tmp/release'])).toMatchObject({
      materializeOnly: true, keep: true, ref: 'recorded', retainFor: '/tmp/release', scripts: [],
    });
    const run = spawnSync('node', [scriptPath, '--materialize-only', 'test:file'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('cannot run or forward a command');
  });

  it('requires both exact source holds before resuming a two-source artifact', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'lac-paired-custody-'));
    try {
      const sources = join(parent, 'sources');
      const artifact = join(parent, 'artifacts', 'candidate');
      const unrelated = join(parent, 'artifacts', 'other');
      mkdirSync(artifact, { recursive: true });
      mkdirSync(unrelated);
      const roots = ['portal', 'operator'].map((name) => {
        const root = join(sources, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['init', '--quiet', root]);
        execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', name], { cwd: root });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        writeFileSync(join(root, OWNER_MARKER), JSON.stringify({ pid: 101, keep: true, sha, createdAtMs: 0 }));
        return { root, sha };
      });
      for (const { root, sha } of roots) {
        expect(() => mod.verifyCommittedWorkRoot(root, sha, [], artifact)).toThrow('no retention hold');
        await mod.retainCommittedWorkRoot(root, sha, unrelated);
        expect(() => mod.verifyCommittedWorkRoot(root, sha, [], artifact)).toThrow('no retention hold');
        await mod.retainCommittedWorkRoot(root, sha, artifact);
        expect(mod.verifyCommittedWorkRoot(root, sha, [], artifact)).toEqual({ root: realpathSync(root), sha });
      }
      const swept = await mod.sweepStaleWorkRoots({ root: sources, nowMs: MAX_AGE_MS + H, cwds: [], isAlive: () => false, maxIdleKept: 0 });
      expect(swept.removed).toEqual([]);
      expect(swept.kept).toHaveLength(2);
      rmSync(artifact, { recursive: true });
      for (const { root, sha } of roots) expect(() => mod.verifyCommittedWorkRoot(root, sha, [], artifact)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('repairs dangling workspace imports only after validating every replacement against the exact source', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-remap-'));
    try {
      const source = join(root, 'source');
      const prior = join(root, 'removed-source');
      const modules = join(root, 'portal', 'node_modules');
      mkdirSync(source);
      mkdirSync(join(modules, '@fixture'), { recursive: true });
      execFileSync('git', ['init', '--quiet', source]);
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: source });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({ sha, keep: true }));
      mkdirSync(join(source, 'packages', 'core'), { recursive: true });
      writeFileSync(join(source, 'packages', 'core', 'package.json'), '{}');
      const core = join(modules, '@fixture', 'core');
      const missing = join(modules, '@fixture', 'missing');
      symlinkSync(join(prior, 'packages', 'core'), core, 'dir');
      symlinkSync(join(prior, 'packages', 'missing'), missing, 'dir');
      expect(() => mod.remapRetainedWorkspaceLinks(modules, prior, source, sha)).toThrow('dependency is missing');
      expect(existsSync(core)).toBe(false); // Refusal did not partially remap a valid sibling.
      rmSync(missing);
      expect(mod.remapRetainedWorkspaceLinks(modules, prior, source, sha).remapped).toBe(1);
      expect(realpathSync(core)).toBe(join(source, 'packages', 'core'));
      expect(mod.remapRetainedWorkspaceLinks(modules, prior, source, sha).remapped).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs real mirrored package shells through shared-module indirection without changing the install', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-shell-remap-'));
    try {
      const source = join(root, 'frozen'), prior = join(root, 'live'), shared = join(root, 'install');
      const modules = join(root, 'portal/node_modules');
      for (const [base, value] of [[source, 'frozen'], [prior, 'live']]) {
        const pkg = join(base, 'packages/core');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/core', main: './index.cjs' }));
        writeFileSync(join(pkg, 'index.cjs'), `module.exports = '${value}';`);
      }
      execFileSync('git', ['init', '--quiet', source]);
      // The child below inherits committed-source-loader from `test:file`, so
      // the frozen fixture must contain real committed bytes like a production
      // retained work root.
      execFileSync('git', ['add', '--', 'packages/core/package.json', 'packages/core/index.cjs'], { cwd: source });
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture source'], { cwd: source });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
      writeFileSync(join(source, OWNER_MARKER), JSON.stringify({ sha, keep: true }));
      const installed = join(shared, 'node_modules/@fixture/core');
      execFileSync('git', ['init', '--quiet', prior]);
      writeFileSync(join(prior, '.gitignore'), '.cache/\n');
      mkdirSync(join(prior, 'packages/core/.cache'));
      writeFileSync(join(prior, 'packages/core/.cache/generated'), 'ignored cache');
      mkdirSync(join(prior, 'packages/core/empty-cache'));
      writeFileSync(join(prior, 'packages/core/missing.cjs'), 'committed source missing from frozen root');
      execFileSync('git', ['add', '--', '.gitignore', 'packages/core/package.json', 'packages/core/index.cjs', 'packages/core/missing.cjs'], { cwd: prior });
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture source'], { cwd: prior });
      mkdirSync(installed, { recursive: true });
      for (const child of ['package.json', 'index.cjs']) symlinkSync(join(prior, 'packages/core', child), join(installed, child));
      symlinkSync(join(prior, 'packages/core/.cache'), join(installed, '.cache'));
      symlinkSync(join(prior, 'packages/core/empty-cache'), join(installed, 'empty-cache'));
      linkNodeModulesShadow(join(shared, 'node_modules'), modules, shared, join(root, 'portal'));
      const shell = join(modules, '@fixture/core');
      const req = createRequire(join(root, 'portal/app.js'));
      expect(lstatSync(shell).isDirectory()).toBe(true);
      expect(req('@fixture/core')).toBe('live');
      // Whole-plan prevalidation must catch a missing source child before changing its manifest.
      symlinkSync(join(prior, 'packages/core/missing.cjs'), join(shell, 'missing.cjs'));
      expect(() => mod.remapRetainedWorkspaceLinks(modules, prior, source, sha)).toThrow('dependency is missing');
      expect(realpathSync(join(shell, 'package.json'))).toBe(join(prior, 'packages/core/package.json'));
      rmSync(join(shell, 'missing.cjs'));
      expect(mod.remapRetainedWorkspaceLinks(modules, prior, source, sha).remapped).toBe(2);
      // Recovery runs before a fresh consumer starts, as in the native launcher.
      const consumed = JSON.parse(execFileSync(process.execPath, ['-e',
        "console.log(JSON.stringify({value:require('@fixture/core'),path:require.resolve('@fixture/core')}))"],
      { cwd: join(root, 'portal'), encoding: 'utf8' }));
      expect(consumed.value).toBe('frozen');
      expect(realpathSync(consumed.path)).toBe(join(source, 'packages/core/index.cjs'));
      expect(lstatSync(shell).isDirectory()).toBe(true);
      expect(realpathSync(join(installed, 'index.cjs'))).toBe(join(prior, 'packages/core/index.cjs'));
      expect(realpathSync(join(shell, '.cache'))).toBe(join(prior, 'packages/core/.cache'));
      expect(realpathSync(join(shell, 'empty-cache'))).toBe(join(prior, 'packages/core/empty-cache'));
      expect(mod.remapRetainedWorkspaceLinks(modules, prior, source, sha).remapped).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('classifies each tree by liveness, keep flag and age', () => {
    const c = (inUse: boolean, marker: Marker, ownerAlive: boolean, ageMs: number) => classifyWorkRoot({ inUse, marker, ownerAlive, ageMs });
    expect(c(true, null, false, MAX_AGE_MS * 10)).toEqual({ remove: false, reason: 'in-use' });
    expect(c(false, { pid: 1, keep: false }, false, 60_000)).toEqual({ remove: true, reason: 'owner-dead' });
    expect(c(false, { pid: 1, keep: false }, true, 60_000)).toEqual({ remove: false, reason: 'owner-alive' });
    expect(c(false, { pid: 1, keep: false }, true, MAX_AGE_MS + 1)).toEqual({ remove: false, reason: 'owner-alive' });
    expect(c(false, { pid: 1, keep: true }, false, KEEP_TTL_MS - 1)).toEqual({ remove: false, reason: 'keep-young' });
    expect(c(false, { pid: 1, keep: true }, false, KEEP_TTL_MS + 1)).toEqual({ remove: true, reason: 'keep-expired' });
    expect(c(false, null, false, KEEP_TTL_MS - 1)).toEqual({ remove: false, reason: 'unmarked-young' });
    expect(c(false, null, false, KEEP_TTL_MS + 1)).toEqual({ remove: true, reason: 'unmarked-expired' });
    expect(c(false, null, false, Number.NaN)).toEqual({ remove: false, reason: 'age-unknown' });
  });

  it('sweeps only stale trees under the root, never one a live process is inside', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-sweep-'));
    try {
      const now = Date.now();
      const tree = (name: string, marker: Marker) => {
        const p = join(root, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(join(p, '.git'), { recursive: true });
        if (marker) writeFileSync(join(p, OWNER_MARKER), JSON.stringify(marker));
        return p;
      };
      tree('dead-owner', { pid: 101, keep: false, createdAtMs: now - 60_000 });
      tree('live-owner', { pid: 202, keep: false, createdAtMs: now - 60_000 });
      tree('keep-old', { pid: 101, keep: true, createdAtMs: now - KEEP_TTL_MS - H });
      tree('keep-fresh', { pid: 101, keep: true, createdAtMs: now - H });
      const busy = tree('keep-old-busy', { pid: 101, keep: true, createdAtMs: now - MAX_AGE_MS - H });
      mkdirSync(join(root, 'unrelated-dir'));
      const isAlive = (pid: number) => pid === 202;

      const res = await sweepStaleWorkRoots({ root, nowMs: now, cwds: [join(busy, 'packages', 'x')], isAlive });
      const names = (rows: { name: string }[]) => rows.map((r) => r.name.slice(WORK_ROOT_PREFIX.length)).sort();
      expect(names(res.removed)).toEqual(['dead-owner', 'keep-old']);
      expect(names(res.kept)).toEqual(['keep-fresh', 'keep-old-busy', 'live-owner']);
      expect(existsSync(join(root, `${WORK_ROOT_PREFIX}dead-owner`))).toBe(false);
      expect(existsSync(busy)).toBe(true);
      expect(existsSync(join(root, 'unrelated-dir'))).toBe(true);

      // Without /proc a tree's idleness is unprovable: only a dead non-keep owner goes.
      tree('dead-owner-2', { pid: 101, keep: false, createdAtMs: now - 60_000 });
      const blind = await sweepStaleWorkRoots({ root, nowMs: now + MAX_AGE_MS * 2, cwds: null, isAlive });
      expect(names(blind.removed)).toEqual(['dead-owner-2']);
      expect(existsSync(busy)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('WI-6554700010019046: a /proc census from outside the initial PID namespace is unprovable, never empty', () => {
    const { liveProcessCwds, INITIAL_PID_NAMESPACE } = mod as {
      liveProcessCwds: (io?: { readDir?: (p: string) => string[]; readLink?: (p: string) => string }) => string[] | null;
      INITIAL_PID_NAMESPACE: string;
    };
    expect(INITIAL_PID_NAMESPACE).toBe('pid:[4026531836]');
    const links: Record<string, string> = { '/proc/7/cwd': '/tmp/x/busy-tree', '/proc/9/cwd': '/home' };
    const io = (ns: string | Error) => ({
      readDir: () => ['7', '9', 'self', 'sys'],
      readLink: (p: string) => {
        if (p === '/proc/self/ns/pid') {
          if (ns instanceof Error) throw ns;
          return ns;
        }
        const target = links[p];
        if (!target) throw new Error(`ENOENT ${p}`);
        return target;
      },
    });
    expect(liveProcessCwds(io(INITIAL_PID_NAMESPACE))).toEqual(['/tmp/x/busy-tree', '/home']);
    // A private PID namespace (bwrap --unshare-pid, unshare -p) lists only its own processes.
    expect(liveProcessCwds(io('pid:[4026532999]'))).toBeNull();
    expect(liveProcessCwds(io(new Error('EACCES')))).toBeNull();
  });

  it('WI-6554700010019046: a host owner pid seen from a private PID namespace is unknown, and its tree is kept', async () => {
    const { pidAlive, pidNamespaceView, INITIAL_PID_NAMESPACE } = mod as {
      pidAlive: (pid: number, view?: string) => boolean | null;
      pidNamespaceView: (readLink?: (p: string) => string) => string;
      INITIAL_PID_NAMESPACE: string;
    };
    expect(pidNamespaceView(() => INITIAL_PID_NAMESPACE)).toBe('initial');
    expect(pidNamespaceView(() => 'pid:[4026532999]')).toBe('private');
    expect(pidAlive(process.pid, 'initial')).toBe(true);
    expect(pidAlive(process.pid, 'private')).toBeNull();
    expect(pidAlive(0, 'private')).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'lac-pidns-'));
    try {
      const now = Date.now();
      const tree = join(root, `${WORK_ROOT_PREFIX}running-elsewhere`);
      mkdirSync(join(tree, '.git'), { recursive: true });
      writeFileSync(join(tree, OWNER_MARKER), JSON.stringify({ pid: 4242, keep: false, createdAtMs: now - 60_000 }));
      // What the sweep sees from a private PID namespace: no cwd census, owner liveness unknown.
      const sweep = sweepStaleWorkRoots as unknown as (o: {
        root: string; nowMs: number; cwds: string[] | null; isAlive: (pid: number) => boolean | null;
      }) => Promise<{ removed: { name: string; reason: string }[]; kept: { name: string; reason: string }[] }>;
      const blind = await sweep({ root, nowMs: now, cwds: null, isAlive: () => null });
      expect(blind.removed).toEqual([]);
      expect(blind.kept).toContainEqual({ name: `${WORK_ROOT_PREFIX}running-elsewhere`, reason: 'owner-liveness-unknown' });
      expect(existsSync(tree)).toBe(true);
      // The same tree with a provably dead owner still goes.
      expect((await sweep({ root, nowMs: now, cwds: null, isAlive: () => false })).removed)
        .toEqual([{ name: `${WORK_ROOT_PREFIX}running-elsewhere`, reason: 'owner-dead' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('EI-28038179265277451: preserves a live kept owner outside its root during dependency preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-live-kept-owner-'));
    try {
      const now = Date.now();
      const trees = [
        { name: 'waiting-for-copy', age: 60_000 },
        { name: 'long-running-copy', age: MAX_AGE_MS + 1 },
      ];
      for (const { name, age } of trees) {
        const tree = join(root, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(join(tree, '.git'), { recursive: true });
        writeFileSync(join(tree, OWNER_MARKER), JSON.stringify({
          pid: process.pid, keep: true, createdAtMs: now - age,
        }));
      }
      const swept = await sweepStaleWorkRoots({
        root, nowMs: now, cwds: [], isAlive: (pid: number) => pid === process.pid, maxIdleKept: 0,
      });
      expect(swept.removed).toEqual([]);
      for (const { name } of trees) {
        expect(swept.kept).toContainEqual({ name: `${WORK_ROOT_PREFIX}${name}`, reason: 'owner-alive' });
        expect(existsSync(join(root, `${WORK_ROOT_PREFIX}${name}`))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a live preparing owner outside its kept tree across age and idle-cap cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-live-preparation-'));
    try {
      const now = Date.now();
      for (const ageMs of [60_000, MAX_AGE_MS + H]) {
        const name = `${WORK_ROOT_PREFIX}${ageMs}`;
        const path = join(root, name);
        mkdirSync(join(path, '.git'), { recursive: true });
        writeFileSync(join(path, OWNER_MARKER), JSON.stringify({ pid: process.pid, keep: true, createdAtMs: now - ageMs }));
      }
      const result = await mod.sweepStaleWorkRoots({ root, nowMs: now, cwds: [], isAlive: () => true, maxIdleKept: 0 });
      expect(result.removed).toEqual([]);
      expect(result.kept).toHaveLength(2);
      expect(result.kept.every((entry: { reason: string }) => entry.reason === 'owner-alive')).toBe(true);
      expect(readdirSync(root)).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rechecks owner liveness at the final retention removal boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-owner-recheck-'));
    try {
      const name = `${WORK_ROOT_PREFIX}resumed`;
      const path = join(root, name);
      mkdirSync(join(path, '.git'), { recursive: true });
      writeFileSync(join(path, OWNER_MARKER), JSON.stringify({ pid: process.pid, keep: true, createdAtMs: Date.now() }));
      const isAlive = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const result = await mod.sweepStaleWorkRoots({ root, nowMs: Date.now(), cwds: [], isAlive, maxIdleKept: 0 });
      expect(result.removed).toEqual([]);
      expect(result.kept).toContainEqual({ name, reason: 'owner-alive' });
      expect(existsSync(path)).toBe(true);
      expect(isAlive).toHaveBeenCalledTimes(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('WI-10005934: keeps only the newest MAX_IDLE_KEPT_TREES idle kept trees, never counting a busy one', async () => {
    const { MAX_IDLE_KEPT_TREES } = mod as { MAX_IDLE_KEPT_TREES: number };
    expect(MAX_IDLE_KEPT_TREES).toBe(4);
    const root = mkdtempSync(join(tmpdir(), 'lac-cap-'));
    try {
      const now = Date.now();
      const tree = (name: string, ageMs: number) => {
        const p = join(root, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(join(p, '.git'), { recursive: true });
        writeFileSync(join(p, OWNER_MARKER), JSON.stringify({ pid: 101, keep: true, createdAtMs: now - ageMs }));
        return p;
      };
      // Six idle young kept trees (all under the TTL) plus the OLDEST one, which is busy.
      for (let i = 1; i <= 6; i++) tree(`idle-${i}h`, i * 0.5 * H);
      const busy = tree('busy-oldest', KEEP_TTL_MS - 60_000);
      const names = (rows: { name: string }[]) => rows.map((r) => r.name.slice(WORK_ROOT_PREFIX.length)).sort();
      const isAlive = () => false;

      // Without /proc nothing is provably idle, so the cap removes nothing.
      const blind = await sweepStaleWorkRoots({ root, nowMs: now, cwds: null, isAlive });
      expect(blind.removed).toEqual([]);

      const res = await sweepStaleWorkRoots({ root, nowMs: now, cwds: [join(busy, 'apps')], isAlive });
      expect(names(res.removed)).toEqual(['idle-5h', 'idle-6h']);
      expect(res.removed.every((r) => r.reason === 'keep-over-cap')).toBe(true);
      expect(names(res.kept)).toEqual(['busy-oldest', 'idle-1h', 'idle-2h', 'idle-3h', 'idle-4h']);
      expect(res.kept.find((r) => r.name.endsWith('busy-oldest'))?.reason).toBe('in-use');
      expect(existsSync(busy)).toBe(true);
      expect(existsSync(join(root, `${WORK_ROOT_PREFIX}idle-6h`))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
