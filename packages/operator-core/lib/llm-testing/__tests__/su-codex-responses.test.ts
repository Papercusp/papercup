import { describe, expect, it, vi } from 'vitest';

import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import { buildCatalog } from '../targets/su-catalog';
import { SuTarget } from '../targets/su';

type OutputDelivery = 'snapshot' | 'streamed-only' | 'both';

const anthropicMock = vi.hoisted(() => ({ responses: [] as unknown[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(async () => {
        const response = anthropicMock.responses.shift();
        if (!response) throw new Error('unexpected Anthropic call');
        return response;
      }),
    };
  },
}));

function completed(output: unknown[], delivery: OutputDelivery): Response {
  const events: unknown[] = delivery === 'snapshot' ? [] : output.map((item, output_index) => ({
    type: 'response.output_item.done', output_index, item,
  }));
  events.push({
    type: 'response.completed',
    response: {
      output: delivery === 'streamed-only' ? [] : output,
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  });
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('SuTarget Codex Responses tool loop', () => {
  it.each<OutputDelivery>(['snapshot', 'streamed-only', 'both'])('replays reasoning, functions, and text exactly once with %s output', async (delivery) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return completed([
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'docs__get',
            arguments: JSON.stringify({ slugs: ['x'], harness: 'all' }),
          },
        ], delivery);
      }
      return completed([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done from Sol.' }],
        },
      ], delivery);
    });
    const dispatchOutput = JSON.stringify({ ok: true, results: [{ slug: 'x' }] });
    const dispatch = vi.fn(async () => ({ content: [{ text: dispatchOutput }] }));
    const target = new SuTarget({
      catalog: buildCatalog([
        {
          name: 'docs:get',
          description: 'Read a doc.',
          input: {
            type: 'object',
            properties: { slugs: { type: 'array', items: { type: 'string' } }, harness: { type: 'string' } },
            required: ['slugs', 'harness'],
          },
        },
      ]),
      loadSystemPrompt: () => 'Follow the playbook.',
      codexFetch: fetchImpl as unknown as typeof fetch,
    });
    const session = await target.open({
      runId: 'sol-tool-loop',
      sutModel: LEARNING_MODEL_SPEC,
      workspaceMode: 'isolated',
      transport: 'in-process',
      dispatchOverride: { override: dispatch } as never,
    });

    const result = await session.send({
      trigger: 'user_message',
      messages: [{ role: 'user', content: 'Read x.' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'xhigh' },
      store: false,
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
    });
    expect((bodies[0].tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'function',
      name: 'docs__get',
    });
    const secondInput = bodies[1].input as Array<Record<string, unknown>>;
    expect(secondInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'docs__get' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]));
    expect(dispatch).toHaveBeenCalledWith('docs:get', { slugs: ['x'], harness: 'all' });
    expect(result.toolCalls).toEqual([{
      name: 'docs:get',
      input: { slugs: ['x'], harness: 'all' },
      responseIndex: 0,
    }]);
    expect(result.toolResults).toEqual([{
      name: 'docs:get',
      output: dispatchOutput,
      isError: false,
      truncated: false,
      sourceChars: dispatchOutput.length,
    }]);
    expect(result.assistantText).toBe('Done from Sol.');
    expect(result.finishReason).toBe('done');
  });

  it('captures tool-result evidence on the Anthropic Messages path', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key';
    try {
      anthropicMock.responses = [
        {
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'docs__get',
            input: { slugs: ['x'], harness: 'all' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
        {
          content: [{ type: 'text', text: 'Done from Claude.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      ];
      const dispatchOutput = JSON.stringify({ ok: true, results: [{ slug: 'x' }] });
      const dispatch = vi.fn(async () => ({ content: [{ text: dispatchOutput }] }));
      const target = new SuTarget({
        catalog: buildCatalog([{
          name: 'docs:get',
          description: 'Read a doc.',
          input: {
            type: 'object',
            properties: {
              slugs: { type: 'array', items: { type: 'string' } },
              harness: { type: 'string' },
            },
            required: ['slugs', 'harness'],
          },
        }]),
        loadSystemPrompt: () => 'Follow the playbook.',
      });
      const session = await target.open({
        runId: 'claude-tool-loop',
        sutModel: 'claude-sonnet-4-6',
        workspaceMode: 'isolated',
        transport: 'in-process',
        dispatchOverride: { override: dispatch } as never,
      });

      const result = await session.send({
        trigger: 'user_message',
        messages: [{ role: 'user', content: 'Read x.' }],
      });

      expect(dispatch).toHaveBeenCalledWith('docs:get', { slugs: ['x'], harness: 'all' });
      expect(result.toolCalls).toEqual([{
        name: 'docs:get',
        input: { slugs: ['x'], harness: 'all' },
        responseIndex: 0,
      }]);
      expect(result.toolResults).toEqual([{
        name: 'docs:get',
        output: dispatchOutput,
        isError: false,
        truncated: false,
        sourceChars: dispatchOutput.length,
      }]);
      expect(result.assistantText).toBe('Done from Claude.');
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      anthropicMock.responses = [];
    }
  });
});
