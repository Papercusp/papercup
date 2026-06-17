import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOpenAiEmbedder } from './configure';

// The OpenAI embedder used to throw on the FIRST non-OK response with no retry,
// so a burst of memory writes (learning-pack seeding fires items in concurrent
// batches) failed wholesale the instant OpenAI rate-limited or hiccupped —
// surfacing to the user as "N write(s) failed". These pin the resilience: a
// TRANSIENT error (429 / 5xx / network) retries with backoff; a NON-retryable
// client error (401 bad key) fails fast (retrying a bad key is pointless).

afterEach(() => vi.restoreAllMocks());

const okEmbed = (v: number[]) => new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200 });

describe('buildOpenAiEmbedder — transient-failure resilience', () => {
  it('retries a 429 rate-limit then succeeds (the seeding-burst case)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okEmbed([0.1, 0.2, 0.3]));
    vi.stubGlobal('fetch', fetchMock);
    const v = await buildOpenAiEmbedder('sk-test')('hello');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 failed (429) + 1 success
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(okEmbed([1]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk')('x')).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network/fetch error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(okEmbed([9]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk')('x')).toEqual([9]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails FAST on a 401 (bad/expired key) — exactly one attempt, no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk-bad')('x')).rejects.toThrow(/openai_embed_failed_401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on a persistent transient error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('still rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk')('x')).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });
});
