import { describe, expect, it } from 'vitest';
import { prioritizedInboxWindow } from './inbox-visibility';
import { sectionsToText } from './message-fields';
import { chunkOverCapMessage } from './tools/send-chunking';

type InboxEntry = Record<string, unknown> & { msg_id: string };

function chunkParts(): InboxEntry[] {
  const plan = chunkOverCapMessage({
    to: ['recipient'],
    summary: 'long request',
    body: [{ text: 'body content '.repeat(80) }],
    expects: 'answer',
  });
  if (plan.kind !== 'chunked') throw new Error('fixture must exceed the inbox body cap');

  return plan.parts.map(({ message, meta }, index) => ({
    msg_id: `chunk-${meta.part}`,
    from: 'sender',
    to: ['recipient'],
    kind: 'message',
    summary: message.summary,
    body: sectionsToText(message.body as Array<{ text: string }>),
    ts: `2026-10-09T05:0${index}:00.000Z`,
    expects: message.expects,
  }));
}

function urgentAsk(index: number): InboxEntry {
  const minute = String(index).padStart(2, '0');
  return {
    msg_id: `urgent-${index}`,
    from: 'other-sender',
    to: ['recipient'],
    kind: 'message',
    summary: `urgent ask ${index}`,
    ts: `2026-10-09T04:${minute}:00.000Z`,
    expects: 'answer',
  };
}

describe('prioritizedInboxWindow multipart integrity', () => {
  it('keeps every part when only the final part carries the actionable ask', () => {
    const entries = [
      ...Array.from({ length: 50 }, (_, index) => urgentAsk(index)),
      ...chunkParts(),
    ];

    const visible = prioritizedInboxWindow(entries, 50);
    const visibleChunks = visible.filter((entry) => entry.msg_id.startsWith('chunk-'));

    expect(visibleChunks.map((entry) => entry.msg_id)).toEqual(['chunk-1', 'chunk-2']);
  });

  it('does not present an incomplete multipart group as a complete inbox message', () => {
    const finalPart = chunkParts()[1]!;
    const visible = prioritizedInboxWindow(
      [finalPart],
      50,
    );

    expect(visible).toEqual([]);
  });
});
