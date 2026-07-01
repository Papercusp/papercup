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
});
