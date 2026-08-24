/**
 * session-compaction unit tests — P-009 (own-tui-full-divorce-2026-08-24).
 * Scripted fake ModelPort; no PG, no network. Pins: the clean-user-turn cut
 * (a tool_call/tool_result pair never splits), the threshold noop, the
 * summarize round-trip (prior summary folded in, usage returned), and the
 * bounded-growth degrade when the summarizer fails.
 */
import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelPort, ModelStreamEvent } from './model-port';
import {
  findCompactionCut,
  maybeCompactSession,
  renderForSummary,
  serializedChars,
} from './session-compaction';

const user = (text: string): ModelMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const assistantCall = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_call', id, name: 'do_thing', input: { id } }],
});
const toolResult = (id: string, content: unknown = 'ok'): ModelMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolCallId: id, content }],
});

function scriptedPort(script: ModelStreamEvent[]) {
  const requests: Parameters<ModelPort['stream']>[0][] = [];
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      for (const ev of script) yield ev;
    },
  };
  return { port, requests };
}

describe('findCompactionCut', () => {
  it('picks the latest clean user turn that still keeps keepRecent messages', () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
      user('q3'), assistant('a3'),
    ];
    // limit = 6 - 2 = 4; clean user turns at 0, 2, 4 → cut 4.
    expect(findCompactionCut(messages, 2)).toBe(4);
  });

  it('never splits a tool_call from its tool_result', () => {
    const messages = [
      user('q1'),
      assistantCall('c1'),
      toolResult('c1'),
      user('q2'),
      assistant('a2'),
    ];
    // limit = 5 - 1 = 4; indexes 1..2 are the pair; only clean user turn ≤ 4
    // (besides the opening) is 3 — the pair stays whole in the prefix.
    expect(findCompactionCut(messages, 1)).toBe(3);
  });

  it('falls back to the latest clean user turn anywhere when none fits the window', () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'),
      assistantCall('c1'), toolResult('c1'),
      assistantCall('c2'), toolResult('c2'),
    ];
    // limit = 7 - 10 < 0 → no candidate in window; bestAny = 2.
    expect(findCompactionCut(messages, 10)).toBe(2);
  });

  it('returns 0 when the opening user turn is the only clean one', () => {
    const messages = [user('q1'), assistantCall('c1'), toolResult('c1'), assistant('a1')];
    expect(findCompactionCut(messages, 1)).toBe(0);
  });
});

describe('maybeCompactSession', () => {
  const base = {
    priorSummary: null as string | null,
    priorCompactedCount: 0,
    model: 'test-model',
  };

  it('is a noop under the threshold', async () => {
    const messages = [user('q1'), assistant('a1')];
    const { port, requests } = scriptedPort([]);
    const out = await maybeCompactSession({ ...base, messages, port });
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(messages);
    expect(out.summary).toBeNull();
    expect(requests.length).toBe(0);
  });

  it('summarizes the elder prefix, folds the prior summary, and returns usage', async () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
      user('q3'), assistant('a3'),
    ];
    const { port, requests } = scriptedPort([
      { type: 'text_delta', text: 'NEW SUMMARY' },
      { type: 'stop', reason: 'end_turn', usage: { inputTokens: 50, outputTokens: 9 } },
    ]);
    const out = await maybeCompactSession({
      ...base,
      priorSummary: 'OLD SUMMARY',
      priorCompactedCount: 3,
      messages,
      port,
      thresholdChars: 10, // force compaction
      keepRecent: 2,
    });
    expect(out.compacted).toBe(true);
    expect(out.summary).toBe('NEW SUMMARY');
    expect(out.messages).toEqual([user('q3'), assistant('a3')]);
    expect(out.compactedCount).toBe(3 + 4);
    expect(out.summarizeUsage).toEqual({ inputTokens: 50, outputTokens: 9 });
    // The summarizer saw the prior summary AND the folded turns, no tools.
    expect(requests.length).toBe(1);
    const req = requests[0];
    expect(req.tools).toBeUndefined();
    const prompt = (req.messages[0].content[0] as { type: 'text'; text: string }).text;
    expect(prompt).toContain('OLD SUMMARY');
    expect(prompt).toContain('q1');
    expect(prompt).not.toContain('q3'); // kept suffix is not summarized
  });

  it('still trims on summarizer failure and records the coverage gap', async () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
    ];
    const { port } = scriptedPort([{ type: 'error', message: 'gateway down' }]);
    const out = await maybeCompactSession({
      ...base,
      priorSummary: 'OLD SUMMARY',
      priorCompactedCount: 1,
      messages,
      port,
      thresholdChars: 10,
      keepRecent: 2,
    });
    expect(out.compacted).toBe(true);
    expect(out.messages).toEqual([user('q2'), assistant('a2')]);
    expect(out.compactedCount).toBe(1 + 2);
    expect(out.summary).toContain('OLD SUMMARY'); // prior coverage survives
    expect(out.summary).toContain('summarizer unavailable: gateway down');
  });
});

describe('renderForSummary', () => {
  it('renders text, tool calls and results with per-part clamps', () => {
    const rendered = renderForSummary([
      user('hello'),
      assistantCall('c9'),
      toolResult('c9', { big: 'y'.repeat(5_000) }),
    ]);
    expect(rendered).toContain('user: hello');
    expect(rendered).toContain('tool_call do_thing');
    expect(rendered).toContain('… [+'); // clamp marker on the oversized result
  });

  it('serializedChars counts the JSON form', () => {
    expect(serializedChars([user('x')])).toBe(JSON.stringify([user('x')]).length);
  });
});
