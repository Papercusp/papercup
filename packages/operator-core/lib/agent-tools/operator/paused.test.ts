/**
 * paused.test.ts — operator:paused, the thin read-only wrapper over isPaused()
 * (paused.ts). __tests__/config.test.ts touches only the true case; this pins
 * both branches of the sentinel passthrough → {paused:<bool>}.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../device-operator-actions');
});

describe('operator:paused', () => {
  it('passes a TRUE sentinel through as {paused:true}', async () => {
    const isPaused = vi.fn(async () => true);
    vi.doMock('../../device-operator-actions', () => ({ isPaused }));
    const { default: tool } = await import('./paused');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ paused: true });
    expect(isPaused).toHaveBeenCalledTimes(1);
  });

  it('passes a FALSE sentinel through as {paused:false}', async () => {
    const isPaused = vi.fn(async () => false);
    vi.doMock('../../device-operator-actions', () => ({ isPaused }));
    const { default: tool } = await import('./paused');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ paused: false });
    expect(isPaused).toHaveBeenCalledTimes(1);
  });
});
