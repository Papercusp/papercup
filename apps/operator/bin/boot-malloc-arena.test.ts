/**
 * boot-malloc-arena: every host launch path gets a glibc malloc arena cap,
 * whether or not its launcher set one (host-memory-reduction-2026-09-27).
 *
 * The planner is tested directly; the side-effect module is only ever run in
 * a spawned child, because importing it here would re-exec a vitest worker if
 * the host-entry guard ever regressed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as realPlanner from './malloc-arena-reexec';

// Probe seam: scripts/mutation-probe.sh (copy-out mode) points this at a mutated copy.
const { HOST_MALLOC_ARENA_MAX, planMallocArenaReexec }: typeof realPlanner = process.env
  .MALLOC_ARENA_REEXEC_SUBJECT
  ? await import(process.env.MALLOC_ARENA_REEXEC_SUBJECT)
  : realPlanner;

const repoRoot = join(__dirname, '../../..');

const base = {
  platform: 'linux' as NodeJS.Platform,
  env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096' } as NodeJS.ProcessEnv,
  execPath: '/opt/node/bin/node',
  execArgv: ['--require', '/r/tsx/preflight.cjs', '--import', 'file:///r/tsx/loader.mjs'],
  argv: ['/opt/node/bin/node', '/repo/apps/operator/bin/hono-host.ts', '--ensure'],
  isMainThread: true,
  hasExecve: true,
};

describe('planMallocArenaReexec', () => {
  it('re-executes an uncapped host with its exact argv, execArgv and env plus the cap', () => {
    const plan = planMallocArenaReexec({ ...base, env: { ...base.env, DROPPED: undefined } });
    expect(plan).toEqual({
      action: 'reexec',
      file: '/opt/node/bin/node',
      args: [
        '/opt/node/bin/node',
        '--require',
        '/r/tsx/preflight.cjs',
        '--import',
        'file:///r/tsx/loader.mjs',
        '/repo/apps/operator/bin/hono-host.ts',
        '--ensure',
      ],
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096', MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX },
    });
  });

  it.each([
    '/repo/apps/operator/bin/hono-host.ts',
    '/repo/papercup-release/apps/operator/dist-host/hono-host.mjs',
    '/opt/papercusp/sidecar/serve.mjs',
    '/repo/apps/operator/bin/serve.ts',
    'C:\\papercusp\\sidecar\\serve.mjs',
  ])('treats %s as a host entry', (entry) => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n', entry] }).action).toBe('reexec');
  });

  it.each([
    '/repo/node_modules/vitest/dist/workers/forks.js',
    '/repo/apps/operator/bin/hono-host.test.ts',
    '/repo/scripts/observe.mjs',
    '/repo/apps/operator/bin/serve-helpers.ts',
  ])('leaves an importer launched as %s alone', (entry) => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n', entry] })).toEqual({
      action: 'none',
      reason: 'not-host-entry',
    });
  });

  it('leaves argv-less processes alone', () => {
    expect(planMallocArenaReexec({ ...base, argv: ['/n'] })).toEqual({ action: 'none', reason: 'not-host-entry' });
  });

  it.each([
    [{ platform: 'darwin' as NodeJS.Platform }, 'not-linux'],
    [{ env: { MALLOC_ARENA_MAX: '8' } }, 'already-set'],
    [{ env: { GLIBC_TUNABLES: 'glibc.malloc.arena_max=4' } }, 'tunable-set'],
    [{ isMainThread: false }, 'worker-thread'],
    [{ hasExecve: false }, 'no-execve'],
  ] as const)('does not re-exec when %o (%s)', (override, reason) => {
    expect(planMallocArenaReexec({ ...base, ...override })).toEqual({ action: 'none', reason });
  });
});

describe.runIf(process.platform === 'linux')('boot-malloc-arena re-exec, end to end', () => {
  let dir: string;
  const uncappedEnv = () => {
    const env = { ...process.env };
    delete env.MALLOC_ARENA_MAX;
    delete env.GLIBC_TUNABLES;
    return env;
  };
  const fixture = (name: string) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      `import ${JSON.stringify(join(__dirname, 'boot-malloc-arena.ts'))};\n` +
        'console.log(JSON.stringify({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX ?? null, ' +
        'args: process.argv.slice(2) }));\n',
    );
    return path;
  };
  const run = (script: string, env: NodeJS.ProcessEnv) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--flag', 'x y'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return { result, out: JSON.parse(result.stdout.trim().split('\n').pop()!) };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-malloc-arena-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-executes an uncapped host in place: same pid, cap set, argv kept, one log line', () => {
    const { result, out } = run(fixture('serve.ts'), uncappedEnv());
    expect(out).toEqual({ pid: result.pid, cap: HOST_MALLOC_ARENA_MAX, args: ['--flag', 'x y'] });
    const lines = result.stderr.split('\n').filter((l) => l.includes('[boot-malloc-arena]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`re-executing pid ${result.pid} with MALLOC_ARENA_MAX=${HOST_MALLOC_ARENA_MAX}`);
  });

  it('keeps a launcher-set value and does not re-exec', () => {
    const { result, out } = run(fixture('hono-host.ts'), { ...uncappedEnv(), MALLOC_ARENA_MAX: '8' });
    expect(out.cap).toBe('8');
    expect(result.stderr).not.toContain('[boot-malloc-arena]');
  });

  it('does nothing in a process that only imports a host module', () => {
    const { result, out } = run(fixture('some-tool.ts'), uncappedEnv());
    expect(out.cap).toBeNull();
    expect(result.stderr).not.toContain('[boot-malloc-arena]');
  });
});

describe('host entries import boot-malloc-arena before anything else', () => {
  it.each(['hono-host.ts', 'serve.ts'])('%s', (entry) => {
    const src = readFileSync(join(__dirname, entry), 'utf8');
    const firstImport = src.match(/^import\s[^;]*;/m)?.[0];
    expect(firstImport?.replace(/"/g, "'")).toBe("import './boot-malloc-arena';");
  });
});
