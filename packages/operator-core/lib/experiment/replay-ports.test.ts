import { describe, expect, it, vi } from 'vitest';
import type { ReplayVariant } from '../replay/types';

type LlmOpts = { model: string; system?: string; messages: Array<{ role: string; content: string }>; maxTokens?: number };

const llmCallMock = vi.fn(async (_opts: LlmOpts) => ({ text: 'continuation', costUsd: 0, inputTokens: 1, outputTokens: 1 }));
vi.mock('../llm-testing/llm-client', () => ({ llmCall: (opts: LlmOpts) => llmCallMock(opts) }));

import { experimentReplayRunner } from './replay-ports';

const variant = (policy: ReplayVariant['policy']): ReplayVariant => ({ variantId: 'v', label: 'v', policy });
const input = (v: ReplayVariant) => ({
  systemPrompt: 's',
  contextText: 'c',
  replayCase: { kind: 'synthetic', caseId: 'c', context: '', intent: '' } as never,
  variant: v,
});

describe('experimentReplayRunner — model-per-arm (P-063)', () => {
  it('uses the variant policy.model when set', async () => {
    const runner = experimentReplayRunner('claude-sonnet-4-6');
    await runner(input(variant({ model: 'claude-opus-4-8' })));
    expect(llmCallMock.mock.calls.at(-1)![0].model).toBe('claude-opus-4-8');
  });

  it('falls back to the default model when the variant has none', async () => {
    const runner = experimentReplayRunner('claude-sonnet-4-6');
    await runner(input(variant({ systemOverlay: 'be terse' })));
    expect(llmCallMock.mock.calls.at(-1)![0].model).toBe('claude-sonnet-4-6');
  });

  it('forwards the live pricing adapter result unchanged into the replay handle', async () => {
    llmCallMock.mockResolvedValueOnce({ text: 'priced continuation', costUsd: 0.37, inputTokens: 321, outputTokens: 44 });
    const runner = experimentReplayRunner('claude-sonnet-4-6');
    await expect(runner(input(variant({ model: 'claude-opus-4-8' })))).resolves.toEqual({
      outputText: 'priced continuation',
      costUsd: 0.37,
      inputTokens: 321,
      outputTokens: 44,
      replayed: true,
    });
  });
});
