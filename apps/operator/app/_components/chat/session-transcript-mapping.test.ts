import { describe, expect, it } from 'vitest';
import { sessionTimelineToChatMessages } from './session-transcript-mapping';
import type { TimelineEntry } from '../../harness/AgentThinkingStream';

describe('sessionTimelineToChatMessages', () => {
  it('returns nothing for an empty timeline', () => {
    expect(sessionTimelineToChatMessages([])).toEqual([]);
  });

  it('maps a prompt into a user message', () => {
    const entries: TimelineEntry[] = [{ kind: 'prompt', text: 'do the thing', ts: 't1' }];
    expect(sessionTimelineToChatMessages(entries)).toEqual([
      { role: 'user', content: 'do the thing', id: 'prompt-0' },
    ]);
  });

  it('drops a blank/whitespace-only prompt', () => {
    const entries: TimelineEntry[] = [{ kind: 'prompt', text: '   ', ts: 't1' }];
    expect(sessionTimelineToChatMessages(entries)).toEqual([]);
  });

  it('joins text entries into one assistant message per turn', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'hi', ts: 't1' },
      { kind: 'text', text: 'Hello', ts: 't2' },
      { kind: 'text', text: 'there.', ts: 't3' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'hi', id: 'prompt-0' },
      { role: 'assistant', content: 'Hello\n\nthere.', id: 'turn-0' },
    ]);
  });

  it('the TOOL-NOISE FILTER: an ~90%-tool-calls turn collapses tool_use into chips and drops tool_result/status entirely', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'fix the bug', ts: 't0' },
      { kind: 'status', text: '[thinking] let me look', ts: 't1' },
      { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolId: 'tu1', ts: 't2' },
      { kind: 'tool_result', toolId: 'tu1', text: 'A'.repeat(50_000), ts: 't3' },
      { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: '/a.ts', old: 'x', new: 'y' }, toolId: 'tu2', ts: 't4' },
      { kind: 'tool_result', toolId: 'tu2', text: 'ok', ts: 't5' },
      { kind: 'status', text: '[thinking] done', ts: 't6' },
      { kind: 'text', text: 'Fixed it.', ts: 't7' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'fix the bug', id: 'prompt-0' },
      {
        role: 'assistant',
        content: 'Fixed it.',
        tools: [
          { name: 'Read', input: { file_path: '/a.ts' } },
          { name: 'Edit', input: { file_path: '/a.ts', old: 'x', new: 'y' } },
        ],
        id: 'turn-0',
      },
    ]);
    // The 50KB tool_result never reaches the mapped output — the whole point
    // of the filter.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('A'.repeat(50_000));
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('a tool-only turn (no text) still surfaces as an assistant message carrying just the tool chips', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'run the tests', ts: 't0' },
      { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, ts: 't1' },
      { kind: 'tool_result', text: 'PASS', ts: 't2' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'user', content: 'run the tests', id: 'prompt-0' },
      { role: 'assistant', content: '', tools: [{ name: 'Bash', input: { command: 'npm test' } }], id: 'turn-0' },
    ]);
  });

  it('a turn with only status/tool_result (no text, no tool_use) produces no assistant message', () => {
    const entries: TimelineEntry[] = [
      { kind: 'prompt', text: 'ping', ts: 't0' },
      { kind: 'status', text: '[thinking] …', ts: 't1' },
    ];
    expect(sessionTimelineToChatMessages(entries)).toEqual([
      { role: 'user', content: 'ping', id: 'prompt-0' },
    ]);
  });

  it('falls back to the `result` entry text only when no `text` entries exist in the turn', () => {
    const withResultOnly: TimelineEntry[] = [
      { kind: 'prompt', text: 'summarize', ts: 't0' },
      { kind: 'tool_use', toolName: 'search', toolInput: {}, ts: 't1' },
      { kind: 'result', text: 'Final answer from result.', costUsd: 0.01, ts: 't2' },
    ];
    expect(sessionTimelineToChatMessages(withResultOnly)).toEqual([
      { role: 'user', content: 'summarize', id: 'prompt-0' },
      {
        role: 'assistant',
        content: 'Final answer from result.',
        tools: [{ name: 'search', input: {} }],
        id: 'turn-0',
      },
    ]);

    const withBothTextAndResult: TimelineEntry[] = [
      { kind: 'prompt', text: 'summarize', ts: 't0' },
      { kind: 'text', text: 'Streamed answer.', ts: 't1' },
      { kind: 'result', text: 'Streamed answer. (duplicate summary)', ts: 't2' },
    ];
    // `text` wins over `result` when both are present — no duplicated content.
    expect(sessionTimelineToChatMessages(withBothTextAndResult)).toEqual([
      { role: 'user', content: 'summarize', id: 'prompt-0' },
      { role: 'assistant', content: 'Streamed answer.', id: 'turn-0' },
    ]);
  });

  it('handles multiple turns in order, including a leading partial turn before the first prompt', () => {
    const entries: TimelineEntry[] = [
      { kind: 'text', text: 'leftover from before this window', ts: 't0' },
      { kind: 'prompt', text: 'first', ts: 't1' },
      { kind: 'text', text: 'first reply', ts: 't2' },
      { kind: 'prompt', text: 'second', ts: 't3' },
      { kind: 'tool_use', toolName: 'Grep', toolInput: { pattern: 'x' }, ts: 't4' },
      { kind: 'text', text: 'second reply', ts: 't5' },
    ];
    const out = sessionTimelineToChatMessages(entries);
    expect(out).toEqual([
      { role: 'assistant', content: 'leftover from before this window', id: 'turn-0' },
      { role: 'user', content: 'first', id: 'prompt-1' },
      { role: 'assistant', content: 'first reply', id: 'turn-1' },
      { role: 'user', content: 'second', id: 'prompt-2' },
      {
        role: 'assistant',
        content: 'second reply',
        tools: [{ name: 'Grep', input: { pattern: 'x' } }],
        id: 'turn-2',
      },
    ]);
  });

  // WI-5997 (chat-ref-pills-2026-07-26 P-007 residual): a P-NNN ref pill's
  // click resolves off ChatMessage.planSlug (ChatConversation reads it
  // per-message) — this mapper never set it, so a real P-ref pill rendered
  // and hydrated but silently no-op'd on click.
  describe('planSlug (WI-5997)', () => {
    it('omits planSlug entirely when the caller passes no second argument (unchanged default behavior)', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi', ts: 't1' },
        { kind: 'text', text: 'Hello', ts: 't2' },
      ];
      const out = sessionTimelineToChatMessages(entries);
      expect(out.every((m) => !('planSlug' in m))).toBe(true);
    });

    it('stamps every mapped message (user + assistant) with the given planSlug', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'hi', ts: 't1' },
        { kind: 'text', text: 'Hello', ts: 't2' },
      ];
      const out = sessionTimelineToChatMessages(entries, 'my-plan-2026-07-26');
      expect(out).toEqual([
        { role: 'user', content: 'hi', id: 'prompt-0', planSlug: 'my-plan-2026-07-26' },
        { role: 'assistant', content: 'Hello', id: 'turn-0', planSlug: 'my-plan-2026-07-26' },
      ]);
    });

    it('stamps an explicit null (no active plan) rather than omitting the field, distinct from the undefined default', () => {
      const entries: TimelineEntry[] = [{ kind: 'prompt', text: 'hi', ts: 't1' }];
      const out = sessionTimelineToChatMessages(entries, null);
      expect(out).toEqual([{ role: 'user', content: 'hi', id: 'prompt-0', planSlug: null }]);
    });

    it('a tool-only assistant message is also stamped', () => {
      const entries: TimelineEntry[] = [
        { kind: 'prompt', text: 'run the tests', ts: 't0' },
        { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, ts: 't1' },
      ];
      const out = sessionTimelineToChatMessages(entries, 'p');
      expect(out).toEqual([
        { role: 'user', content: 'run the tests', id: 'prompt-0', planSlug: 'p' },
        {
          role: 'assistant',
          content: '',
          tools: [{ name: 'Bash', input: { command: 'npm test' } }],
          id: 'turn-0',
          planSlug: 'p',
        },
      ]);
    });
  });
});
