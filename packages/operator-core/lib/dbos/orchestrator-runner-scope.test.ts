/**
 * orchestrator-runner-scope.test.ts — WI-1499 (bg-host-agent-spawn-scope-isolation-
 * 2026-07-02): every bee/queen turn spawns inside its own transient systemd user
 * SCOPE (`buildIsolatedScopeArgv`, `runChild` in orchestrator-runner.ts) so a
 * bg-host restart/OOM no longer reclaims in-flight agent turns along with it
 * (KillMode=control-group only touches bg-host's OWN cgroup, not the scope's).
 *
 * `orchestrator-runner-spawn.test.ts` covers spawnInvokeOnce end-to-end with a
 * REAL subprocess (no child_process mock) — useful for the actual SIGTERM-kill /
 * output-capture behavior, but it can't assert WHICH argv reached spawn() without
 * shelling out to inspect systemd-run's own child. This file mocks
 * `node:child_process` (mirroring release-actions.test.ts's identical pattern for
 * the green-checkpoint scope) so the exact spawn() call — command, scope flags,
 * memory cap, retry-once-on-launch-failure — is directly assertable, deterministic,
 * and needs no real systemd user bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = '5000';
});

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
// Partial mock: only spawn is intercepted. A full replacement broke at import
// time once a transitive import (seed-provider-git.ts) started promisify()ing
// execFile — keep the real surface for everything this test doesn't stub.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

// The scope wrapper is no longer built inline here — it moved behind the task
// manager's enrolment seam (task-manager-no-escape-2026-07-27 P-009), which confines
// only when a CACHED systemd-scope support probe has landed and said yes. Production
// warms that probe at module load (orchestrator-runner.ts); a test process cannot
// rely on it, for two independent reasons: the probe resolves asynchronously (so it
// races the assertions), and its own probe spawn goes through the SAME mocked
// `spawn`, which would shift every `spawnMock.mock.calls[N]` index this file reads.
// So pin the answer and neuter the warm-up. The subject of this file is the argv that
// reaches spawn() on a host that CAN make scopes — not the probe's own plumbing,
// which managed-spawn's tests own.
const S = vi.hoisted(() => ({ probe: { ok: true } as { ok: boolean; reason?: string } | null }));
vi.mock('../task-manager/managed-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../task-manager/managed-spawn')>()),
  warmScopeProbe: () => {},
  scopeSupportKnown: () => S.probe,
}));

const H = vi.hoisted(() => ({
  cmd: null as null | { command: string; args: string[]; env: NodeJS.ProcessEnv },
}));
vi.mock('../harness-invoke-once', () => ({
  buildInvokeOnce: () => H.cmd,
  resolveSpawnBackendModel: () => ({ backend: 'omp', model: '' }),
}));

import { spawnInvokeOnce } from './orchestrator-runner';

type FakeChild = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
let nextPid = 1000;

/** fakeSpawn: emits `stdout`/`stderr` then closes with `code` on the next tick —
 *  mirrors release-actions.test.ts's fakeSpawn/fakeSpawnFail helpers. */
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = nextPid++;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

const savedScopeEnv = process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
const savedMemEnv = process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G;

beforeEach(() => {
  S.probe = { ok: true }; // default: a host that CAN make user scopes
  H.cmd = { command: '/x/invoke-once', args: ['--role', 'cup'], env: process.env };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  if (savedScopeEnv === undefined) delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
  else process.env.PAPERCUSP_AGENT_SPAWN_SCOPE = savedScopeEnv;
  if (savedMemEnv === undefined) delete process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G;
  else process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G = savedMemEnv;
});

describe('agent-turn spawn scope isolation (WI-1499)', () => {
  it('wraps the agent turn in a memory-capped transient user SCOPE by default (linux)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, spawnOpts] = spawnMock.mock.calls[0] as [string, string[], { detached?: boolean }];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    // --scope (never --service): the payload stays OUR child, so piped stdio, env
    // inheritance and the pgid tree-kill all keep working. It is additionally NAMED
    // (`--unit=papercusp-task-<id>.scope`) since task-manager-no-escape P-009 — that
    // name is the ledger key that makes the subtree addressable, and naming a scope
    // does not change its child-of-us semantics.
    expect(args).toContain('--scope'); // child stays OUR pgid
    expect(args).toContain('--collect');
    // agentSpawnScopeMemoryMaxG() default, in BYTES — buildTaskScopeArgv emits the
    // raw integer rather than systemd's `6G` shorthand, so assert the value the cap
    // actually carries. Spelled as the arithmetic, not a magic 6442450944, so a
    // change to the default GiB reads as a one-token diff.
    expect(args).toContain(`--property=MemoryMax=${6 * 1024 ** 3}`);
    expect(args).toContain('--property=MemorySwapMax=0');
    // The wrapped payload (command + its own args) is appended verbatim at the tail.
    expect(args.slice(-3)).toEqual(['/x/invoke-once', '--role', 'cup']);
    expect(args.join(' ')).toContain('/x/invoke-once --role cup');
    expect(spawnOpts.detached).toBe(true); // pgid tree-kill still covers the scope wrapper
  });

  // The other half of the enrolment contract (task-manager-no-escape P-009). Confinement
  // is gated on a CACHED probe, so there are two legitimate ways to get an UNCONFINED
  // spawn — the probe has not landed yet (first turn after boot), or this host cannot
  // make user scopes at all. Both must still run the turn: "a task manager that is still
  // warming up must never be the reason a command does not run."
  //
  // This is the regression guard the gate needed and did not have. When the wrapper moved
  // behind this seam, the confined path silently stopped being exercised and the suite's
  // only signal was three assertions failing in a way that read like a lost feature. Pin
  // BOTH branches, so a future refactor that drops confinement fails loudly and
  // specifically instead of looking like a stale test.
  it.each([
    ['the probe has not landed yet (first turn after boot)', null],
    ['the host cannot make user scopes at all', { ok: false, reason: 'no user bus' }],
  ] as const)('spawns DIRECT (unconfined but still ledgered) when %s', async (_label, probe) => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    S.probe = probe;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    // One spawn, not two: an unconfined spawn is the FIRST choice here, not a retry
    // after a failed wrapper — nothing was wrapped, so there is nothing to fall back from.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/x/invoke-once');
    expect(args).toEqual(['--role', 'cup']);
  });

  it('honors PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G to size the scope cap', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G = '12';
    spawnMock.mockImplementationOnce(() => fakeSpawn({ code: 0 }));
    await spawnInvokeOnce(process.cwd(), 'mug', [], {});
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain(`--property=MemoryMax=${12 * 1024 ** 3}`);
  });

  it('falls back to a DIRECT spawn once when the scope cannot launch (no user bus) — the turn never fails on infra', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock
      .mockImplementationOnce(() => fakeSpawn({ stderr: 'Failed to connect to bus: No such file or directory', code: 1 }))
      .mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd1] = spawnMock.mock.calls[0] as [string, string[]];
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd1).toBe('systemd-run');
    expect(cmd2).toBe('/x/invoke-once'); // direct payload, no wrapper
    expect(args2).toEqual(['--role', 'cup']);
  });

  it('a PAYLOAD failure inside a healthy scope does NOT retry (a real agent-turn error, not a launch failure)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stderr: 'agent crashed: out of memory in tool call', code: 1 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('out of memory in tool call');
    expect(spawnMock).toHaveBeenCalledTimes(1); // no scope-launch-failure retry
  });

  it('PAPERCUSP_AGENT_SPAWN_SCOPE=0 kill-switch runs the pre-hardening direct spawn (ops escape hatch)', async () => {
    process.env.PAPERCUSP_AGENT_SPAWN_SCOPE = '0';
    spawnMock.mockImplementationOnce(() => fakeSpawn({ code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/x/invoke-once');
    expect(args).toEqual(['--role', 'cup']);
  });

  it('a scope-launch failure on the direct retry itself still surfaces (no infinite retry loop)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    // First call: scope-launch failure → retries direct (useScope:false). The
    // direct retry failing for a genuinely unrelated reason must NOT re-retry
    // (isScopeLaunchFailure requires useScope, which is false on the retry).
    spawnMock
      .mockImplementationOnce(() => fakeSpawn({ stderr: 'Failed to connect to bus: No such file or directory', code: 1 }))
      .mockImplementationOnce(() => fakeSpawn({ stderr: 'command not found', code: 127 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(127);
    expect(spawnMock).toHaveBeenCalledTimes(2); // exactly one retry, never a third call
  });
});
