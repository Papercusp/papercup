import { describe, expect, it } from 'vitest';
import { changedSystemNoticeDelivery, coalesceRepeatedBroadcasts, relevantSystemNoticeDelivery, prioritizedInboxWindow,
  systemNoticeIdentity, systemNoticeReplayState, systemNoticeReplayDue, systemNoticeReplayCandidates } from './inbox-visibility';
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

  it('retains exact notice references until stdout proof, then wakes at the original reminder boundary', () => {
    const row = alarm();
    const identity = systemNoticeIdentity(row)!;
    const now = 10000;
    const cadence = 5000;
    const pending = systemNoticeReplayState([row], {}, now, cadence);
    expect(pending.candidates).toEqual([{ msgId: 'alarm', ...identity,
      fingerprint: systemNoticeIdentity(row, cadence)!.fingerprint }]);
    expect(systemNoticeReplayDue(pending, now)).toBe(true);
    expect(JSON.stringify(pending)).not.toContain(row.body);
    const proof = { [identity.key]: { fingerprint: systemNoticeIdentity(row, cadence)!.fingerprint, emittedAt: now } };
    const confirmed = systemNoticeReplayState([row], proof, now + 1, cadence);
    expect(confirmed.nextCheckAt).toBe(now + cadence);
    expect(systemNoticeReplayDue(confirmed, now + cadence - 1)).toBe(false);
    expect(systemNoticeReplayDue(confirmed, now + cadence)).toBe(true);
    // Repeated selections cannot restart the proven timer.
    expect(systemNoticeReplayState([row], proof, now + cadence - 1, cadence).nextCheckAt).toBe(now + cadence);
    expect(systemNoticeReplayState([row], proof, now + cadence, cadence).nextCheckAt).toBe(0);
  });

  it('keeps only the latest source row per episode and retires resolved alarms', () => {
    const newer = alarm({ msg_id: 'new', ts: '2026-10-13T00:01:00Z', state_version: 2 });
    const selected = systemNoticeReplayState([newer, alarm()], {}, 10000);
    expect(selected.candidates).toEqual([{ msgId: 'new', ...systemNoticeIdentity(newer)! }]);
    expect(systemNoticeReplayState([{ ...newer, resolved: true }], {}, 10000).candidates).toEqual([]);
    expect(systemNoticeReplayState([alarm({ category: 'severe-event-resolved' })], {}, 10000).candidates).toEqual([]);
    expect(systemNoticeReplayCandidates({ version: 1, candidates: [{ msgId: 'forged' }] })).toEqual([]);
  });

  it('marks bounded reference overflow for timestamp replay instead of claiming those rows delivered', () => {
    const rows = Array.from({ length: 257 }, (_, n) => alarm({ msg_id: `row-${n}`, condition_key: `condition:${n}` }));
    const replay = systemNoticeReplayState(rows, {}, 10000);
    expect(replay.candidates).toHaveLength(256);
    expect(replay.overflow).toBe(true);
    expect(systemNoticeReplayDue(replay, 10000)).toBe(true);
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

  it('uses only proven emission time and the exact configured cadence for reminders', () => {
    const row = alarm();
    const cadence = 30 * 60_000;
    const identity = systemNoticeIdentity(row, cadence)!;
    const emittedAt = 1_000_000;
    const proven = { [identity.key]: { fingerprint: identity.fingerprint, emittedAt } };
    const read = (now: number, previous: unknown = proven, reminderMs = cadence) =>
      changedSystemNoticeDelivery([row], previous, 8, { now, reminderMs });
    expect(read(emittedAt + cadence - 1).entries).toEqual([]);
    expect(read(emittedAt + cadence).entries).toEqual([row]);
    // Repeated preparations/arrival ACKs cannot move the proven reminder time.
    const attempted = read(emittedAt + cadence);
    expect(read(emittedAt + cadence + 1, attempted.state).entries).toEqual([row]);
    expect(read(emittedAt + cadence + 1).entries).toEqual([row]);
    expect(read(emittedAt - 1).entries).toEqual([row]);
    expect(read(emittedAt + 1, proven, cadence * 2).entries).toEqual([row]);
    const legacy = changedSystemNoticeDelivery([row], {}).state;
    expect(read(emittedAt + 1, legacy).entries).toEqual([row]);
    expect(changedSystemNoticeDelivery([alarm({ state_version: 'new' })], proven, 8,
      { now: emittedAt + 1, reminderMs: cadence }).entries).toHaveLength(1);
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

  it('delivers blocking and reply-bearing broadcasts on every read', () => {
    const rows = [alarm({ blocking: true }), alarm({ expects: 'action' }), alarm({ expects: 'answer' })];
    const first = changedSystemNoticeDelivery(rows, {});
    expect(changedSystemNoticeDelivery(rows, first.state).entries).toEqual(rows);
  });

  it.each(['source', 'object_ref', 'severity', 'state_version', 'event_key'])(
    'preserves a changed structured %s despite identical rendered prose', (field) => {
      const initial = alarm({ source: 'detector-a', object_ref: 'WI-1', severity: 'info',
        state_version: 'v1', event_key: 'episode-a' });
      const first = changedSystemNoticeDelivery([initial], {});
      const changed = { ...initial, msg_id: 'changed', [field]: `${field}-changed` };
      expect(changedSystemNoticeDelivery([changed], first.state).entries).toEqual([changed]);
      expect(coalesceRepeatedBroadcasts([initial, changed])).toEqual([initial, changed]);
    },
  );

  it('keeps critical producer data through relevance and repeat filtering', () => {
    const data = { severity: 'critical', state_version: 1, object_ref: 'WI-other' };
    const critical = alarm({ data });
    const scope = { ownerId: 'reader', workItemIds: ['WI-mine'] };
    expect(relevantSystemNoticeDelivery([critical], scope).entries).toEqual([critical]);
    const first = changedSystemNoticeDelivery([critical], {});
    expect(changedSystemNoticeDelivery([critical], first.state).entries).toEqual([critical]);
    const changed = { ...critical, data: { ...data, state_version: 2 } };
    expect(coalesceRepeatedBroadcasts([critical, changed])).toEqual([critical, changed]);
  });
});

describe('native system notice relevance', () => {
  const scope = { ownerId: 'su-reader', workItemIds: ['WI-123'], planSlug: 'my-plan',
    files: ['packages/owned.ts'], fleetSlug: 'my-fleet' };
  const notice = (over: Record<string, unknown> = {}) => ({
    auto: true, kind: 'message', to: ['*'], category: 'severe-event',
    summary: 'Compaction over-limit: su-other', ...over,
  });

  it('keeps exact owner, held item, plan, file and fleet subjects', () => {
    const relevant = ['su-reader', 'WI-123', 'my-plan', 'packages/owned.ts:12', '@fleet:my-fleet']
      .map(summary => notice({ summary }));
    const rows = [notice(), ...relevant, notice({ summary: 'global ungraded backlog' })];
    expect(relevantSystemNoticeDelivery(rows, scope)).toEqual({ entries: relevant, excluded: 2 });
  });

  it('uses structured references and rejects prefix collisions and producer cwd', () => {
    const structured = notice({ why: { goalRef: 'WI-123' } });
    const rows = [structured, notice({ summary: 'WI-1234 my-plan-old other/packages/owned.ts' }),
      notice({ emitter: { cwd: 'packages/owned.ts' } })];
    expect(relevantSystemNoticeDelivery(rows, scope)).toEqual({ entries: [structured], excluded: 2 });
  });

  it('preserves directed, mixed, peer, lifecycle, malformed and blocking delivery', () => {
    const rows = [notice({ to: ['su-reader'] }), notice({ to: ['*', 'su-other'] }),
      notice({ auto: false }), notice({ lifecycle: 'intent' }), notice({ to: null }),
      notice({ blocking: true }), notice({ expects: 'answer' }), notice({ expects: 'ack' })];
    expect(relevantSystemNoticeDelivery(rows, scope)).toEqual({ entries: rows, excluded: 0 });
  });

  it('fails open when scope is unavailable and re-delivers when the subject enters scope', () => {
    const rows = [notice({ condition_key: 'work-item:WI-999' })];
    expect(relevantSystemNoticeDelivery(rows, null).entries).toEqual(rows);
    const outside = relevantSystemNoticeDelivery(rows, scope);
    const prior = changedSystemNoticeDelivery(outside.entries, {});
    const now = relevantSystemNoticeDelivery(rows, { ...scope, workItemIds: ['WI-999'] });
    expect(changedSystemNoticeDelivery(now.entries, prior.state).entries).toEqual(rows);
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
