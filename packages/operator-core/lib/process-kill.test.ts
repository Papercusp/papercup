/**
 * process-kill.test.ts — the kind-allowlist guard on the ONLY operator path that
 * issues process.kill to host pids (processes:kill).
 *
 * The security contract: the target kind is re-classified from the live process
 * list (NOT trusted from the caller), only run.sh|omp|claude are killable, a
 * protected kind / unknown pid is rejected WITHOUT signaling, and a failed
 * signal is reported (not swallowed). process.kill, the process list, and the
 * audit DB are all mocked — the test never signals a real process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProcessesMock = vi.fn();
vi.mock('./dev-data', () => ({ listProcesses: (...a: unknown[]) => listProcessesMock(...a) }));
// Audit writes are best-effort + tangential — stub the DB to a no-op.
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { unsafe: vi.fn() } }) }));

import { killProcess } from './process-kill';

function proc(pid: number, kind: string) {
  return { pid, kind, cmdline: `/bin/${kind} --serve`, cwd: '/x', harness_slug: 'h' };
}
function withProcs(...entries: ReturnType<typeof proc>[]) {
  listProcessesMock.mockResolvedValue({ processes: entries });
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  listProcessesMock.mockReset();
  // CRITICAL: mock process.kill so the test never signals a real pid.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  killSpy.mockRestore();
});

const BASE = { actorSlug: 'op', workspaceId: 'ws' };

describe('killProcess — kind allowlist', () => {
  it('signals a killable kind (run.sh) with SIGTERM by default', async () => {
    withProcs(proc(1234, 'run.sh'));
    const r = await killProcess({ pid: 1234, ...BASE });
    expect(r).toMatchObject({ ok: true, pid: 1234, kind: 'run.sh', signal: 'SIGTERM' });
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('passes an explicit SIGKILL through', async () => {
    withProcs(proc(22, 'omp'));
    const r = await killProcess({ pid: 22, signal: 'SIGKILL', ...BASE });
    expect(r.ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(22, 'SIGKILL');
  });

  it.each(['next', 'paperclip', 'pty', 'other'])(
    'refuses a protected kind (%s) WITHOUT signaling',
    async (kind) => {
      withProcs(proc(99, kind));
      const r = await killProcess({ pid: 99, ...BASE });
      expect(r).toMatchObject({ ok: false, error: 'protected_kind', kind });
      expect(killSpy).not.toHaveBeenCalled();
    },
  );

  it('classifies kind from the live process list, not the caller — a protected pid is never killed', async () => {
    // Caller has no way to assert a kind; the target's kind comes from listProcesses.
    withProcs(proc(7, 'paperclip'));
    const r = await killProcess({ pid: 7, ...BASE });
    expect(r.error).toBe('protected_kind');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown pid (not in the live list) without signaling', async () => {
    withProcs(proc(1, 'run.sh'));
    const r = await killProcess({ pid: 4242, ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 4242, error: 'pid_not_found' });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('reports signal_failed (with detail) when process.kill throws — does not swallow it', async () => {
    withProcs(proc(55, 'claude'));
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const r = await killProcess({ pid: 55, ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 55, kind: 'claude', error: 'signal_failed' });
    expect(r.detail).toContain('ESRCH');
  });
});
