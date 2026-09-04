import { describe, expect, it } from 'vitest';
import {
  MAIN_THREAD_QUIET_DEFAULTS,
  waitForMainThreadQuiet,
  type MainThreadQuietRuntime,
} from './main-thread-quiet.js';

/** Drive the primitive with deterministic rAF deltas instead of a real clock. */
function fakeRuntime(deltas: number[]): MainThreadQuietRuntime {
  let now = 0;
  let index = 0;
  let requestId = 0;
  return {
    now: () => now,
    requestAnimationFrame: (callback) => {
      const delta = deltas[Math.min(index, deltas.length - 1)] ?? 16;
      index += 1;
      now += delta;
      queueMicrotask(callback);
      requestId += 1;
      return requestId;
    },
  };
}

describe('waitForMainThreadQuiet', () => {
  it('runs from its serialized source without module-scope lexical captures', async () => {
    const injected = globalThis.Function(
      `return (${waitForMainThreadQuiet.toString()})`,
    )() as typeof waitForMainThreadQuiet;
    const result = await injected(
      {},
      fakeRuntime(Array(MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames).fill(16)),
    );

    expect(result).toMatchObject({
      ok: true,
      framesObserved: MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames,
      consecutiveFrames: MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames,
      maxFrameMs: 16,
    });
  });

  it('passes after the default ten consecutive frames at the default budget', async () => {
    const result = await waitForMainThreadQuiet(
      {},
      fakeRuntime(Array(MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames).fill(16)),
    );

    expect(result).toMatchObject({
      ok: true,
      framesObserved: MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames,
      consecutiveFrames: MAIN_THREAD_QUIET_DEFAULTS.consecutiveFrames,
      maxFrameMs: 16,
    });
  });

  it('accepts a frame exactly on the quiet threshold', async () => {
    const result = await waitForMainThreadQuiet(
      { quietFrameMs: 20, consecutiveFrames: 3 },
      fakeRuntime([20, 20, 20]),
    );

    expect(result.ok).toBe(true);
    expect(result.maxFrameMs).toBe(20);
  });

  it('resets the quiet streak after a slow frame instead of hiding work', async () => {
    const result = await waitForMainThreadQuiet(
      { quietFrameMs: 20, consecutiveFrames: 3 },
      fakeRuntime([16, 16, 21, 16, 16, 16]),
    );

    expect(result.ok).toBe(true);
    expect(result.framesObserved).toBe(6);
    expect(result.maxFrameMs).toBe(21);
  });

  it('returns a bounded failure when the thread never reaches the quiet streak', async () => {
    const result = await waitForMainThreadQuiet(
      { quietFrameMs: 20, consecutiveFrames: 3, timeoutMs: 50 },
      fakeRuntime([21]),
    );

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(result.consecutiveFrames).toBe(0);
  });
});
