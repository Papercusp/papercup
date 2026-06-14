/**
 * loopback-fetch.test.ts — bounded retry for transient network errors in in-process loopback
 * calls to the :3070 host (rides over the no-hot-reload restart window and network hiccups).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackFetch, isConnRefused, isTransientNetworkError, describeFetchError, readJsonBody } from './loopback-fetch';

const FAST = { backoffsMs: [1, 1, 1] };
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const connReset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const notFound = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
const timedOut = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
// undici codes surfaced when the operator closes the connection mid-request (deploy restart) — EI-390.
const socketClosed = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } });
const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' } });

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
  it('detects undici UND_ERR_SOCKET "other side closed" via cause.code (EI-390: restart mid-request)', () => {
    expect(isTransientNetworkError(socketClosed())).toBe(true);
  });
  it('detects undici UND_ERR_CONNECT_TIMEOUT via cause.code (EI-390)', () => {
    expect(isTransientNetworkError(connectTimeout())).toBe(true);
  });
  it('falls through to the message heuristic on an unknown cause code (EI-390)', () => {
    const transient = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3070'), { cause: { code: 'UND_ERR_WHATEVER' } });
    expect(isTransientNetworkError(transient)).toBe(true);
    const nonTransient = Object.assign(new Error('bad argument'), { cause: { code: 'UND_ERR_INVALID_ARG' } });
    expect(isTransientNetworkError(nonTransient)).toBe(false);
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

  it('retries undici UND_ERR_SOCKET "other side closed" and succeeds (EI-390: operator restart mid-request)', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(socketClosed())
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

describe('describeFetchError (EI-390: self-diagnosing persisted failures)', () => {
  it('appends the undici cause code + detail so "fetch failed" is no longer blind', () => {
    expect(describeFetchError(socketClosed())).toBe('fetch failed (UND_ERR_SOCKET: other side closed)');
  });
  it('still contains "fetch failed" so classifySpawnError keeps classifying it network', () => {
    expect(describeFetchError(socketClosed())).toMatch(/fetch failed/);
  });
  it('returns the bare message when there is no cause code', () => {
    expect(describeFetchError(new Error('socket hang up'))).toBe('socket hang up');
  });
  it('does not double-append when the message already names the code', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3070'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeFetchError(err)).toBe('connect ECONNREFUSED 127.0.0.1:3070');
  });
  it('handles a non-Error value', () => {
    expect(describeFetchError('weird')).toBe('weird');
  });
});

describe('readJsonBody (EI-20: attributable JSON parse, no frame-less fatal exit)', () => {
  it('parses a well-formed JSON body', async () => {
    const res = new Response(JSON.stringify({ projects: [{ slug: 'a' }] }), { status: 200 });
    await expect(readJsonBody(res)).resolves.toEqual({ projects: [{ slug: 'a' }] });
  });

  it('rethrows an ATTRIBUTABLE error on an EMPTY body (the EI-20 crash shape)', async () => {
    // A 200 with a zero-byte body — host restarting mid-stream. A bare
    // `res.json()` here rejects with frame-less `Unexpected end of JSON input`.
    const res = new Response('', { status: 200 });
    await expect(readJsonBody(res, 'http://127.0.0.1:3070/api/harness/projects')).rejects.toThrow(
      /JSON parse failed for http:\/\/127\.0\.0\.1:3070\/api\/harness\/projects.*0 byte body.*empty body/,
    );
  });

  it('names the URL + status + byte length on a TRUNCATED body', async () => {
    const res = new Response('{"projects":[{"slug', { status: 200 });
    let caught: Error | undefined;
    try {
      await readJsonBody(res, 'http://127.0.0.1:3070/api/harness/projects');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/http:\/\/127\.0\.0\.1:3070\/api\/harness\/projects/);
    expect(caught!.message).toMatch(/HTTP 200/);
    expect(caught!.message).toMatch(/19 byte body/);
    // The original SyntaxError is preserved as the cause for any downstream classifier.
    expect((caught!.cause as Error) instanceof SyntaxError).toBe(true);
  });

  it('falls back to res.url when no explicit context is given', async () => {
    const res = new Response('', { status: 502 });
    Object.defineProperty(res, 'url', { value: 'http://127.0.0.1:3070/api/agents', configurable: true });
    await expect(readJsonBody(res)).rejects.toThrow(/http:\/\/127\.0\.0\.1:3070\/api\/agents/);
  });
});
