/**
 * live-integration.ts — pure-logic coverage (EI-52). No live host involved:
 * these pin isLiveTransient's classification and liveTest/probeLive's control
 * flow against synthetic errors/timers.
 */
import { describe, expect, it, vi } from 'vitest';
import { isLiveTransient, liveTest, probeLive } from './live-integration';

describe('isLiveTransient', () => {
  it('classifies AbortError / TimeoutError as transient', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isLiveTransient(abort)).toBe(true);

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isLiveTransient(timeout)).toBe(true);
  });

  it('classifies connection-refused/reset/hangup messages as transient', () => {
    expect(isLiveTransient(new Error('connect ECONNREFUSED 127.0.0.1:3070'))).toBe(true);
    expect(isLiveTransient(new Error('read ECONNRESET'))).toBe(true);
    expect(isLiveTransient(new Error('fetch failed'))).toBe(true);
    expect(isLiveTransient(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT classify a real assertion failure as transient', () => {
    expect(isLiveTransient(new Error('expected true to be false'))).toBe(false);
  });

  it('does NOT classify a non-Error throw as transient', () => {
    expect(isLiveTransient('plain string throw')).toBe(false);
    expect(isLiveTransient(undefined)).toBe(false);
  });
});

describe('liveTest', () => {
  it('runs the body and never calls skip on success', async () => {
    const skip = vi.fn();
    const wrapped = liveTest(async () => {
      /* passes */
    });
    await wrapped({ skip: skip as never });
    expect(skip).not.toHaveBeenCalled();
  });

  it('calls ctx.skip() (and swallows the error) on a live-transient failure', async () => {
    const skip = vi.fn();
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    const wrapped = liveTest(async () => {
      throw timeoutErr;
    });
    await expect(wrapped({ skip: skip as never })).resolves.toBeUndefined();
    expect(skip).toHaveBeenCalledTimes(1);
    expect(skip.mock.calls[0][0]).toMatch(/live host degraded mid-test/);
  });

  it('re-throws a non-transient failure (a real bug) instead of skipping', async () => {
    const skip = vi.fn();
    const wrapped = liveTest(async () => {
      throw new Error('expected 1 to be 2');
    });
    await expect(wrapped({ skip: skip as never })).rejects.toThrow('expected 1 to be 2');
    expect(skip).not.toHaveBeenCalled();
  });
});

describe('probeLive', () => {
  it('returns true when check() resolves true within the bound', async () => {
    const ok = await probeLive(async () => true, 50);
    expect(ok).toBe(true);
  });

  it('returns false when check() resolves false', async () => {
    const ok = await probeLive(async () => false, 50);
    expect(ok).toBe(false);
  });

  it('returns false when check() throws', async () => {
    const ok = await probeLive(async () => {
      throw new Error('ECONNREFUSED');
    }, 50);
    expect(ok).toBe(false);
  });

  it('returns false when check() hangs past the timeout (does not hang the caller)', async () => {
    const ok = await probeLive(
      () => new Promise<boolean>(() => {}), // never resolves
      30,
    );
    expect(ok).toBe(false);
  });
});
