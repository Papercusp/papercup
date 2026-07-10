/** WI-3940: the wake resume leg's rematerialize-on-miss PG calls must be
 *  TIME-BOUNDED. They were fail-soft on rejection, but a WEDGED PG connection
 *  (the WI-2009 hung-await class) hangs past every try/catch and stalls the
 *  whole wake pipeline — the exact defect that wedged the green gate on
 *  2026-07-10 (11 tests × 180s) when the seams ran un-stubbed. withWakeTimeout
 *  is the guarantee; every resume-leg call site threads through it. */
import { describe, expect, it, vi } from 'vitest';
import { REMATERIALIZE_TIMEOUT_MS, withWakeTimeout } from './wake-executor';

describe('withWakeTimeout (WI-3940 wake hot-path bound)', () => {
  it('resolves the value when the promise settles in time', async () => {
    await expect(withWakeTimeout(Promise.resolve({ ok: true }), 'fast', 1_000)).resolves.toEqual({ ok: true });
  });

  it('resolves null on a NEVER-SETTLING promise after the bound — the hang class', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hung = new Promise<never>(() => {
        /* a wedged PG read: never settles, never rejects */
      });
      const t0 = performance.now();
      await expect(withWakeTimeout(hung, 'wedged-pg', 50)).resolves.toBeNull();
      expect(performance.now() - t0).toBeLessThan(2_000); // bounded, not the suite timeout
      expect(warn.mock.calls.some((c) => String(c[0]).includes('timed out after 50ms'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves null (never throws) on rejection — subsumes the old .catch(() => null)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(withWakeTimeout(Promise.reject(new Error('pg down')), 'rejecting', 1_000)).resolves.toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('pg down'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a late settle after the timeout is ignored (no double-resolve, no unhandled rejection)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let lateReject: ((e: Error) => void) | null = null;
      const late = new Promise<never>((_res, rej) => {
        lateReject = rej;
      });
      const r = await withWakeTimeout(late, 'late-settler', 30);
      expect(r).toBeNull();
      // The abandoned promise settling later must be inert.
      lateReject!(new Error('too late'));
      await new Promise((res) => setTimeout(res, 20));
    } finally {
      warn.mockRestore();
    }
  });

  it('the default bound is generous but finite', () => {
    expect(REMATERIALIZE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(REMATERIALIZE_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
