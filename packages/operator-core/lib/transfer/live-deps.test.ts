import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ requests: [] as unknown[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: async (request: unknown) => {
        sdk.requests.push(request);
        return {
          content: [{ type: 'text', text: '[]' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        };
      },
    };
  },
}));

import { anthropicDistillerLlm } from './live-deps';

describe('anthropicDistillerLlm', () => {
  beforeEach(() => {
    sdk.requests.length = 0;
  });

  it('uses the supported max effort vocabulary for claude-opus-5', async () => {
    const llm = anthropicDistillerLlm({ apiKey: 'test-key' });

    await expect(llm({ system: 'system prompt', user: 'candidate', maxTokens: 128 })).resolves.toMatchObject({
      text: '[]',
    });

    expect(sdk.requests).toHaveLength(1);
    expect(sdk.requests[0]).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 128,
      output_config: { effort: 'max' },
      system: 'system prompt',
      messages: [{ role: 'user', content: 'candidate' }],
    });
  });
});
