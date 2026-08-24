import { describe, expect, it, vi } from 'vitest';

import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import { buildCatalog } from '../targets/su-catalog';
import { SuTarget } from '../targets/su';

function completed(output: unknown[], usage = { input_tokens: 10, output_tokens: 4 }): Response {
  const event = { type: 'response.completed', response: { output, usage } };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('SuTarget Codex Responses tool loop', () => {
  it('splits Sol xhigh, replays output items, and returns function results through Responses', async () => {
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
        ]);
      }
      return completed([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done from Sol.' }],
        },
      ]);
    });
    const dispatch = vi.fn(async () => ({
      content: [{ text: JSON.stringify({ ok: true, results: [{ slug: 'x' }] }) }],
    }));
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

    const result = await session.send({ messages: [{ role: 'user', content: 'Read x.' }] });

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
    expect(result.toolCalls).toEqual([{ name: 'docs:get', input: { slugs: ['x'], harness: 'all' } }]);
    expect(result.assistantText).toBe('Done from Sol.');
    expect(result.finishReason).toBe('done');
  });
});
