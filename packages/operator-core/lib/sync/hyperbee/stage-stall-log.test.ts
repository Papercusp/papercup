/**
 * stage-stall-log.test.ts — the shared named-hop pipeline observability
 * primitive (fleet-reliability-verification-2026-07-10 P-012), generalized
 * out of `outbox-drain.ts`'s WI-3619 fix. Pins: (1) silent on the healthy
 * path — a promise that settles before the threshold never logs; (2) a
 * still-pending promise past the threshold logs a named, grep-able line
 * naming BOTH the scope and the stage; (3) the wrapped promise's own
 * resolve/reject value is untouched either way (this is an observability
 * side-channel, never a timeout — a slow-but-eventually-successful await
 * still resolves normally after logging).
 */
import { describe, expect, it, vi } from 'vitest';
import { logIfStageStalls, STAGE_STALL_LOG_MS } from './stage-stall-log';

describe('logIfStageStalls — named-hop pipeline observability (P-012)', () => {
  it('a promise that settles BEFORE the threshold never logs', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = logIfStageStalls('scope-A', 'fast-stage', Promise.resolve('ok'));
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toBe('ok');
      // Advancing well past the threshold AFTER settle must not fire the timer
      // (it was cleared in the `finally`).
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1000);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a promise STILL PENDING past the threshold logs a line naming the scope + stage', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let resolveIt: (v: string) => void;
      const hung = new Promise<string>((res) => {
        resolveIt = res;
      });
      const p = logIfStageStalls('ws::harness-A', "merge-apply (features-by-id::k1)", hung);

      // Not yet at the threshold — silent.
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS - 1);
      expect(errSpy).not.toHaveBeenCalled();

      // Crosses the threshold — the named stall line fires exactly once.
      await vi.advanceTimersByTimeAsync(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toContain('ws::harness-A');
      expect(errSpy.mock.calls[0][0]).toContain('merge-apply (features-by-id::k1)');
      expect(errSpy.mock.calls[0][0]).toContain('STAGE STALL');

      // The wrapped promise still resolves normally once the underlying await
      // settles — this is observability only, never a forced timeout/reject.
      resolveIt!('finally landed');
      await expect(p).resolves.toBe('finally landed');
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a rejecting promise still rejects with its own error (stall-logging never swallows or replaces it)', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejectIt: (e: Error) => void;
      const hung = new Promise<string>((_, rej) => {
        rejectIt = rej;
      });
      const p = logIfStageStalls('ws::harness-B', 'hypercore-append (row id=1)', hung);
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1);
      expect(errSpy).toHaveBeenCalledTimes(1);

      rejectIt!(new Error('wedged connection'));
      await expect(p).rejects.toThrow('wedged connection');
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('respects an explicit thresholdMs override instead of the shared default', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hung = new Promise<void>(() => {});
      void logIfStageStalls('scope-C', 'custom-stage', hung, 5_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(errSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
