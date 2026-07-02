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

  it('rejects a non-operator role (no launch)', async () => {
    const launchSpy = vi.fn();
    vi.doMock('../../release-checkpoint-launch', () => ({ launchDetachedCheckpoint: launchSpy }));

    const { default: tool } = await import('./checkpoint-run');
    await expect(tool.handler({}, MAKE_CTX('bee'))).rejects.toThrow(/operator, architect, or queen/);
    expect(launchSpy).not.toHaveBeenCalled();
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
      started_at: '2026-07-02T10:44:43Z',
      eta_sec: 2100,
    });
    expect(String(b.note)).toMatch(/already in flight|force:true/i);
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
