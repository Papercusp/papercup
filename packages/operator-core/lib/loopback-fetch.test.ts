/**
 * loopback-fetch.test.ts — bounded ECONNREFUSED retry for in-process loopback
 * calls to the :3070 host (rides over the no-hot-reload restart window).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackFetch, isConnRefused } from './loopback-fetch';

const FAST = { backoffsMs: [1, 1, 1] };
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

afterEach(() => vi.restoreAllMocks());

describe('isConnRefused', () => {
  it('detects undici cause.code', () => {
    expect(isConnRefused(refused())).toBe(true);
  });
  it('detects the message form', () => {
    expect(isConnRefused(new Error('connect ECONNREFUSED 127.0.0.1:3070'))).toBe(true);
  });
  it('is false for other errors', () => {
    expect(isConnRefused(new Error('socket hang up'))).toBe(false);
  });
});

describe('loopbackFetch', () => {
  it('retries connection-refused then succeeds (rides over a restart)', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(ok);
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries when still refused (then the caller fails open)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(refused());
    await expect(loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST)).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does NOT retry a non-refused error (fails fast)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    await expect(loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST)).rejects.toThrow(/socket hang up/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-ok HTTP response (status is the caller’s to handle)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
