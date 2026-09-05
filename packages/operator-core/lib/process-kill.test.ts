/**
 * process-kill.test.ts — the kind-allowlist guard on the ONLY operator path that
 * issues process.kill to host pids (processes:kill).
 *
 * The security contract: the target kind is re-classified from the live process
 * list (NOT trusted from the caller), only run.sh|omp|claude plus an exact Codex
 * argv[0] are killable, a protected kind / unknown pid is rejected WITHOUT
 * signaling, and a failed signal is reported (not swallowed). process.kill, the
 * process list, and the audit DB are all mocked — the test never signals a real
 * process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProcessesMock = vi.fn();
const probeProcessMock = vi.fn();
vi.mock('./dev-data', () => ({
  listProcesses: (...a: unknown[]) => listProcessesMock(...a),
  probeProcess: (...a: unknown[]) => probeProcessMock(...a),
}));
// Audit writes are best-effort + tangential — stub the DB to a no-op.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: vi.fn() } }),
}));

import { killProcess } from './process-kill';

function proc(pid: number, kind: string) {
  return { pid, kind, cmdline: `/bin/${kind} --serve`, cwd: '/x', harness_slug: 'h' };
}
function withProcs(...entries: ReturnType<typeof proc>[]) {
  listProcessesMock.mockResolvedValue({ processes: entries });
}
/** Default: the probed pid truly does not exist on the host. */
function withNoProbeHit() {
  probeProcessMock.mockResolvedValue({ exists: false, kind: 'other', cmdline: '' });
}
function withProbeHit(kind: string, cmdline = `/bin/${kind}`) {
  probeProcessMock.mockResolvedValue({ exists: true, kind, cmdline });
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  listProcessesMock.mockReset();
  probeProcessMock.mockReset();
  withNoProbeHit(); // default: probe finds nothing, unless a test overrides it
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

  it.each([
    ['claude', 'claude --output-format stream-json'],
    ['claude', '/home/builduser/.local/bin/claude --model opus'],
    ['codex', '/home/builduser/.local/bin/codex --model gpt-5.6-sol'],
  ] as const)('signals an exact %s CLI found by the raw PID probe', async (kind, cmdline) => {
    // dev:processes deliberately keeps its frozen six-kind inventory, so a
    // bare/unclassified CLI reaches this path as `other`. Exact argv[0]
    // classification makes the recovery instruction executable without
    // widening that read.
    withProcs(proc(1, 'run.sh'));
    withProbeHit('other', cmdline);
    const r = await killProcess({ pid: 82464, ...BASE });
    expect(r).toMatchObject({ ok: true, pid: 82464, kind, signal: 'SIGTERM' });
    expect(probeProcessMock).toHaveBeenCalledWith(82464);
    expect(killSpy).toHaveBeenCalledWith(82464, 'SIGTERM');
  });

  it.each(['claude', 'codex'])('does not treat a later argument mentioning %s as the CLI executable', async (kind) => {
    withProcs(proc(1, 'run.sh'));
    withProbeHit('other', `/usr/bin/node worker.mjs --backend ${kind}`);
    const r = await killProcess({ pid: 82465, ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 82465, kind: 'other', error: 'unsupported_kind' });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each(['next', 'paperclip', 'pty', 'other'])('refuses a protected kind (%s) WITHOUT signaling', async (kind) => {
    withProcs(proc(99, kind));
    const r = await killProcess({ pid: 99, ...BASE });
    expect(r).toMatchObject({ ok: false, error: 'protected_kind', kind });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('classifies kind from the live process list, not the caller — a protected pid is never killed', async () => {
    // Caller has no way to assert a kind; the target's kind comes from listProcesses.
    withProcs(proc(7, 'paperclip'));
    const r = await killProcess({ pid: 7, ...BASE });
    expect(r.error).toBe('protected_kind');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('rejects a pid that truly does not exist (absent from the list AND the raw /proc probe)', async () => {
    withProcs(proc(1, 'run.sh'));
    withNoProbeHit();
    const r = await killProcess({ pid: 4242, ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 4242, error: 'pid_not_found' });
    expect(probeProcessMock).toHaveBeenCalledWith(4242);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('EI-18698120633403217: a LIVE pid outside the six tracked kinds (e.g. vitest) is reported unsupported_kind, NOT pid_not_found — and is never signaled', async () => {
    // listProcesses() silently drops anything classified 'other' before the
    // caller sees it — so the pid is absent from the classified list even
    // though it is demonstrably alive. The raw /proc probe must catch this.
    withProcs(proc(1, 'run.sh'));
    withProbeHit('other', '/usr/bin/vitest run');
    const r = await killProcess({ pid: 5555, ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 5555, kind: 'other', error: 'unsupported_kind' });
    expect(r.detail).toContain('5555');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('WI-37516: the unsupported_kind refusal NAMES the durable-handle recovery path instead of dead-ending', async () => {
    // This refusal recurs in practice (43 audited rejections in the 60 days to
    // 2026-09-05, every one through the agent tool path) because the caller
    // reached for pid mode on a job that HAS a durable handle. Widening
    // KILLABLE is explicitly superseded (EI-20581852992216186 Fix #2), so the
    // remaining defect is that the message never says what to do instead: an
    // agent reads "this tool only manages those" and has nowhere to go.
    withProcs(proc(1, 'run.sh'));
    withProbeHit('other', '/usr/bin/node /repo/node_modules/.bin/vitest run');
    const r = await killProcess({ pid: 8123, ...BASE });

    expect(r).toMatchObject({ ok: false, pid: 8123, kind: 'other', error: 'unsupported_kind' });
    // The two durable handles that DO work, so the caller can act on the refusal.
    expect(r.detail).toContain('taskId');
    expect(r.detail).toContain('capability:bash_kill');
    // And it must not leave the caller thinking the process is gone.
    expect(r.detail).toMatch(/STILL RUNNING/i);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('keeps the canonical Hono host outside the bare-PID kill allowlist', async () => {
    // The desktop :3270 hono-host has a dedicated identity-guarded dev:restart
    // path. A raw PID must remain refused so an unrelated node host cannot be
    // signalled through the legacy agent-only address mode.
    withProcs(proc(1, 'run.sh'));
    withProbeHit('other', '/usr/bin/node --import tsx bin/hono-host.ts');
    const r = await killProcess({ pid: 327001, signal: 'SIGKILL', ...BASE });
    expect(r).toMatchObject({ ok: false, pid: 327001, kind: 'other', error: 'unsupported_kind' });
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
