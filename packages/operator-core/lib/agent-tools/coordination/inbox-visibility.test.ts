import { describe, expect, it } from 'vitest';
import { changedSystemNoticeDelivery, prioritizedInboxWindow } from './inbox-visibility';
import { renderSevereEventEmitter } from '../../severe-event-emitter';
import { sectionsToText } from './message-fields';
import { chunkOverCapMessage } from './tools/send-chunking';

type InboxEntry = Record<string, unknown> & { msg_id: string };

describe('changed system notice delivery', () => {
  const alarm = (over: Record<string, unknown> = {}) => ({
    msg_id: 'alarm', ts: '2026-10-13T00:00:00Z', from: 'system-watchdog',
    to: ['*'], auto: true, kind: 'message', category: 'severe-event',
    condition_key: 'compaction:other', summary: 'Compaction over-limit: other',
    body: 'Context 200000 tokens', ...over,
  });

  it('suppresses unchanged notices across separate reads, preserving peers and directed alerts', () => {
    const first = changedSystemNoticeDelivery([alarm()], {});
    const rows = [alarm({ msg_id: 'later', ts: '2026-10-13T00:01:00Z' }),
      alarm({ to: ['*', 'reader'] }), alarm({ to: ['reader'] }), alarm({ auto: false })];
    const next = changedSystemNoticeDelivery(rows, first.state);
    expect(first.entries).toHaveLength(1);
    expect(next.entries).toEqual(rows.slice(1));
    expect(next.suppressed).toBe(1);
  });

  it('delivers changed body, resolution and recurrence of the same condition', () => {
    const first = changedSystemNoticeDelivery([alarm()], {});
    const changed = changedSystemNoticeDelivery([alarm({ body: 'Context 250000 tokens' })], first.state);
    const resolved = changedSystemNoticeDelivery([alarm({ category: 'severe-event-resolved', resolved: true })], changed.state);
    const recurrence = changedSystemNoticeDelivery([alarm()], resolved.state);
    expect([changed, resolved, recurrence].map((r) => r.entries.length)).toEqual([1, 1, 1]);
  });

  it('ignores the writer emitter uptime trailer but delivers a new emitting process', () => {
    const emitter = { pid: 1, startedAt: '2026-10-13T00:00:00Z', uptimeSec: 10, cwd: '/repo' };
    const first = changedSystemNoticeDelivery([alarm({ emitter, body: 'Same' + renderSevereEventEmitter(emitter) })], {});
    const older = { ...emitter, uptimeSec: 5000 };
    expect(changedSystemNoticeDelivery([alarm({ emitter: older, body: 'Same' + renderSevereEventEmitter(older) })], first.state).suppressed).toBe(1);
    const restarted = { ...older, pid: 2 };
    expect(changedSystemNoticeDelivery([alarm({ emitter: restarted, body: 'Same' + renderSevereEventEmitter(restarted) })], first.state).entries).toHaveLength(1);
  });

  it('does not remember a notice omitted by the rendered line bound', () => {
    const rows = [alarm(), alarm({ ts: '2026-10-13T00:01:00Z', condition_key: 'new' })];
    const first = changedSystemNoticeDelivery(rows, {}, 1);
    expect(changedSystemNoticeDelivery([rows[0]!], first.state).entries).toHaveLength(1);
    expect(changedSystemNoticeDelivery([rows[1]!], first.state).entries).toHaveLength(0);
  });

  it('bounds durable state and re-delivers on missing or malformed state', () => {
    const rows = Array.from({ length: 300 }, (_, n) => alarm({ condition_key: `condition:${n}` }));
    expect(Object.keys(changedSystemNoticeDelivery(rows, {}).state)).toHaveLength(256);
    expect(changedSystemNoticeDelivery([alarm()], null).entries).toHaveLength(1);
    expect(changedSystemNoticeDelivery([alarm()], { bad: 1 }).entries).toHaveLength(1);
  });
});

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
