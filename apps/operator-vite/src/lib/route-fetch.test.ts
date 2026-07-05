/**
 * fetchWithTimeout — the route-loader fetch that can't hang forever (WI-2817).
 *
 *   node_modules/.bin/vitest run apps/operator-vite/src/lib/route-fetch.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './route-fetch';

const noopSleep = () => Promise.resolve();

/** A fetch stub that never responds but rejects when its attempt is aborted —
 *  models a wedged backend that accepts the socket and goes silent. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchWithTimeout', () => {
  it('returns the response on first success without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const res = await fetchWithTimeout('/api/x', { fetchImpl, sleep: noopSleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns a non-2xx response immediately — a real HTTP answer is never retried', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const res = await fetchWithTimeout('/api/x', { fetchImpl, sleep: noopSleep, retries: 3 });
    expect(res.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a 500 is an answer, not a hang
  });

  it('aborts a HUNG attempt after timeoutMs and rejects (retries:0)', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(hangingFetch());
    const p = fetchWithTimeout('/api/x', { timeoutMs: 4000, retries: 0, fetchImpl, sleep: noopSleep });
    p.catch(() => { /* avoid unhandled-rejection before we assert */ });
    await vi.advanceTimersByTimeAsync(4000);
    await expect(p).rejects.toBeInstanceOf(DOMException);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries after a timeout and returns a later success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(((_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_r, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
        );
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch);
    const p = fetchWithTimeout('/api/x', { timeoutMs: 1000, retries: 1, fetchImpl, sleep: noopSleep });
    await vi.advanceTimersByTimeAsync(1000); // fire attempt-1's timeout → abort → retry
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('exhausts the retry budget on a persistently hung backend and rejects', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(hangingFetch());
    const p = fetchWithTimeout('/api/x', { timeoutMs: 500, retries: 2, fetchImpl, sleep: noopSleep });
    p.catch(() => {});
    // Three attempts, each aborted after 500ms; no-op sleep between them.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).rejects.toBeInstanceOf(DOMException);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // first try + 2 retries
  });

  it('retries a NETWORK error (rejection) and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    });
    const res = await fetchWithTimeout('/api/x', { retries: 1, fetchImpl, sleep: noopSleep });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('propagates a CALLER abort immediately and never retries', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('ok', { status: 200 });
    });
    await expect(
      fetchWithTimeout('/api/x', { retries: 3, fetchImpl, sleep: noopSleep, init: { signal: ac.signal } }),
    ).rejects.toBeInstanceOf(DOMException);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // caller cancel is not a hang → no retry
  });
});
