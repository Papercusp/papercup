/**
 * transcript.test.ts — the tolerant jsonl→turns parser over the three backend
 * stream shapes, plus the deterministic cut/render seams (P-020 / FB-06).
 * Pure unit, no fs/LLM/PG.
 */
import { describe, expect, it } from 'vitest';
import { cutTranscript, intentFromTranscript, parseTranscriptJsonl, renderTurns } from './transcript';

const claudeBody = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Fix the flaky auth test' },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'text', text: 'Looking at the test file first.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test auth' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: '2 failing' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The mock clock drifts; pinning it.' }] },
  }),
  JSON.stringify({ type: 'result', subtype: 'success' }),
].join('\n');

describe('parseTranscriptJsonl — claude stream-json', () => {
  it('extracts ordered turns, drops thinking, keeps tool structure', () => {
    const t = parseTranscriptJsonl(claudeBody, 'ref-1');
    expect(t.backend).toBe('claude-code');
    expect(t.model).toBe('claude-opus-4-8');
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'tool_use', 'tool_result', 'assistant']);
    expect(t.turns[2]).toMatchObject({ toolName: 'Bash', text: JSON.stringify({ command: 'npm test auth' }) });
    expect(t.turns.map((x) => x.index)).toEqual([0, 1, 2, 3, 4]);
    expect(JSON.stringify(t.turns)).not.toContain('hidden reasoning');
  });

  it('is tolerant: garbled lines and unknown events are skipped, never fatal', () => {
    const body = `not-json\n{"type":"weird_event"}\n${claudeBody}\n{"truncated`; // trailing partial line
    const t = parseTranscriptJsonl(body, 'ref-2');
    expect(t.turns).toHaveLength(5);
  });
});

describe('parseTranscriptJsonl — omp shapes', () => {
  it('parses session-file message events + top-level function_call', () => {
    const body = [
      JSON.stringify({ type: 'session', version: 3, id: 'abc' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-25T18:16:03.505Z',
        message: { role: 'user', content: 'check plan status' },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] },
      }),
      JSON.stringify({ type: 'function_call', name: 'plans_get', arguments: { slug: 'x' } }),
    ].join('\n');
    const t = parseTranscriptJsonl(body, 'omp-1');
    expect(t.backend).toBe('omp');
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'tool_use']);
    expect(t.turns[0].ts).toBe(Date.parse('2026-05-25T18:16:03.505Z'));
    expect(t.turns[2].toolName).toBe('plans_get');
  });

  it('falls back to agent_end.messages only when nothing else parsed', () => {
    const body = [
      JSON.stringify({
        type: 'agent_end',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
      }),
    ].join('\n');
    const t = parseTranscriptJsonl(body, 'omp-2');
    expect(t.turns.map((x) => x.text)).toEqual(['hello', 'world']);
  });
});

describe('parseTranscriptJsonl — codex + run_meta', () => {
  it('parses item.completed agent messages and honors the run_meta stamp', () => {
    const body = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done step 1' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
      JSON.stringify({ type: 'papercusp.run_meta', backend: 'codex', model: 'gpt-5.5' }),
    ].join('\n');
    const t = parseTranscriptJsonl(body, 'cx-1');
    expect(t.backend).toBe('codex');
    expect(t.model).toBe('gpt-5.5');
    expect(t.turns.map((x) => x.role)).toEqual(['assistant', 'tool_use']);
  });

  it('parses current response_item messages, custom tool calls, and block-array tool results', () => {
    const body = [
      JSON.stringify({
        timestamp: '2026-09-14T05:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '⟦carry-drill:drill-codex⟧\nContinue the carried work.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-14T05:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Restoring the claimed lane.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-14T05:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'mcp__papercusp-su__work_items_get',
          input: '{"id":"WI-4852"}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-14T05:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [
            { type: 'input_text', text: '{"state":"wip"}' },
            { type: 'input_text', text: 'checkpoint restored' },
          ],
        },
      }),
    ].join('\n');

    const t = parseTranscriptJsonl(body, 'cx-current');
    expect(t.backend).toBe('codex');
    expect(t.turns).toEqual([
      {
        index: 0,
        role: 'user',
        text: '⟦carry-drill:drill-codex⟧\nContinue the carried work.',
        ts: Date.parse('2026-09-14T05:00:00.000Z'),
      },
      {
        index: 1,
        role: 'assistant',
        text: 'Restoring the claimed lane.',
        ts: Date.parse('2026-09-14T05:00:01.000Z'),
      },
      {
        index: 2,
        role: 'tool_use',
        toolName: 'mcp__papercusp-su__work_items_get',
        text: '{"id":"WI-4852"}',
        ts: Date.parse('2026-09-14T05:00:02.000Z'),
      },
      {
        index: 3,
        role: 'tool_result',
        text: '{"state":"wip"}\ncheckpoint restored',
        ts: Date.parse('2026-09-14T05:00:03.000Z'),
      },
    ]);
  });

  it('unwraps only provable nested Papercusp calls from the Codex exec orchestration wrapper', () => {
    const directSource = [
      'const result = await tools.mcp__papercusp_su__tools_invoke({',
      '  name: "work_items:get",',
      '  args: { id: "WI-4852" }',
      '});',
      'text(result);',
    ].join('\n');
    const fallbackSource = [
      'const r = await tools.exec_command({',
      '  cmd: "ptool tools:invoke --json - <<\'JSON\'\\n{\\\"name\\\":\\\"session:carry-drill\\\",\\\"args\\\":{\\\"op\\\":\\\"grade\\\"}}\\nJSON"',
      '});',
      'text(r);',
    ].join('\n');
    const body = [directSource, fallbackSource].map((input) => JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input },
    })).join('\n');

    const t = parseTranscriptJsonl(body, 'cx-exec');
    expect(t.turns.map((turn) => [turn.role, turn.toolName])).toEqual([
      ['tool_use', 'exec'],
      ['tool_use', 'work_items:get'],
      ['tool_use', 'exec'],
      ['tool_use', 'session:carry_drill'],
    ]);
    expect(t.turns[1].text).toContain('WI-4852');
    expect(t.turns[3].text).toContain('session:carry-drill');
  });
});

describe('cutTranscript', () => {
  const t = parseTranscriptJsonl(claudeBody, 'ref-cut');

  it('splits context/continuation at the turn index', () => {
    const { context, continuation } = cutTranscript(t, 2);
    expect(context.map((x) => x.index)).toEqual([0, 1]);
    expect(continuation.map((x) => x.index)).toEqual([2, 3, 4]);
  });

  it('rejects out-of-range cut points', () => {
    expect(() => cutTranscript(t, 0)).toThrow(/out of range/);
    expect(() => cutTranscript(t, 5)).toThrow(/out of range/);
  });
});

describe('renderTurns', () => {
  const t = parseTranscriptJsonl(claudeBody, 'ref-render');

  it('renders deterministically (same input ⇒ same bytes)', () => {
    const a = renderTurns(t.turns, { maxChars: 10_000, keep: 'tail' });
    const b = renderTurns(t.turns, { maxChars: 10_000, keep: 'tail' });
    expect(a).toBe(b);
    expect(a).toContain('[#2 tool_use Bash]');
  });

  it('keeps the tail under the cap and marks the elision', () => {
    const text = renderTurns(t.turns, { maxChars: 120, keep: 'tail' });
    expect(text.length).toBeLessThanOrEqual(160); // cap + elision marker
    expect(text).toContain('earlier turn(s) elided');
    expect(text).toContain('pinning it'); // the last turn survives
  });

  it('keeps the head when asked', () => {
    const text = renderTurns(t.turns, { maxChars: 120, keep: 'head' });
    expect(text).toContain('later turn(s) elided');
    expect(text).toContain('[#0 user]');
  });
});

describe('intentFromTranscript', () => {
  it('defaults to the first user turn', () => {
    const t = parseTranscriptJsonl(claudeBody, 'ref-intent');
    expect(intentFromTranscript(t)).toBe('Fix the flaky auth test');
  });
});
