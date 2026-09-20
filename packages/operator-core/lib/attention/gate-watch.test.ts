import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { defaultGateWatchRoots, extractGateQuestion, parseGateChunk } from './gate-watch';

const assistantToolUse = (id: string, name: string, input: unknown): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

const userToolResult = (toolUseId: string, content: unknown = 'ok'): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });

const askInput = (question: string, options: Array<{ label: string; description?: string }>) => ({
  questions: [{ question, header: 'h', multiSelect: false, options }],
});

describe('extractGateQuestion', () => {
  it('flattens AskUserQuestion questions + options', () => {
    const { question, options } = extractGateQuestion(
      'AskUserQuestion',
      askInput('Pick one?', [{ label: 'A', description: 'a desc' }, { label: 'B' }]),
    );
    expect(question).toBe('Pick one?');
    expect(options).toEqual([{ label: 'A', description: 'a desc' }, { label: 'B', description: undefined }]);
  });

  it('joins multiple questions and falls back to a stub when empty', () => {
    const { question } = extractGateQuestion('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }] });
    expect(question).toBe('Q1 / Q2');
    expect(extractGateQuestion('AskUserQuestion', {}).question).toBe('AskUserQuestion');
  });

  it('best-effort extracts an ExitPlanMode plan summary', () => {
    const { question, options } = extractGateQuestion('ExitPlanMode', { plan: 'Do the thing' });
    expect(question).toContain('approve this plan?');
    expect(question).toContain('Do the thing');
    expect(options).toBeNull();
    expect(extractGateQuestion('ExitPlanMode', {}).question).toBe('Exit plan mode — approve?');
  });
});

describe('parseGateChunk', () => {
  it('reports a gate tool_use with no matching tool_result as open', () => {
    const chunk = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [{ label: 'yes' }])) + '\n';
    const { opens, closes, consumedBytes } = parseGateChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect(opens).toEqual([{ toolUseId: 'toolu_1', toolName: 'AskUserQuestion', question: 'Q?', options: [{ label: 'yes', description: undefined }] }]);
    expect(closes).toEqual([]);
  });

  it('cancels out an ask resolved within the same chunk (never surfaced as open)', () => {
    const chunk =
      [assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])), userToolResult('toolu_1')].join('\n') + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('reports a close candidate for a tool_result whose tool_use was in a prior chunk', () => {
    const chunk = userToolResult('toolu_prev') + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([{ toolUseId: 'toolu_prev' }]);
  });

  it('ignores non-gate tool_use names', () => {
    const chunk = assistantToolUse('toolu_1', 'Bash', { command: 'ls' }) + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('leaves a trailing partial line unconsumed', () => {
    const complete = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])) + '\n';
    const partial = '{"type":"assistant","message":{"content":[{"type":"tool_us';
    const { opens, consumedBytes } = parseGateChunk(complete + partial);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(opens).toHaveLength(1);
  });

  it('consumes nothing when there is no complete line', () => {
    const { opens, closes, consumedBytes } = parseGateChunk('{"type":"assist');
    expect(consumedBytes).toBe(0);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('tolerates torn/garbage lines', () => {
    const chunk = ['not-json-at-all', assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', []))].join('\n') + '\n';
    const { opens, consumedBytes } = parseGateChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect(opens).toHaveLength(1);
  });

  it('handles two independent open gates in one chunk', () => {
    const chunk =
      [
        assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q1?', [])),
        assistantToolUse('toolu_2', 'ExitPlanMode', { plan: 'p' }),
      ].join('\n') + '\n';
    const { opens } = parseGateChunk(chunk);
    expect(opens.map((o) => o.toolUseId).sort()).toEqual(['toolu_1', 'toolu_2']);
  });

  it('reports an in-chunk ask/answer pair as `resolved` — closing evidence the store may still need', () => {
    const chunk =
      [assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])), userToolResult('toolu_1')].join('\n') + '\n';
    const { opens, closes, resolved } = parseGateChunk(chunk);
    // Still correctly absent from BOTH: it was never observably open, and its
    // tool_use was not in a prior chunk.
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
    // WI-10002079: dropping it (the previous behaviour) left a gate minted by
    // a turn-end hook, whose answer is already in the transcript, permanently
    // unclosable — and on a cold-start full-file replay EVERY historical pair
    // takes this shape, so it was the only evidence available.
    expect(resolved).toEqual([{ toolUseId: 'toolu_1' }]);
  });

  it('leaves `resolved` empty when nothing was answered in-chunk', () => {
    const chunk = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])) + '\n';
    expect(parseGateChunk(chunk).resolved).toEqual([]);
    expect(parseGateChunk('{"type":"assist').resolved).toEqual([]);
  });
});

describe('defaultGateWatchRoots (WI-10002079/R1)', () => {
  it('includes the psu transcript root, not only the native CLI root', () => {
    const roots = defaultGateWatchRoots('/home/agent');
    // Watching only ~/.claude/projects made the tick tail a tree that does not
    // contain the sessions it exists to watch.
    expect(roots).toContain(path.join('/home/agent', '.papercusp', 'session-claude'));
    expect(roots).toContain(path.join('/home/agent', '.claude', 'projects'));
  });

  it('orders the psu root first — it holds the overwhelming majority of transcripts', () => {
    expect(defaultGateWatchRoots('/home/agent')[0]).toBe(path.join('/home/agent', '.papercusp', 'session-claude'));
  });
});
