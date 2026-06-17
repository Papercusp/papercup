import { describe, expect, it, vi } from 'vitest';
import {
  buildInitialMessage,
  imageMediaType,
  runGaiaAgent,
  type GaiaToolset,
  type LlmFn,
  type LlmTurnResponse,
} from './agent';
import type { GaiaTask } from './dataset';

const TASK: GaiaTask = { taskId: 't1', question: 'What is the capital of France?', level: 1, finalAnswer: 'Paris', fileName: '' };

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

/** A canned-script LLM: returns the queued response per turn (and records how it was called). */
function scriptedLlm(responses: LlmTurnResponse[]): { fn: LlmFn; calls: number } {
  const state = { calls: 0 } as { calls: number; fn: LlmFn };
  state.fn = async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    return r;
  };
  return state;
}

const noTools: GaiaToolset = { specs: [], handlers: {} };

describe('gaia agent — imageMediaType', () => {
  it('maps image extensions, rejects non-images', () => {
    expect(imageMediaType('chart.png')).toBe('image/png');
    expect(imageMediaType('photo.JPG')).toBe('image/jpeg');
    expect(imageMediaType('data.xlsx')).toBeNull();
    expect(imageMediaType('')).toBeNull();
  });
});

describe('gaia agent — buildInitialMessage', () => {
  it('includes just the question when there is no attachment', async () => {
    const m = await buildInitialMessage(TASK);
    expect(m.role).toBe('user');
    expect(m.content[0]).toMatchObject({ type: 'text' });
    expect(m.content).toHaveLength(1);
  });

  it('feeds an image attachment as a vision block', async () => {
    const t: GaiaTask = { ...TASK, fileName: 'chart.png', filePath: '/staged/chart.png' };
    const m = await buildInitialMessage(t, async () => 'BASE64DATA');
    const img = m.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mediaType: 'image/png', dataBase64: 'BASE64DATA' });
  });

  it('notes a non-image attachment for read_file / run_python', async () => {
    const t: GaiaTask = { ...TASK, fileName: 'sheet.xlsx', filePath: '/staged/sheet.xlsx' };
    const m = await buildInitialMessage(t);
    const note = m.content.map((c) => ('text' in c ? c.text : '')).join(' ');
    expect(note).toContain('sheet.xlsx');
    expect(note).toMatch(/read_file|run_python/);
  });
});

describe('gaia agent — runGaiaAgent loop', () => {
  it('returns the final answer when the model ends without tools', async () => {
    const { fn } = scriptedLlm([
      { content: [{ type: 'text', text: 'It is well known.\nFINAL ANSWER: Paris' }], stopReason: 'end_turn', usage: usage(100, 20) },
    ]);
    const r = await runGaiaAgent(TASK, { llm: fn, tools: noTools });
    expect(r.stopReason).toBe('done');
    expect(r.finalAnswer).toBe('Paris');
    expect(r.rawOutput).toContain('FINAL ANSWER: Paris');
    expect(r.turns).toBe(1);
    expect(r.tokensIn).toBe(100);
    expect(r.tokensOut).toBe(20);
    expect(r.toolCalls).toBe(0);
  });

  it('dispatches a tool then finishes, accumulating tokens + trajectory', async () => {
    const search = vi.fn(async () => 'Result: Paris is the capital of France.');
    const tools: GaiaToolset = {
      specs: [{ name: 'web_search', description: 'search', inputSchema: { type: 'object' } }],
      handlers: { web_search: search },
    };
    const { fn } = scriptedLlm([
      {
        content: [
          { type: 'text', text: 'Let me verify.' },
          { type: 'tool_use', id: 'tu1', name: 'web_search', input: { query: 'capital of France' } },
        ],
        stopReason: 'tool_use',
        usage: usage(100, 30),
      },
      { content: [{ type: 'text', text: 'FINAL ANSWER: Paris' }], stopReason: 'end_turn', usage: usage(150, 10) },
    ]);
    const r = await runGaiaAgent(TASK, { llm: fn, tools });
    expect(search).toHaveBeenCalledWith({ query: 'capital of France' });
    expect(r.finalAnswer).toBe('Paris');
    expect(r.toolCalls).toBe(1);
    expect(r.turns).toBe(2);
    expect(r.tokensIn).toBe(250);
    expect(r.tokensOut).toBe(40);
    expect(r.trajectory.some((s) => s.kind === 'tool_use' && s.tool === 'web_search')).toBe(true);
    expect(r.trajectory.some((s) => s.kind === 'tool_result')).toBe(true);
  });

  it('stops with max-turns when the model never finishes', async () => {
    const tools: GaiaToolset = {
      specs: [{ name: 'web_search', description: 's', inputSchema: { type: 'object' } }],
      handlers: { web_search: async () => 'more' },
    };
    // Always calls the tool, never ends.
    const fn: LlmFn = async () => ({
      content: [{ type: 'tool_use', id: 'x', name: 'web_search', input: {} }],
      stopReason: 'tool_use',
      usage: usage(10, 5),
    });
    const r = await runGaiaAgent(TASK, { llm: fn, tools }, { maxTurns: 3 });
    expect(r.stopReason).toBe('max-turns');
    expect(r.turns).toBe(3);
    expect(r.toolCalls).toBe(3);
  });

  it('stops with budget-exhausted when cumulative tokens exceed the cap', async () => {
    const tools: GaiaToolset = {
      specs: [{ name: 't', description: 't', inputSchema: { type: 'object' } }],
      handlers: { t: async () => 'r' },
    };
    const fn: LlmFn = async () => ({
      content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }],
      stopReason: 'tool_use',
      usage: usage(600, 600),
    });
    const r = await runGaiaAgent(TASK, { llm: fn, tools }, { maxTurns: 50, maxTotalTokens: 1000 });
    expect(r.stopReason).toBe('budget-exhausted');
    expect(r.turns).toBe(1); // one full turn (1200 tokens) then budget guard fires
  });

  it('handles an unknown tool gracefully (isError result, keeps going)', async () => {
    const { fn } = scriptedLlm([
      { content: [{ type: 'tool_use', id: 'u', name: 'nonexistent', input: {} }], stopReason: 'tool_use', usage: usage(10, 5) },
      { content: [{ type: 'text', text: 'FINAL ANSWER: Paris' }], stopReason: 'end_turn', usage: usage(10, 5) },
    ]);
    const r = await runGaiaAgent(TASK, { llm: fn, tools: noTools });
    expect(r.finalAnswer).toBe('Paris');
    expect(r.trajectory.some((s) => s.summary.includes('unknown tool'))).toBe(true);
  });

  it('degrades a thrown LLM error to stopReason=error (never throws out of the loop)', async () => {
    const fn: LlmFn = async () => {
      throw new Error('gateway 429');
    };
    const r = await runGaiaAgent(TASK, { llm: fn, tools: noTools });
    expect(r.stopReason).toBe('error');
    expect(r.error).toContain('429');
  });

  it('captures a tool that throws as an isError tool_result and continues', async () => {
    const tools: GaiaToolset = {
      specs: [{ name: 'run_python', description: 'p', inputSchema: { type: 'object' } }],
      handlers: {
        run_python: async () => {
          throw new Error('python timeout');
        },
      },
    };
    const { fn } = scriptedLlm([
      { content: [{ type: 'tool_use', id: 'p1', name: 'run_python', input: { code: 'x' } }], stopReason: 'tool_use', usage: usage(10, 5) },
      { content: [{ type: 'text', text: 'FINAL ANSWER: 42' }], stopReason: 'end_turn', usage: usage(10, 5) },
    ]);
    const r = await runGaiaAgent(TASK, { llm: fn, tools });
    expect(r.finalAnswer).toBe('42');
    expect(r.trajectory.some((s) => s.summary.includes('python timeout'))).toBe(true);
  });
});
