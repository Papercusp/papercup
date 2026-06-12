/**
 * transcript-core.test.ts — the stream-json → turn-timeline parser
 * (self-learning-frontier P-021 / FB-07). Synthetic claude stream fixtures
 * mirroring the live harness_run_output.jsonl_body shape (verified against a
 * real bee run, 2026-06-12): assistant events grouped by message id, tool
 * errors matched via tool_use_id, cumulative usage last-wins, run_meta
 * trailer, junk tolerance.
 */
import { describe, expect, it } from 'vitest';
import { parseTranscript, stableInputKey } from './transcript-core';

const line = (obj: unknown) => JSON.stringify(obj);

function assistantEvent(opts: {
  id: string;
  text?: string;
  toolUse?: { id: string; name: string; input?: unknown };
  usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number };
}): string {
  const content: unknown[] = [];
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text });
  if (opts.toolUse) content.push({ type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name, input: opts.toolUse.input ?? {} });
  return line({ type: 'assistant', message: { id: opts.id, role: 'assistant', content, usage: opts.usage } });
}

function toolResultEvent(toolUseId: string, isError = false): string {
  return line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: [] }] },
  });
}

describe('stableInputKey', () => {
  it('keys semantically-equal inputs identically regardless of key order', () => {
    expect(stableInputKey({ b: 1, a: { d: 2, c: 3 } })).toBe(stableInputKey({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('caps pathological inputs', () => {
    const huge = { text: 'x'.repeat(10_000) };
    expect(stableInputKey(huge).length).toBeLessThanOrEqual(500);
  });
});

describe('parseTranscript', () => {
  it('groups assistant events by message id into one turn each', () => {
    const body = [
      assistantEvent({ id: 'm1', text: 'first ' }),
      assistantEvent({ id: 'm1', toolUse: { id: 't1', name: 'Bash' }, usage: { output_tokens: 50 } }),
      assistantEvent({ id: 'm2', text: 'second', usage: { output_tokens: 30 } }),
    ].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].text).toBe('first ');
    expect(parsed.turns[0].toolCalls).toHaveLength(1);
    expect(parsed.turns[0].outputTokens).toBe(50); // last usage for m1 wins
    expect(parsed.totalOutputTokens).toBe(80);
  });

  it('matches tool errors back to their call via tool_use_id', () => {
    const body = [
      assistantEvent({ id: 'm1', toolUse: { id: 't1', name: 'Bash', input: { command: 'x' } } }),
      toolResultEvent('t1', true),
      assistantEvent({ id: 'm2', toolUse: { id: 't2', name: 'Read' } }),
      toolResultEvent('t2', false),
    ].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.turns[0].toolCalls[0].isError).toBe(true);
    expect(parsed.turns[1].toolCalls[0].isError).toBe(false);
  });

  it('reads the run_meta trailer and the terminal result cost', () => {
    const body = [
      assistantEvent({ id: 'm1', text: 'hi' }),
      line({ type: 'result', total_cost_usd: 1.25, usage: {} }),
      line({ type: 'papercusp.run_meta', backend: 'claude-code', model: 'haiku', role: 'bee', runId: 'r1' }),
    ].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.backend).toBe('claude-code');
    expect(parsed.model).toBe('haiku');
    expect(parsed.role).toBe('bee');
    expect(parsed.totalCostUsd).toBe(1.25);
  });

  it('attributes rescue markers to the next assistant turn (clamped to the last)', () => {
    const body = [
      assistantEvent({ id: 'm1', text: 'working' }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '[coord+1]\n| peer asks you to wrap up + end your turn' }] },
      }),
      assistantEvent({ id: 'm2', text: 'wrapping' }),
    ].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.rescueMarkerTurns).toEqual([1]);

    // Marker AFTER the final assistant turn clamps to that turn.
    const tail = [assistantEvent({ id: 'm1', text: 'done' }), line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'turn:interrupt force' }] } })].join('\n');
    expect(parseTranscript(tail).rescueMarkerTurns).toEqual([0]);
  });

  it('tolerates junk, truncation, and unknown event types', () => {
    const body = [
      'not json at all',
      '{"type":"stream_event","event":{}}',
      '{"truncated":', // mid-write crash
      assistantEvent({ id: 'm1', text: 'survived' }),
      '',
    ].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].text).toBe('survived');
  });

  it('returns zero turns for a non-claude stream (codex/omp v1 posture)', () => {
    const body = [line({ type: 'turn.completed', usage: { input_tokens: 5 } })].join('\n');
    const parsed = parseTranscript(body);
    expect(parsed.turns).toHaveLength(0);
    expect(parsed.rescueMarkerTurns).toEqual([]);
  });
});
