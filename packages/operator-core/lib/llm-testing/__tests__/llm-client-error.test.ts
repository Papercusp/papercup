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
