/**
 * EI-19310953148940030 — memory and rerank are independently borrowable, so
 * neither may depend on the other just to share this small sidecar policy.
 * Until a third client justifies extracting a package, keep the duplicated
 * contract mechanically aligned here in their existing common consumer.
 */
import {
  DEFAULT_SIDECAR_MAX_ATTEMPTS as EMBED_MAX_ATTEMPTS,
  DEFAULT_SIDECAR_TIMEOUT_MS as EMBED_TIMEOUT_MS,
  SIDECAR_MAX_TEXT_CHARS as EMBED_MAX_TEXT_CHARS,
  SidecarEmbedHttpError,
  buildSidecarFirstEmbedder,
  isNonRetryableSidecarError as isEmbedNonRetryable,
} from '@papercusp/memory';
import {
  DEFAULT_SIDECAR_MAX_ATTEMPTS as RERANK_MAX_ATTEMPTS,
  DEFAULT_SIDECAR_TIMEOUT_MS as RERANK_TIMEOUT_MS,
  SIDECAR_MAX_TEXT_CHARS as RERANK_MAX_TEXT_CHARS,
  SidecarRerankHttpError,
  buildSidecarFirstReranker,
  isNonRetryableSidecarError as isRerankNonRetryable,
} from '@papercusp/rerank';
import { describe, expect, it } from 'vitest';

const responseFetch = (status: number, calls: { count: number }): typeof fetch =>
  (async () => {
    calls.count += 1;
    return new Response('sidecar test response', { status });
  }) as typeof fetch;

describe('memory/rerank sidecar policy stays aligned', () => {
  it('shares the retry, total-budget, and payload ceilings', () => {
    expect({
      maxAttempts: EMBED_MAX_ATTEMPTS,
      timeoutMs: EMBED_TIMEOUT_MS,
      maxTextChars: EMBED_MAX_TEXT_CHARS,
    }).toEqual({
      maxAttempts: RERANK_MAX_ATTEMPTS,
      timeoutMs: RERANK_TIMEOUT_MS,
      maxTextChars: RERANK_MAX_TEXT_CHARS,
    });
  });

  it.each([
    [400, true],
    [404, true],
    [429, true],
    [500, false],
    [503, false],
  ])('classifies HTTP %i identically (non-retryable=%s)', (status, expected) => {
    expect(isEmbedNonRetryable(new SidecarEmbedHttpError(status, 'test'))).toBe(expected);
    expect(isRerankNonRetryable(new SidecarRerankHttpError(status, 'test'))).toBe(expected);
  });

  it('keeps deterministic 4xx terminal and distinct from downtime in both clients', async () => {
    const embedCalls = { count: 0 };
    const rerankCalls = { count: 0 };
    const embedTransitions: string[] = [];
    const rerankTransitions: string[] = [];

    const embed = buildSidecarFirstEmbedder({
      url: 'http://sidecar.test',
      model: 'embed-test',
      kind: 'query',
      fallback: async () => async () => [0],
      fetchFn: responseFetch(400, embedCalls),
      onTransition: (state) => embedTransitions.push(state),
    });
    const rerank = buildSidecarFirstReranker({
      url: 'http://sidecar.test',
      model: 'rerank-test',
      fetchFn: responseFetch(400, rerankCalls),
      onTransition: (state) => rerankTransitions.push(state),
    });

    await expect(embed('text')).rejects.toThrow(/sidecar_rejected_request/);
    await expect(rerank('query', ['text'])).rejects.toThrow(/sidecar_rejected_request/);
    expect(embedCalls.count).toBe(1);
    expect(rerankCalls.count).toBe(1);
    expect(embedTransitions).toEqual(['rejected']);
    expect(rerankTransitions).toEqual(['rejected']);
  });

  it('keeps retryable failures bounded and terminally unavailable in both clients', async () => {
    const embedCalls = { count: 0 };
    const rerankCalls = { count: 0 };
    const embedTransitions: string[] = [];
    const rerankTransitions: string[] = [];
    const noWait = async (): Promise<void> => undefined;

    const embed = buildSidecarFirstEmbedder({
      url: 'http://sidecar.test',
      model: 'embed-test',
      kind: 'query',
      fallback: async () => async () => [0],
      fetchFn: responseFetch(503, embedCalls),
      sleepFn: noWait,
      onTransition: (state) => embedTransitions.push(state),
    });
    const rerank = buildSidecarFirstReranker({
      url: 'http://sidecar.test',
      model: 'rerank-test',
      fetchFn: responseFetch(503, rerankCalls),
      sleepFn: noWait,
      onTransition: (state) => rerankTransitions.push(state),
    });

    await expect(embed('text')).rejects.toThrow(/sidecar_required_unavailable/);
    await expect(rerank('query', ['text'])).rejects.toThrow(/sidecar_required_unavailable/);
    expect(embedCalls.count).toBe(EMBED_MAX_ATTEMPTS);
    expect(rerankCalls.count).toBe(RERANK_MAX_ATTEMPTS);
    expect(embedTransitions).toEqual(['down']);
    expect(rerankTransitions).toEqual(['down']);
  });
});
