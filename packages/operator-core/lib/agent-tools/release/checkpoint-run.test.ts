/**
 * release:checkpoint-run — the manual GATE-run verb (WI-1320 follow-up). Mocks the detached
 * launch primitive so the handler's role-gate + reply shape are asserted without firing a suite.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/checkpoint-run.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (role = 'operator') =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role } as never);

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../../release-checkpoint-launch'));

describe('release:checkpoint-run', () => {
  it('launches the detached checkpoint and reports it (operator role)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
    }));
    vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

    const { default: tool } = await import('./checkpoint-run');
    const result = await tool.handler({}, MAKE_CTX());

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(parse(result as never)).toMatchObject({ ok: true, launched: true, unit: 'papercup-green-checkpoint-manual' });
  });

  it('reports ok:false with the reason when the launch is refused', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      reason: 'systemd-run exited 1 (a manual checkpoint may already be running)',
    }));
    vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(false);
    expect(String(b.note)).toMatch(/already running|not launched/i);
  });

  // EI-7426: firing the green verdict is verification-only + self-locked, and the persona tells
  // ANY red-fixing agent to fire it ("fix the reds → release:checkpoint-run → release:deploy").
  // It used to copy checkpoint-config's operator-config-write gate (correct there — it mutates
  // config; wrong here — this mutates nothing), so pipeline roles that greened the reds hit a
  // recurring structural tool-error. There is now no in-handler role gate; the invoke allowlist
  // (SU_ROLES + bee/release-fixer/release-manager) is the access control.
  it.each(['worker', 'debugger', 'bee', 'release-fixer'])(
    'fires the verdict for a non-operator red-fixing role (%s) — no operator-config-write gate (EI-7426)',
    async (role) => {
      const launchSpy = vi.fn(async () => ({
        launched: true,
        unit: 'papercup-green-checkpoint-manual',
        argv: [],
        logPath: '/tmp/papercup-green-checkpoint-manual.log',
      }));
      vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

      const { default: tool } = await import('./checkpoint-run');
      const b = parse((await tool.handler({}, MAKE_CTX(role))) as never);

      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(b).toMatchObject({ ok: true, launched: true });
    },
  );

  it('advertises the invoke allowlist to the red-fix cohort (mirrors release:deploy safe ops)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    const roles = (tool as { agentRoles?: readonly string[] }).agentRoles ?? [];
    // The specific pipeline roles the watchdog observed hitting the structural error, plus the
    // wider red-fix cohort, must be invoke-allowed (EI-7426).
    for (const r of ['worker', 'scoper', 'validator', 'reviewer', 'debugger', 'bee', 'release-fixer', 'release-manager']) {
      expect(roles).toContain(r);
    }
  });

  // WI-1562: the refuse-when-active path returns a STRUCTURED already_running reply instead of
  // a bare reason string, so a concurrent caller can tell "wait for it" from "try again".
  it('reports a structured already_running reply when a run is already active (WI-1562)', async () => {
    const launchSpy = vi.fn(async (opts: { force?: boolean }) => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: '2026-07-02T10:44:43Z',
        eta_sec: 2100,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).toHaveBeenCalledWith({ force: undefined });
    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
      current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      candidate_stale: true,
      quiet_cut_sec: 240,
      started_at: '2026-07-02T10:44:43Z',
      eta_sec: 2100,
    });
    expect(String(b.note)).toMatch(/older candidate|force:true/i);
  });

  it('passes force:true through to the launch primitive', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
    }));
    vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

    const { default: tool } = await import('./checkpoint-run');
    await tool.handler({ force: true }, MAKE_CTX());

    expect(launchSpy).toHaveBeenCalledWith({ force: true });
  });
});
