import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOpenAiEmbedder,
  EMBED_MAX_ATTEMPTS,
  parseOpenAiDurationMs,
  retryDelayFromHeaders,
  nextEmbedBackoffMs,
} from './configure';

// The OpenAI embedder used to throw on the FIRST non-OK response with no retry,
// so a burst of memory writes (learning-pack seeding fires items in concurrent
// batches) failed wholesale the instant OpenAI rate-limited or hiccupped —
// surfacing to the user as "N write(s) failed". A sustained org-wide TPM 429
// (text-embedding-3-small, 1M TPM) then hard-failed memory:remember/search
// FLEET-WIDE on 2026-06-17. These pin the resilience: a TRANSIENT error
// (429 / 5xx / network) retries with HEADER-AWARE jittered backoff on the SAME
// embedder (no fallback); a NON-retryable client error (401 bad key) fails fast.
// (watchdog-embed-resilience-and-dedup-2026-06-17 P-001.)

afterEach(() => vi.restoreAllMocks());

const okEmbed = (v: number[]) => new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200 });
const noSleep = async () => {}; // assert attempt counts without real delays

describe('buildOpenAiEmbedder — transient-failure resilience', () => {
  it('retries a 429 rate-limit then succeeds (the seeding-burst case)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okEmbed([0.1, 0.2, 0.3]));
    vi.stubGlobal('fetch', fetchMock);
    const v = await buildOpenAiEmbedder('sk-test', { sleep: noSleep })('hello');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 failed (429) + 1 success
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(okEmbed([1]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network/fetch error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(okEmbed([9]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).toEqual([9]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails FAST on a 401 (bad/expired key) — exactly one attempt, no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk-bad', { sleep: noSleep })('x')).rejects.toThrow(/openai_embed_failed_401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rides out a SUSTAINED 429 across the full attempt budget before giving up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('still rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock).toHaveBeenCalledTimes(EMBED_MAX_ATTEMPTS); // 1 + (EMBED_MAX_ATTEMPTS-1) retries
  });

  it('honors the server Retry-After hint for the backoff wait', async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(okEmbed([7]));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = async (ms: number) => { waits.push(ms); };
    const v = await buildOpenAiEmbedder('sk', { sleep, rand: () => 0 })('x');
    expect(v).toEqual([7]);
    expect(waits[0]).toBeGreaterThanOrEqual(2000); // Retry-After: 2s honored (rand:0 → no extra jitter)
  });

  it('stops retrying once the total-wait budget is spent (never blocks forever)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rl', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    // baseMs 200 > budget 100 → first wait clamps to 100, the next backoff returns null → stop.
    await expect(
      buildOpenAiEmbedder('sk', { sleep: noSleep, maxTotalWaitMs: 100, baseMs: 200, rand: () => 1 })('x'),
    ).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock.mock.calls.length).toBeLessThan(EMBED_MAX_ATTEMPTS);
  });
});

describe('parseOpenAiDurationMs', () => {
  it('parses bare seconds, compact durations, and rejects junk', () => {
    expect(parseOpenAiDurationMs('2')).toBe(2000);
    expect(parseOpenAiDurationMs('1.5s')).toBe(1500);
    expect(parseOpenAiDurationMs('6ms')).toBe(6);
    expect(parseOpenAiDurationMs('2m59.56s')).toBe(2 * 60_000 + Math.round(59.56 * 1000));
    expect(parseOpenAiDurationMs('')).toBeNull();
    expect(parseOpenAiDurationMs(null)).toBeNull();
    expect(parseOpenAiDurationMs('soon')).toBeNull();
  });
});

describe('retryDelayFromHeaders', () => {
  it('prefers Retry-After, then x-ratelimit-reset-tokens, else null', () => {
    expect(retryDelayFromHeaders(new Headers({ 'retry-after': '3' }))).toBe(3000);
    expect(retryDelayFromHeaders(new Headers({ 'x-ratelimit-reset-tokens': '1.2s' }))).toBe(1200);
    expect(retryDelayFromHeaders(new Headers())).toBeNull();
  });
});

describe('nextEmbedBackoffMs', () => {
  it('returns null when the total-wait budget is spent', () => {
    expect(nextEmbedBackoffMs(0, null, 30_000, { maxTotalWaitMs: 30_000 })).toBeNull();
  });
  it('clamps the wait to the remaining budget', () => {
    const w = nextEmbedBackoffMs(5, null, 29_500, { maxTotalWaitMs: 30_000, rand: () => 1 });
    expect(w).toBeLessThanOrEqual(500);
    expect(w).toBeGreaterThan(0);
  });
  it('honors a server hint over exponential backoff', () => {
    expect(nextEmbedBackoffMs(0, 2000, 0, { rand: () => 0 })).toBe(2000);
  });

  it('widens reset-moment jitter so clients on the SAME reset window do not re-fire in sync (anti-herd)', () => {
    // Two clients both told "reset in 5s" get DIFFERENT waits — spread across the jitter
    // window — so they don't all hammer OpenAI at the exact reset boundary.
    const a = nextEmbedBackoffMs(0, 5000, 0, { rand: () => 0 });
    const b = nextEmbedBackoffMs(0, 5000, 0, { rand: () => 0.99 });
    expect(a).toBe(5000); // reset honored exactly when jitter draws 0
    expect(b).toBeGreaterThan(6000); // a different client is jittered later
    expect((b as number) - (a as number)).toBeGreaterThan(1000); // spread > 1s across the herd
  });
});
