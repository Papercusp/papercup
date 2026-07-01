import { describe, expect, it } from 'vitest';
import { parseAgentTimelineChunks } from '../routes/harness/streams';

describe('harness agent thinking stream parsing', () => {
  it('parses durable run chunks into an initial live-thinking timeline', () => {
    const chunks = [
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"checking "}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"state"}}\n{"type":"message_update","assistantMessageEvent":{"type":"thinking_end"}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"I found "}}\n',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"the issue."}}\n',
      '{"type":"tool_execution_start","toolName":"Read","toolCallId":"t1","args":{"file":"x.ts"}}\n',
    ];

    const parsed = parseAgentTimelineChunks(chunks);

    expect(parsed.done).toBe(false);
    expect(parsed.entries).toEqual([
      { kind: 'status', text: '[thinking] checking state' },
      { kind: 'text', text: 'I found the issue.' },
      { kind: 'tool_use', toolName: 'Read', toolInput: { file: 'x.ts' }, toolId: 't1' },
    ]);
  });

  it('keeps a partial final line visible instead of waiting for another chunk', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial text"}}}',
    ]);

    expect(parsed.entries).toEqual([{ kind: 'text', text: 'partial text' }]);
  });

  it('stamps each entry with its source-record timestamp (transcript records)', () => {
    const T1 = '2026-07-01T02:14:43.029Z';
    const T2 = '2026-07-01T02:14:50.100Z';
    const parsed = parseAgentTimelineChunks([
      `{"type":"assistant","timestamp":"${T1}","message":{"content":[{"type":"text","text":"Working on it."},{"type":"tool_use","name":"Bash","input":{"command":"ls"},"id":"tu1"}]}}\n`,
      `{"type":"user","timestamp":"${T2}","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}\n`,
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'Working on it.', ts: T1 },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolId: 'tu1', ts: T1 },
      { kind: 'tool_result', toolId: 'tu1', text: 'ok', ts: T2 },
    ]);
  });

  it('emits a `prompt` entry for a real user/wake message (a turn boundary), not for tool_result', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"user","timestamp":"2026-07-01T10:00:00Z","message":{"content":"do the thing"}}\n',
      '{"type":"assistant","timestamp":"2026-07-01T10:00:01Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"c":"ls"},"id":"t1"}]}}\n',
      '{"type":"user","timestamp":"2026-07-01T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'prompt', text: 'do the thing', ts: '2026-07-01T10:00:00Z' },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { c: 'ls' }, toolId: 't1', ts: '2026-07-01T10:00:01Z' },
      { kind: 'tool_result', toolId: 't1', text: 'ok', ts: '2026-07-01T10:00:02Z' },
    ]);
  });

  it('treats a text-block-only user record as a prompt too', () => {
    const parsed = parseAgentTimelineChunks([
      '{"type":"user","message":{"content":[{"type":"text","text":"hello wake"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([{ kind: 'prompt', text: 'hello wake' }]);
  });

  it('stamps accumulated text with the START-of-span timestamp, not the flush time', () => {
    const T = '2026-07-01T03:00:00.000Z';
    const parsed = parseAgentTimelineChunks([
      `{"type":"stream_event","timestamp":"${T}","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}\n`,
      '{"type":"stream_event","timestamp":"2026-07-01T03:00:05.000Z","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}\n',
      '{"type":"assistant","timestamp":"2026-07-01T03:00:06.000Z","message":{"content":[{"type":"text","text":"done"}]}}\n',
    ]);
    expect(parsed.entries).toEqual([
      { kind: 'text', text: 'hello world', ts: T }, // first delta's time, not the flush
      { kind: 'text', text: 'done', ts: '2026-07-01T03:00:06.000Z' },
    ]);
  });
});
