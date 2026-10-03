/**
 * WI-10005764 — the committed-source loader (scripts/lib/committed-source-loader.mjs).
 *
 * The restricted-hold census judges whether code a restricted session wrote may run with network,
 * but its own ~5,600-module closure lives in the same shared tree. Every census spawn therefore
 * loads this loader BEFORE tsx, so a checkout ES module runs its committed (HEAD) bytes, a new
 * uncommitted module refuses, and checkout CommonJS refuses. This suite pins that contract on a
 * scratch git repo (each verdict beside a no-loader control proving the dirty bytes are really
 * there), and then runs the REAL census CLI under the loader, forcing its closure-worker fork.
 *
 * Lives in operator-core beside restricted-hold-preflight.test.ts so the gate's lane selects it
 * (a test under scripts/lib runs only under the root config, which no gate task runs). It never
 * imports the loader: importing it registers process-wide hooks. It only spawns node with it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMITTED_SOURCE_LOADER,
  RESTRICTED_HOLD_PREFLIGHT_CLI,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  censusSpawnArgs,
} from '../../../../scripts/lib/restricted-hold-preflight.mjs';

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const AUDIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_AUDIT';

type AuditRecord = { via: 'esm' | 'cjs'; kind: string; file: string; rel: string | null };

/** process.env without git's repository-selecting variables, so `git -C <dir>` means that dir. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  delete env.NODE_OPTIONS;
  return env;
}

function git(dir: string, args: string[]): void {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: cleanEnv(),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

let fixture = '';
let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wi5764-loader-'));
  fixture = join(scratch, 'repo');
  mkdirSync(fixture);
  git(fixture, ['init', '-q']);
  put(fixture, 'package.json', '{ "type": "module" }\n');
  put(fixture, '.gitignore', 'gen/\nnode_modules/\n');
  put(fixture, 'mod.mjs', "export const v = 'HEAD';\n");
  put(fixture, 'entry.mjs', "import { v } from './mod.mjs';\nconsole.log(`V=${v}`);\n");
  // Extensionless import: only tsx's resolver can follow it, so a pass proves tsx ran AFTER the loader.
  put(fixture, 'ts/mod.ts', "export const v: string = 'HEAD';\n");
  put(fixture, 'ts/entry.ts', "import { v } from './mod';\nconsole.log(`V=${v}`);\n");
  put(fixture, 'new-entry.mjs', "import './new.mjs';\nconsole.log('ENTRY-RAN');\n");
  put(fixture, 'ignored-entry.mjs', "import { g } from './gen/out.mjs';\nconsole.log(`G=${g}`);\n");
  put(fixture, 'cjs-entry.mjs', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./c.cjs');\n");
  put(fixture, 'c.cjs', "console.log('CJS-RAN');\n");
  put(fixture, 'dep-entry.mjs', "import { d } from 'dep';\nconsole.log(`D=${d}`);\n");
  // The census's closure walk forks its worker with execArgv: [] — only NODE_OPTIONS reaches it.
  put(fixture, 'fork-entry.mjs', [
    "import { fork } from 'node:child_process';",
    "const child = fork(new URL('./child.mjs', import.meta.url), [], { execArgv: [] });",
    'child.on(\'exit\', (code) => process.exit(code ?? 1));',
    '',
  ].join('\n'));
  put(fixture, 'child.mjs', "import { v } from './mod.mjs';\nconsole.log(`CHILD=${v}`);\n");
  // WI-10005802: a door ENTRY (the file node was asked to run), not just a module it imports.
  put(fixture, 'door.mjs', "console.log('DOOR=HEAD');\n");
  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', 'fixture']);

  // The working tree after the commit: what a held restricted write would look like.
  put(fixture, 'door.mjs', "console.log('DOOR=DIRTY');\n");
  put(fixture, 'new-door.mjs', "console.log('NEW-DOOR-RAN');\n");
  put(fixture, 'mod.mjs', "export const v = 'DIRTY';\n");
  put(fixture, 'ts/mod.ts', "export const v: string = 'DIRTY';\n");
  put(fixture, 'new.mjs', "console.log('NEW-RAN');\n");
  put(fixture, 'gen/out.mjs', "export const g = 'GEN';\n");
  put(fixture, 'node_modules/dep/package.json', '{ "name": "dep", "type": "module", "exports": "./index.mjs" }\n');
  put(fixture, 'node_modules/dep/index.mjs', "export const d = 'DEP';\n");
  // `--import tsx` resolves from the cwd; the real package lives under the repo's node_modules.
  symlinkSync(join(REPO, 'node_modules', 'tsx'), join(fixture, 'node_modules', 'tsx'), 'dir');
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** The census's own loader prefix (everything before the CLI path), so this is the real door argv. */
function censusPrefix(): { prefix: string[]; env: NodeJS.ProcessEnv } {
  const census = censusSpawnArgs([], cleanEnv());
  return { prefix: census.argv.slice(0, census.argv.indexOf(RESTRICTED_HOLD_PREFLIGHT_CLI)), env: census.env };
}

function run(argv: string[], env: NodeJS.ProcessEnv, auditFile?: string) {
  const result = spawnSync(process.execPath, argv, {
    cwd: fixture,
    env: auditFile ? { ...env, [AUDIT_ENV]: auditFile } : env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function underLoader(entry: string, auditFile?: string) {
  const { prefix, env } = censusPrefix();
  return run([...prefix, entry], env, auditFile);
}

function readAudit(file: string): AuditRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditRecord);
}

describe('committed-source loader — a scratch checkout', () => {
  it('censusSpawnArgs puts the loader first and tsx second', () => {
    expect(censusPrefix().prefix).toEqual(['--import', COMMITTED_SOURCE_LOADER, '--import', 'tsx']);
  });

  it('runs the HEAD bytes of a dirty module, and says so on stderr', () => {
    const control = run(['entry.mjs'], cleanEnv());
    expect(control.stdout).toContain('V=DIRTY');

    const audit = join(scratch, 'dirty.audit');
    const loaded = underLoader('entry.mjs', audit);
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('V=HEAD');
    expect(loaded.stdout).not.toContain('V=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted mod.mjs');
    const kinds = Object.fromEntries(readAudit(audit).filter((r) => r.rel).map((r) => [r.rel, r.kind]));
    expect(kinds).toMatchObject({ 'entry.mjs': 'committed', 'mod.mjs': 'substituted' });
  }, 60_000);

  it('substitutes BEFORE tsx transforms: a dirty TypeScript module runs its committed version', () => {
    const control = run(['--import', 'tsx', 'ts/entry.ts'], cleanEnv());
    expect(control.stdout).toContain('V=DIRTY');

    const loaded = underLoader('ts/entry.ts');
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('V=HEAD');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted ts/mod.ts');
  }, 60_000);

  it('refuses a module with no committed version that git does not ignore, before any code runs', () => {
    const control = run(['new-entry.mjs'], cleanEnv());
    expect(control.stdout).toContain('NEW-RAN');

    const loaded = underLoader('new-entry.mjs');
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused new.mjs');
    expect(loaded.stdout).not.toContain('NEW-RAN');
    expect(loaded.stdout).not.toContain('ENTRY-RAN');
  }, 60_000);

  it('runs an ignored file (generated output) and a node_modules dependency as read', () => {
    const audit = join(scratch, 'ignored.audit');
    const ignored = underLoader('ignored-entry.mjs', audit);
    expect(ignored.status).toBe(0);
    expect(ignored.stdout).toContain('G=GEN');

    const dep = underLoader('dep-entry.mjs', audit);
    expect(dep.status).toBe(0);
    expect(dep.stdout).toContain('D=DEP');

    const records = readAudit(audit);
    expect(records.find((r) => r.rel === 'gen/out.mjs')?.kind).toBe('ignored');
    expect(records.find((r) => r.rel === 'node_modules/dep/index.mjs')?.kind).toBe('dependency');
  }, 60_000);

  it('refuses a checkout module loaded through CommonJS, which the ES hook cannot judge', () => {
    const control = run(['cjs-entry.mjs'], cleanEnv());
    expect(control.stdout).toContain('CJS-RAN');

    const loaded = underLoader('cjs-entry.mjs');
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused c.cjs');
    expect(loaded.stdout).not.toContain('CJS-RAN');
  }, 60_000);

  it('reaches a child forked with execArgv: [] through NODE_OPTIONS, and only through it', () => {
    const { prefix, env } = censusPrefix();
    const loaded = run([...prefix, 'fork-entry.mjs'], env);
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('CHILD=HEAD');

    // Control: the same argv without the NODE_OPTIONS half leaves the forked child unjudged.
    const withoutOptions = { ...env };
    delete withoutOptions.NODE_OPTIONS;
    expect(run([...prefix, 'fork-entry.mjs'], withoutOptions).stdout).toContain('CHILD=DIRTY');
  }, 60_000);

  // WI-10005802: the doors start their own node entries (the router, the tree and bundle gates,
  // the bundle-host helpers) as `node --import <loader> <entry>` — no tsx, no NODE_OPTIONS — so a
  // held write to the ENTRY itself runs its committed bytes, and a new uncommitted entry refuses.
  it('runs the committed bytes of a dirty door ENTRY started as `node --import <loader> <entry>`', () => {
    expect(run(['door.mjs'], cleanEnv()).stdout).toContain('DOOR=DIRTY');

    const loaded = run(['--import', COMMITTED_SOURCE_LOADER, 'door.mjs'], cleanEnv());
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toContain('DOOR=HEAD');
    expect(loaded.stdout).not.toContain('DOOR=DIRTY');
    expect(loaded.stderr).toContain('COMMITTED_SOURCE substituted door.mjs');
  }, 60_000);

  it('refuses a door entry with no committed version before it runs', () => {
    expect(run(['new-door.mjs'], cleanEnv()).stdout).toContain('NEW-DOOR-RAN');

    const loaded = run(['--import', COMMITTED_SOURCE_LOADER, 'new-door.mjs'], cleanEnv());
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('COMMITTED_SOURCE refused new-door.mjs');
    expect(loaded.stdout).not.toContain('NEW-DOOR-RAN');
  }, 60_000);
});

/**
 * WI-10005802: the CLI launchers of the test router. testing:run judges the router's own closure in
 * its in-process census before it spawns the router; the CLI paths have no such step, so they
 * start the router (and the install-mutex hop before it) under the committed-source loader.
 */
describe('committed-source loader — the test router CLI launchers', () => {
  const LOADER_FLAG = '--import ./scripts/lib/committed-source-loader.mjs';
  const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

  it('every root package.json script that starts the router or its install-mutex hop passes the loader first', () => {
    const launches = Object.entries(scripts).flatMap(([name, command]) =>
      [...command.matchAll(/\bnode\s+((?:--\S+\s+(?:\S+\s+)?)*?)(scripts\/(?:test-files|npm-install-safe)\.mjs)/g)].map((m) => ({
        name,
        entry: m[2],
        flags: m[1].trim(),
      })),
    );
    // Positive control: the population this guard judges is real.
    expect(launches.map((l) => l.name)).toEqual(expect.arrayContaining(['test:file', 'lint:tool-prompts']));
    // install:safe is the dependency installer, not a door: it runs no test code.
    const doors = launches.filter((l) => l.name !== 'install:safe');
    expect(doors.filter((l) => l.flags !== LOADER_FLAG)).toEqual([]);
    expect(scripts['test:file']).toContain(`node ${LOADER_FLAG} scripts/npm-install-safe.mjs --exec-under-lock -- node ${LOADER_FLAG} scripts/test-files.mjs`);
  });

  it('scripts/workspace-test.mjs routes explicit files through the router under the loader', async () => {
    const { workspaceTestInvocation } = (await import('../../../../scripts/workspace-test.mjs')) as {
      workspaceTestInvocation: (argv: string[], repoRoot: string) => { command: string; args: string[]; routed: boolean };
    };
    const invocation = workspaceTestInvocation(['a.test.ts'], REPO);
    expect(invocation.routed).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(['--import', COMMITTED_SOURCE_LOADER, join(REPO, 'scripts', 'test-files.mjs')]);
  });
});

describe('committed-source loader — the real census closure', () => {
  function census(args: string[], holdings: unknown[]) {
    const dir = mkdtempSync(join(scratch, 'census-'));
    const holdingsFile = join(dir, 'census.json');
    const audit = join(dir, 'audit');
    writeFileSync(holdingsFile, JSON.stringify(holdings));
    const spawn = censusSpawnArgs(args, { ...cleanEnv(), VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: holdingsFile, [AUDIT_ENV]: audit });
    const result = spawnSync(process.execPath, spawn.argv, { cwd: REPO, env: spawn.env, encoding: 'utf8', timeout: 120_000 });
    const verdictLine = (result.stdout ?? '').split('\n').find((l) => l.startsWith(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} `));
    return {
      status: result.status,
      stderr: result.stderr ?? '',
      verdict: verdictLine ? JSON.parse(verdictLine.slice(RESTRICTED_HOLD_PREFLIGHT_MARKER.length + 1)) : null,
      records: readAudit(audit),
    };
  }

  it('the census and its forked closure worker run only committed ES modules (none CommonJS, none uncommitted)', () => {
    // A held path that is neither a test nor runner-loaded makes router mode walk the import
    // closure, which forks mutation-probe-closure.worker with execArgv: [].
    const held = join(REPO, '.papercusp', 'scratch', 'wi5764-held-nonexistent.ts');
    const test = join(REPO, 'packages/operator-core/lib/__tests__/restricted-hold-preflight.test.ts');
    const result = census([REPO, test], [{ path: held, owner: 'su-restricted', intent: 'x' }]);

    expect(result.status).toBe(RESTRICTED_HOLD_PREFLIGHT_EXIT.admit);
    expect(result.verdict).toEqual({ verdict: 'admit' });

    const judged = result.records.filter((r) => r.kind === 'committed' || r.kind === 'substituted');
    expect(judged.some((r) => r.rel === 'packages/operator-core/lib/agent-tools/testing/restricted-hold-preflight-cli.ts')).toBe(true);
    // The forked worker reached the loader through NODE_OPTIONS alone.
    expect(judged.some((r) => /mutation-probe-closure\.worker\.[mc]?[jt]s$/.test(r.rel ?? ''))).toBe(true);
    expect(result.records.filter((r) => r.kind === 'commonjs' || r.kind === 'uncommitted')).toEqual([]);
  }, 180_000);
});
