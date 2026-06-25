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
});
