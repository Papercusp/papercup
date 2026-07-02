/**
 * llmCall error-path: the un-governed CLI path yields `{ type:'error',
 * message:'<backend> exited 1', stderr }` with NO classified turn — the thrown
 * LlmCallError must carry the stderr tail, not just the bare exit line
 * (a bare `claude-code exited 1` is undiagnosable; su-S11's first scored run
 * died exactly this opaquely, coord-system-e2e-testing-2026-06-10 P-011).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isLlmCallError } from '@papercusp/testing-shell/llm';

const events: unknown[] = [];

vi.mock('../../agent-chat-stream', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent-chat-stream')>();
  return {
    ...orig,
    runAgentChat: async function* () {
      yield* events as never[];
    },
  };
});

// These assertions pin the DEFAULT (no explicit-override) backend routing, which
// `backendForLlmCall` derives from `process.env.LLM_TEST_BACKEND` captured at
// llm-client module-init (the module-level `TEST_BACKEND` const). operator-core's
// vitest fork pool reuses a worker across test files, and several gym/ab-run CLI
// entry modules set `LLM_TEST_BACKEND='claude-code'` at module load — so whichever
// sibling file ran first could leak that value into this worker and flip
// `backendForLlmCall` to 'claude-code', reddening these pure routing tests
// ORDER-DEPENDENTLY (the operator-core "flaky gate" class; green-checkpoint
// 2026-07-02). Deleting the env BEFORE the first dynamic import makes llm-client
// capture a clean `TEST_BACKEND`. vitest isolates the module registry per file, so
// no `vi.resetModules()` is needed here — and it WOULD duplicate
// `@papercusp/testing-shell/llm`, breaking the `LlmCallError` class identity the
// subprocess tests below assert via `isLlmCallError` (instanceof).
let savedLlmTestBackend: string | undefined;
beforeAll(() => {
  savedLlmTestBackend = process.env.LLM_TEST_BACKEND;
  delete process.env.LLM_TEST_BACKEND;
});
afterAll(() => {
  if (savedLlmTestBackend === undefined) delete process.env.LLM_TEST_BACKEND;
  else process.env.LLM_TEST_BACKEND = savedLlmTestBackend;
});

describe('llmCall backend selection', () => {
  it('routes OpenAI-family model ids to Codex unless an explicit backend override is set', async () => {
    const { backendForLlmCall, modelForLlmCall } = await import('../llm-client');

    expect(backendForLlmCall('chatgpt:5.5')).toBe('codex');
    expect(backendForLlmCall('gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('openai-codex/gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('claude-sonnet-4-6')).toBe('anthropic-direct');
    expect(backendForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('anthropic-direct');

    expect(modelForLlmCall('chatgpt:5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('openai-codex/gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('gpt-5.5', 'codex')).toBe('gpt-5.5');
    expect(modelForLlmCall('chatgpt:5.5', 'anthropic-direct')).toBe('chatgpt:5.5');
  });

  it('uses the local Codex gateway for OpenAI-family stateless calls', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-5.5');
      expect(body.input).toBe('give json');
      expect(body.instructions).toBe('system');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(
        JSON.stringify({
          output_text: '{"ok":true}',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    const res = await llmCall({
      system: 'system',
      messages: [{ role: 'user', content: 'give json' }],
      model: 'chatgpt:5.5',
      maxTokens: 8,
      responseFormat: 'json',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer papercusp-gateway',
          'x-papercusp-priority': 'scout',
        }),
      }),
    );
    expect(res.text).toBe('{"ok":true}');
    expect(res.json).toEqual({ ok: true });
    expect(res.inputTokens).toBe(10);
    expect(res.outputTokens).toBe(4);
    expect(res.costUsd).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('makes the Codex JSON-mode input itself JSON-explicit even when only instructions mention JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toContain('JSON');
      expect(body.input).toBe('generate one idea\n\nRespond with valid json.');
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      return new Response(JSON.stringify({ output_text: '{"ok":true}' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { llmCall } = await import('../llm-client');

    await llmCall({
      system: 'Return JSON only.',
      messages: [{ role: 'user', content: 'generate one idea' }],
      model: 'chatgpt:5.5',
      responseFormat: 'json',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('llmCall subprocess error surfacing', () => {
  it('folds the stderr tail into the thrown LlmCallError message (un-governed path)', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'Error: some real diagnostic from the CLI\n  at spawn',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    expect((err as Error).message).toContain('claude-code exited 1');
    expect((err as Error).message).toContain('some real diagnostic from the CLI');
  });

  it('still classifies a rate-limit printed only to stderr', async () => {
    events.length = 0;
    events.push({
      type: 'error',
      message: 'claude-code exited 1',
      stderr: 'API Error: 429 rate limit exceeded, try again in 30 seconds',
    });
    const { llmCall } = await import('../llm-client');
    const err = await llmCall({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 8,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLlmCallError(err)).toBe(true);
    if (isLlmCallError(err)) expect(err.turn.class).toBe('rate_limited');
  });
});
