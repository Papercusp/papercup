/**
 * withPgRetry / isRetriablePgConnectError — the bounded retry that absorbs a
 * transient postgres-js CONNECT_TIMEOUT for best-effort background DB ops (WI-2776).
 *
 *   npx vitest run lib/pg-transient-retry.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { isRetriablePgConnectError, withPgRetry } from './pg-transient-retry';

/** A postgres-js-shaped connect-timeout error (code is the reliable signal). */
function connectTimeout(): Error & { code: string } {
  const e = new Error('write CONNECT_TIMEOUT 127.0.0.1:6432') as Error & { code: string };
  e.code = 'CONNECT_TIMEOUT';
  return e;
}

/** A synchronous sleep stub — records the backoff schedule, never actually waits. */
function sleepSpy() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe('isRetriablePgConnectError', () => {
  it('matches CONNECT_TIMEOUT by code', () => {
    expect(isRetriablePgConnectError(connectTimeout())).toBe(true);
  });

  it('matches CONNECT_TIMEOUT by message when code is absent', () => {
    expect(isRetriablePgConnectError(new Error('write CONNECT_TIMEOUT 127.0.0.1:6432'))).toBe(true);
  });

  it('does NOT match CONNECTION_CLOSED — a query may have partially run, unsafe to retry', () => {
    const e = new Error('CONNECTION_CLOSED') as Error & { code: string };
    e.code = 'CONNECTION_CLOSED';
    expect(isRetriablePgConnectError(e)).toBe(false);
  });

  it('does NOT match the detached null-write TypeError (post-connect crash)', () => {
    expect(isRetriablePgConnectError(new TypeError("Cannot read properties of null (reading 'write')"))).toBe(false);
  });

  it('is null/undefined-safe and rejects unrelated errors', () => {
    expect(isRetriablePgConnectError(null)).toBe(false);
    expect(isRetriablePgConnectError(undefined)).toBe(false);
    expect(isRetriablePgConnectError(new Error('syntax error at or near "SELCT"'))).toBe(false);
  });
});

describe('withPgRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const { delays, sleep } = sleepSpy();
    const fn = vi.fn(async () => 'ok');
    await expect(withPgRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]); // no retry ⇒ no backoff
  });

  it('retries a transient CONNECT_TIMEOUT and succeeds on a later attempt', async () => {
    const { delays, sleep } = sleepSpy();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw connectTimeout();
      return 'drained';
    });
    await expect(withPgRetry(fn, { sleep, backoffMs: 100 })).resolves.toBe('drained');
    expect(fn).toHaveBeenCalledTimes(3);
    // Linear backoff: 100 * 1, then 100 * 2, before the 2nd and 3rd tries.
    expect(delays).toEqual([100, 200]);
  });

  it('exhausts the retry budget and rethrows the LAST transient error', async () => {
    const { delays, sleep } = sleepSpy();
    const fn = vi.fn(async () => { throw connectTimeout(); });
    await expect(withPgRetry(fn, { sleep, retries: 2 })).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(fn).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(delays).toHaveLength(2); // one backoff before each retry
  });

  it('rethrows a NON-transient error immediately without retrying', async () => {
    const { delays, sleep } = sleepSpy();
    const boom = new Error('relation "x" does not exist');
    const fn = vi.fn(async () => { throw boom; });
    await expect(withPgRetry(fn, { sleep })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1); // no retry on a non-connect error
    expect(delays).toEqual([]);
  });

  it('fires the onRetry hook with 1-based attempt numbers', async () => {
    const { sleep } = sleepSpy();
    const seen: number[] = [];
    let calls = 0;
    const fn = async () => { calls += 1; if (calls < 3) throw connectTimeout(); return 1; };
    await withPgRetry(fn, { sleep, onRetry: (attempt) => seen.push(attempt) });
    expect(seen).toEqual([1, 2]);
  });

  it('honors a custom classifier (e.g. a read-only site widening to CONNECTION_CLOSED)', async () => {
    const { sleep } = sleepSpy();
    const closed = Object.assign(new Error('CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
    let calls = 0;
    const fn = async () => { calls += 1; if (calls < 2) throw closed; return 'read'; };
    // Default classifier would NOT retry CONNECTION_CLOSED; a custom one opts in.
    await expect(
      withPgRetry(fn, { sleep, classifier: (e) => (e as { code?: string }).code === 'CONNECTION_CLOSED' }),
    ).resolves.toBe('read');
    expect(calls).toBe(2);
  });
});
