import { describe, expect, it } from 'vitest';
import {
  parseAgentTimelineChunks,
  capEntryText,
  THINKING_ENTRY_TEXT_CAP,
  sessionTurnEntryKind,
  pickSessionTurnWindow,
} from '../routes/harness/streams';

describe('capEntryText (UI-bound thinking entry cap)', () => {
  it('leaves short/absent text untouched (same object, no copy)', () => {
    const short = { kind: 'text' as const, text: 'hi' };
    expect(capEntryText(short)).toBe(short);
    const noText = { kind: 'status' as const };
    expect(capEntryText(noText)).toBe(noText);
  });

  it('caps oversized text with an explicit truncation marker', () => {
    const big = { kind: 'tool_result' as const, text: 'x'.repeat(THINKING_ENTRY_TEXT_CAP + 500), ts: 't1' };
    const capped = capEntryText(big);
    expect(capped).not.toBe(big);
    expect(capped.text!.length).toBeLessThan(big.text.length);
    expect(capped.text).toContain('[truncated 500 chars]');
    expect(capped.ts).toBe('t1'); // other fields preserved
    expect(big.text.length).toBe(THINKING_ENTRY_TEXT_CAP + 500); // input not mutated
  });
});

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

describe('session_turns fallback backfill (WI-4194 — pruned-transcript ended session)', () => {
  describe('sessionTurnEntryKind', () => {
    it('maps user/human turns to the prompt turn-boundary, everything else to text', () => {
      expect(sessionTurnEntryKind('user')).toBe('prompt');
      expect(sessionTurnEntryKind('human')).toBe('prompt');
      expect(sessionTurnEntryKind('assistant')).toBe('text');
      expect(sessionTurnEntryKind('tool')).toBe('text');
      expect(sessionTurnEntryKind(null)).toBe('text');
      expect(sessionTurnEntryKind(undefined)).toBe('text');
    });
  });

  describe('pickSessionTurnWindow', () => {
    // Monotonic, always-valid timestamps: turn i is i minutes after the base
    // (epoch math, so it scales past 59 without rolling into an invalid field).
    const BASE = Date.parse('2026-06-05T00:00:00.000Z');
    const tsAt = (i: number) => new Date(BASE + i * 60_000).toISOString();
    const list = (n: number) => Array.from({ length: n }, (_, i) => tsAt(i));

    it('tails the last cap turns when no anchor is given', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200);
      expect(start).toBe(800);
      expect(anchorPos).toBeNull();
    });

    it('returns start 0 when the session is shorter than the cap', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(50), 200);
      expect(start).toBe(0);
      expect(anchorPos).toBeNull();
    });

    it('centers the window on the turn nearest anchorTs', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(500));
      expect(anchorPos).toBe(500);
      expect(start).toBe(400); // 500 - cap/2
    });

    it('clamps the centered window to the end of the list', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(990));
      expect(anchorPos).toBe(990);
      expect(start).toBe(800); // clamped so start+cap never exceeds length
    });

    it('clamps the centered window to the start of the list', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, tsAt(10));
      expect(anchorPos).toBe(10);
      expect(start).toBe(0); // 10 - 100 would be negative
    });

    it('picks the NEAREST turn by timestamp for an anchor between turns', () => {
      // anchor at 00:07:30 sits between turn 7 (00:07:00) and turn 8 (00:08:00);
      // turn 7 is 30s away, turn 8 is 30s away — the first-seen closest (7) wins.
      const { anchorPos } = pickSessionTurnWindow(list(20), 200, '2026-06-05T00:07:30.000Z');
      expect(anchorPos).toBe(7);
    });

    it('falls back to the tail when anchorTs is unparseable', () => {
      const { start, anchorPos } = pickSessionTurnWindow(list(1000), 200, 'not-a-date');
      expect(start).toBe(800);
      expect(anchorPos).toBeNull();
    });

    it('ignores turns with null ts when matching an anchor', () => {
      const withGaps: Array<string | null> = [tsAt(0), null, tsAt(2), null, tsAt(4)];
      const { anchorPos } = pickSessionTurnWindow(withGaps, 2, tsAt(2));
      expect(anchorPos).toBe(2); // the null rows are skipped, exact ts match wins
    });
  });
});
