/**
 * loopback-fetch.test.ts — bounded retry for transient network errors in in-process loopback
 * calls to the :3070 host (rides over the no-hot-reload restart window and network hiccups).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackFetch, isConnRefused, isTransientNetworkError } from './loopback-fetch';

const FAST = { backoffsMs: [1, 1, 1] };
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const connReset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const notFound = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
const timedOut = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });

afterEach(() => vi.restoreAllMocks());

describe('isTransientNetworkError', () => {
  it('detects ECONNREFUSED via cause.code', () => {
    expect(isTransientNetworkError(refused())).toBe(true);
  });
  it('detects ECONNRESET via cause.code (EI-390)', () => {
    expect(isTransientNetworkError(connReset())).toBe(true);
  });
  it('detects ENOTFOUND via cause.code (DNS failures, EI-390)', () => {
    expect(isTransientNetworkError(notFound())).toBe(true);
  });
  it('detects ETIMEDOUT via cause.code (timeout, EI-390)', () => {
    expect(isTransientNetworkError(timedOut())).toBe(true);
  });
  it('detects ECONNREFUSED message form', () => {
    expect(isTransientNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:3070'))).toBe(true);
  });
  it('detects "Connection reset" message', () => {
    expect(isTransientNetworkError(new Error('Connection reset by peer'))).toBe(true);
  });
  it('detects "timeout" message', () => {
    expect(isTransientNetworkError(new Error('request timeout'))).toBe(true);
  });
  it('is false for non-transient errors', () => {
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(false);
  });
  it('is false for non-network errors', () => {
    expect(isTransientNetworkError(new Error('JSON parse error'))).toBe(false);
  });
});

describe('isConnRefused (deprecated)', () => {
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

  it('retries connection-reset and succeeds (EI-390: transient network error)', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connReset())
      .mockResolvedValueOnce(ok);
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries DNS failure (ENOTFOUND) and succeeds (EI-390)', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(ok);
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries timeout and succeeds (EI-390)', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce(ok);
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries when still refused (then the caller fails open)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(refused());
    await expect(loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST)).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does NOT retry a non-transient error (fails fast)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    await expect(loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST)).rejects.toThrow(/socket hang up/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-ok HTTP response (status is the caller\'s to handle)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await loopbackFetch('http://127.0.0.1:3070/x', undefined, FAST);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
