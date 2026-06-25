/**
 * llmCall error-path: the un-governed CLI path yields `{ type:'error',
 * message:'<backend> exited 1', stderr }` with NO classified turn — the thrown
 * LlmCallError must carry the stderr tail, not just the bare exit line
 * (a bare `claude-code exited 1` is undiagnosable; su-S11's first scored run
 * died exactly this opaquely, coord-system-e2e-testing-2026-06-10 P-011).
 */
import { describe, expect, it, vi } from 'vitest';

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
