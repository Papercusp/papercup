/**
 * Unit tests for POST /api/adv/sessions/launch-pui — opens the `pui`
 * ratatui workbench (apps/tui) in an OS terminal via a server-side spawn.
 * spawn / fs / os are mocked so no terminal is actually opened. Covers:
 *   - happy path → resolves the cargo `pui` binary, spawns `pui workbench`,
 *     returns ok + terminal + pid;
 *   - `pui` not installed → 200 status:error code:pui_not_installed, no spawn;
 *   - no terminal emulator on PATH → 500 status:error, no spawn;
 *   - non-linux host → 501;
 *   - silent launch failure (EI-18696184925888288) → ok:true + a `warning`
 *     when the spawned process exits almost immediately.
 *
 * spawnInTerminal (terminal-spawn.ts) now does a short post-spawn liveness
 * re-check — fake timers drive it deterministically (advanced in `callPost`)
 * and `process.kill` is mocked alive-by-default so the pre-existing
 * assertions see the same shape as before.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const spawnMock = vi.fn(() => ({ unref: () => {}, pid: 4242 }));
const existsSyncMock = vi.fn((_p: string): boolean => true);
const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: spawnMock };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/x' };
});
// EI-19411366390626914: console-spawn.ts (imported transitively via
// terminal-spawn.ts) warms the task-manager's systemd-scope probe at module
// load (task-manager-no-escape-2026-07-27 P-009) — since WI-6844 (2026-08-02)
// the flag defaults ON, so that probe now genuinely fires a `spawn('systemd-run',
// …)` through this SAME mocked `spawn`, landing as an extra untracked call ahead
// of the real terminal spawn and breaking `spawnMock`'s call-count assertions.
// Neuter it exactly like orchestrator-runner-scope.test.ts does: the subject of
// this file is the terminal spawn, not the probe's own plumbing (that belongs to
// managed-spawn's own tests).
vi.mock('../../task-manager/managed-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/managed-spawn')>()),
  warmScopeProbe: () => {},
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

async function callPost(): Promise<Response> {
  const mod = await import('../routes/adv/launch-pui');
  const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-pui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const resPromise = route.handler(req, CTX);
  // Flush spawnInTerminal's post-spawn liveness-check delay (default 400ms,
  // EI-18696184925888288) if this call took the live-spawn path.
  await vi.advanceTimersByTimeAsync(500);
  return resPromise;
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  delete process.env.TERMINAL;
  // Default: the spawned pid stays alive past the liveness-check beat.
  killSpy.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launch-pui', () => {
  it('happy path: resolves the cargo pui binary, spawns `pui workbench`, returns ok + terminal + pid', async () => {
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.terminal).toBe('gnome-terminal');
    expect(json.pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const oneliner = lastOneliner();
    expect(oneliner).toContain('/home/x/.cargo/bin/pui');
    expect(oneliner).toContain('workbench');
  });

  it('pui not installed → 200 status:error code:pui_not_installed, no spawn', async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.code).toBe('pui_not_installed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no terminal emulator on PATH → 500 status:error, no spawn', async () => {
    // pui binary present (path ends in /pui) but no terminal emulator found.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/pui'));
    const res = await callPost();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/no terminal emulator/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('non-linux host → 501, no spawn', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const res = await callPost();
      expect(res.status).toBe(501);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  // EI-18696184925888288: the spawn syscall not throwing is not proof a
  // window actually opened — see terminal-spawn.ts's liveness re-check.
  it('silent launch failure: still ok:true, but adds a warning when the process exits almost immediately', async () => {
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const res = await callPost();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.terminal).toBe('gnome-terminal');
    expect(json.pid).toBe(4242);
    expect(typeof json.warning).toBe('string');
    expect(json.warning).toMatch(/exited almost immediately/);
  });

  it('the happy path (pid stays alive) carries no warning field', async () => {
    const res = await callPost();
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.warning).toBeUndefined();
  });
});
