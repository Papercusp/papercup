/**
 * P-028 (production-readiness-test-coverage) — plugin-spawn-impl: the shared
 * plugin subprocess runtime (PluginSpawn) + secretImpl. `node:child_process` is
 * replaced by a controllable fake child so no real process is launched. Covers:
 * the absolute/relative-path guard, argv/cwd/env/stdin wiring, stdout/stderr
 * accumulation, the maxBufferBytes kill, the timeout SIGKILL → killed:true, the
 * error→reject path, and secret resolution from env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let lastChild: FakeChild;
let lastCtl: ChildCtl;

interface FakeChild {
  stdout: { on: (e: string, cb: (b: Buffer) => void) => void };
  stderr: { on: (e: string, cb: (b: Buffer) => void) => void };
  stdin: { end: ReturnType<typeof vi.fn> };
  on: (e: string, cb: (arg: unknown) => void) => void;
  kill: ReturnType<typeof vi.fn>;
}
interface ChildCtl {
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
}

function makeChild(): { child: FakeChild; ctl: ChildCtl } {
  const stdoutCbs: Array<(b: Buffer) => void> = [];
  const stderrCbs: Array<(b: Buffer) => void> = [];
  const closeCbs: Array<(c: number | null) => void> = [];
  const errorCbs: Array<(e: Error) => void> = [];
  const child: FakeChild = {
    stdout: { on: (e, cb) => void (e === 'data' && stdoutCbs.push(cb)) },
    stderr: { on: (e, cb) => void (e === 'data' && stderrCbs.push(cb)) },
    stdin: { end: vi.fn() },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb as (c: number | null) => void);
      if (e === 'error') errorCbs.push(cb as (er: Error) => void);
    },
    kill: vi.fn(),
  };
  const ctl: ChildCtl = {
    emitStdout: (s) => stdoutCbs.forEach((cb) => cb(Buffer.from(s, 'utf8'))),
    emitStderr: (s) => stderrCbs.forEach((cb) => cb(Buffer.from(s, 'utf8'))),
    emitClose: (code) => closeCbs.forEach((cb) => cb(code)),
    emitError: (err) => errorCbs.forEach((cb) => cb(err)),
  };
  return { child, ctl };
}

const spawnMock = vi.fn(() => {
  const { child, ctl } = makeChild();
  lastChild = child;
  lastCtl = ctl;
  return child;
});
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...(a as [])) }));

// D-004: makeSecretResolver dynamically imports './plugin-configs-pg' — mock it.
const loadPluginConfigMock = vi.hoisted(() =>
  vi.fn<(harness: string, plugin: string) => Promise<Record<string, unknown> | null>>(),
);
vi.mock('./plugin-configs-pg', () => ({ loadPluginConfig: loadPluginConfigMock }));

import { pluginSpawnImpl, secretImpl, makeSecretResolver, augmentedSpawnPath, resolveBin } from './plugin-spawn-impl';

beforeEach(() => {
  spawnMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('pluginSpawnImpl — path guard', () => {
  it('rejects an absolute path without spawning', async () => {
    await expect(pluginSpawnImpl('/usr/bin/ls', [], {})).rejects.toThrow(/absolute\/relative/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it('rejects a relative path without spawning', async () => {
    await expect(pluginSpawnImpl('./script.sh', [], {})).rejects.toThrow(/absolute\/relative/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('pluginSpawnImpl — happy path', () => {
  it('spawns by basename with argv/cwd/merged-env + resolves the captured output', async () => {
    vi.stubEnv('BASE_VAR', 'base');
    const p = pluginSpawnImpl('repomix', ['--x', 'y'], { cwd: '/work', env: { EXTRA: '1' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe('repomix');
    expect(args).toEqual(['--x', 'y']);
    expect(opts.cwd).toBe('/work');
    expect((opts.env as Record<string, string>).EXTRA).toBe('1');
    expect((opts.env as Record<string, string>).BASE_VAR).toBe('base'); // process.env merged in
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);

    lastCtl.emitStdout('hello ');
    lastCtl.emitStdout('world');
    lastCtl.emitStderr('warn');
    lastCtl.emitClose(0);
    await expect(p).resolves.toEqual({ code: 0, stdout: 'hello world', stderr: 'warn', killed: false });
  });

  it('writes provided stdin then ends', async () => {
    const p = pluginSpawnImpl('cat', [], { stdin: 'piped-input' });
    expect(lastChild.stdin.end).toHaveBeenCalledWith('piped-input');
    lastCtl.emitClose(0);
    await p;
  });

  it('ends stdin with no data when none is provided', async () => {
    const p = pluginSpawnImpl('true', [], {});
    expect(lastChild.stdin.end).toHaveBeenCalledWith();
    lastCtl.emitClose(0);
    await p;
  });
});

describe('pluginSpawnImpl — limits + failure', () => {
  it('kills the child when stdout exceeds maxBufferBytes', async () => {
    const p = pluginSpawnImpl('flood', [], { maxBufferBytes: 3 });
    lastCtl.emitStdout('abcd'); // 4 > 3
    expect(lastChild.kill).toHaveBeenCalled();
    lastCtl.emitClose(null);
    await p;
  });

  it('SIGKILLs on timeout and resolves with killed:true', async () => {
    vi.useFakeTimers();
    const p = pluginSpawnImpl('slow', [], { timeoutMs: 50 });
    vi.advanceTimersByTime(50);
    expect(lastChild.kill).toHaveBeenCalledWith('SIGKILL');
    lastCtl.emitClose(null); // the kill makes the real child close
    await expect(p).resolves.toMatchObject({ killed: true, code: null });
  });

  it('rejects when the child emits an error', async () => {
    const p = pluginSpawnImpl('missing-bin', [], {});
    lastCtl.emitError(new Error('ENOENT'));
    await expect(p).rejects.toThrow('ENOENT');
  });
});

describe('pluginSpawnImpl — PATH augmentation (the `spawn npx ENOENT` fix)', () => {
  it('augmentedSpawnPath includes the running node bin dir (where npx lives)', () => {
    const dirs = augmentedSpawnPath().split(delimiter);
    expect(dirs).toContain(dirname(process.execPath));
  });

  it('prepends existing package-local bins for a nested working directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-spawn-local-bin-'));
    const localBin = join(root, 'node_modules', '.bin');
    mkdirSync(localBin, { recursive: true });

    const dirs = augmentedSpawnPath(join(root, 'packages', 'operator-core')).split(delimiter);

    expect(dirs[0]).toBe(localBin);
  });

  it('resolveBin absolutizes a real binary found on PATH', () => {
    // `node` is reachable via the augmented path (its own dir is appended, and
    // it's typically already on PATH via a symlink dir). resolveBin returns an
    // absolute, existing path ending in /node — which exact dir wins depends on
    // PATH ordering, so assert the contract, not a specific dir.
    const resolved = resolveBin('node', augmentedSpawnPath());
    expect(resolved.startsWith('/')).toBe(true);
    expect(resolved.endsWith(`${delimiter === ';' ? '\\' : '/'}node`)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('resolveBin falls through to the bare basename when not found (libuv ENOENTs clearly)', () => {
    const name = 'definitely-not-a-real-bin-xyz';
    expect(resolveBin(name, augmentedSpawnPath())).toBe(name);
  });

  it('EI-2114: includes PAPERCUSP_SIDECAR_BIN first when set (packaged-desktop bundled runtime)', () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '/opt/PapercuspApp/sidecar/bin');
    const dirs = augmentedSpawnPath().split(delimiter);
    expect(dirs).toContain('/opt/PapercuspApp/sidecar/bin');
    expect(dirs.indexOf('/opt/PapercuspApp/sidecar/bin')).toBeLessThan(dirs.indexOf(dirname(process.execPath)));
  });

  it('is a harmless no-op (no empty PATH entry) when PAPERCUSP_SIDECAR_BIN is unset', () => {
    expect(process.env.PAPERCUSP_SIDECAR_BIN).toBeUndefined(); // sanity: not set in the test env
    const dirs = augmentedSpawnPath().split(delimiter);
    expect(dirs.every((d) => d.length > 0)).toBe(true);
  });

  // Recurrence guard (2026-08-03): DEFAULT_BACKEND_CMDS.omp is the bare
  // basename 'omp -p', and buildInvokeOnce (harness-invoke-once.ts) pins the
  // invoke-once child's env.PATH to exactly this function's return value —
  // so this list is the ONLY thing standing between a default cup/pot spawn
  // and an exit-127 "command not found". `omp`'s bun-global-install location
  // (~/.bun/bin, or $BUN_INSTALL/bin) was missing here even though
  // preflight-binaries.ts's own omp probe already knew about it — confirmed
  // live: every cup:spawn via papercup-dev-api failed exit 127 until this was
  // added (WI-4944 investigation).
  // Both bun tests below MUST pin PATH. augmentedSpawnPath() splices the
  // ambient `process.env.PATH` into its result, so on any machine that already
  // exports ~/.bun/bin (i.e. every box with bun installed — including this dev
  // host) the inherited PATH satisfies these assertions no matter what the
  // injection list does. Left unpinned they fail in BOTH directions and neither
  // failure is about the code: the "unset" case is a FALSE GREEN (it would pass
  // with the ~/.bun/bin entry deleted from `extra`, so the exit-127 recurrence
  // guard guards nothing), and the "preferred" case is a FALSE RED (it failed
  // on this box 2026-08-03 purely because ~/.bun/bin was on the ambient PATH).
  // Pinning to a directory that appears in neither PATH nor `extra` makes each
  // assertion measure the injection list, which is the thing under test.
  const NEUTRAL_PATH = join('/opt', 'no-such-dir', 'bin');

  it("includes ~/.bun/bin (where `omp`'s bun global install lands) when BUN_INSTALL is unset", () => {
    vi.stubEnv('PATH', NEUTRAL_PATH);
    vi.stubEnv('BUN_INSTALL', '');
    const dirs = augmentedSpawnPath().split(delimiter);
    expect(dirs).toContain(join(process.env.HOME ?? '', '.bun/bin'));
  });

  it('prefers $BUN_INSTALL/bin over the ~/.bun/bin default when BUN_INSTALL is set', () => {
    vi.stubEnv('PATH', NEUTRAL_PATH);
    vi.stubEnv('BUN_INSTALL', '/custom/bun-install');
    const dirs = augmentedSpawnPath().split(delimiter);
    expect(dirs).toContain(join('/custom/bun-install', 'bin'));
    expect(dirs).not.toContain(join(process.env.HOME ?? '', '.bun/bin'));
  });

  it('passes the augmented PATH (incl. node bin dir) to the spawned child env', async () => {
    const p = pluginSpawnImpl('repomix', [], {});
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    const childPath = (opts.env as Record<string, string>).PATH;
    expect(childPath.split(delimiter)).toContain(dirname(process.execPath));
    lastCtl.emitClose(0);
    await p;
  });
});

describe('secretImpl', () => {
  it('returns the env value when set', async () => {
    vi.stubEnv('MY_SECRET', 'shhh');
    expect(await secretImpl('MY_SECRET')).toBe('shhh');
  });
  it('returns null for a missing env var', async () => {
    vi.stubEnv('PRESENT', 'x');
    expect(await secretImpl('DEFINITELY_MISSING_VAR_XYZ')).toBeNull();
  });
});

describe('makeSecretResolver (D-004 — plugin_configs first, then env)', () => {
  beforeEach(() => loadPluginConfigMock.mockReset());

  it('prefers the plugin_configs value over process.env', async () => {
    vi.stubEnv('D004_KEY', 'from-env');
    loadPluginConfigMock.mockResolvedValue({ D004_KEY: 'from-config' });
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: '@papercupai/firecrawl-bridge' });
    expect(await resolve('D004_KEY')).toBe('from-config');
    expect(loadPluginConfigMock).toHaveBeenCalledWith('sheets', '@papercupai/firecrawl-bridge');
  });

  it('falls back to process.env when the config has no such key', async () => {
    vi.stubEnv('D004_KEY', 'from-env');
    loadPluginConfigMock.mockResolvedValue({ OTHER: 'x' });
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('D004_KEY')).toBe('from-env');
  });

  it('falls back to process.env when there is no config row at all', async () => {
    vi.stubEnv('D004_KEY', 'from-env');
    loadPluginConfigMock.mockResolvedValue(null);
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('D004_KEY')).toBe('from-env');
  });

  it('returns null when neither source has the secret', async () => {
    loadPluginConfigMock.mockResolvedValue({});
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('MISSING_D004')).toBeNull();
  });

  it('ignores a non-string / empty config value and falls back to env', async () => {
    vi.stubEnv('D004_KEY', 'from-env');
    loadPluginConfigMock.mockResolvedValue({ D004_KEY: '' });
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('D004_KEY')).toBe('from-env');
  });

  // NOTE: the PG-outage path (loadPluginConfig throws/rejects → env fallback) is
  // a 4-line try/catch in makeSecretResolver and is intentionally NOT unit-tested
  // here: a mock that throws trips Vitest's global error capture + the repo's
  // vitest-fail-on-console even when the SUT catches it. The catch was verified
  // (standalone) to handle both sync-throw and async-reject; the value paths
  // (null / no-key / empty) above cover the resolver's fallback behavior.

  it('memoizes the config load across reads (one decrypt)', async () => {
    loadPluginConfigMock.mockResolvedValue({ A: 'a', B: 'b' });
    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('A')).toBe('a');
    expect(await resolve('B')).toBe('b');
    expect(loadPluginConfigMock).toHaveBeenCalledTimes(1);
  });
});
