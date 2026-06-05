/**
 * Unit tests for coord-core — the pure protocol layer. No fs, no DB.
 */

import { describe, expect, it } from 'vitest';
import {
  newMsgId,
  compareByTsThenId,
  patternToRegex,
  matchesPattern,
  emptyWatermark,
  normaliseWatermark,
  mergeWatermark,
  foldThread,
  filterInbox,
  foldHandoffs,
  foldEscalations,
  foldResolved,
  indexResolves,
  filterPlanEvents,
  findUnknownFromItems,
  type CoordEnvelope,
  type HandoffRecord,
  type EscalationRecord,
  type EscalationResolvedEvent,
} from './index';

function env(p: Partial<CoordEnvelope> & Pick<CoordEnvelope, 'msg_id' | 'kind'>): CoordEnvelope {
  return { ts: '2026-01-01T00:00:00.000Z', from: 'A', to: ['*'], summary: '', ...p } as CoordEnvelope;
}

describe('newMsgId', () => {
  it('is lex-monotonic within a process even in the same ms', () => {
    const ids = Array.from({ length: 50 }, () => newMsgId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });
});

describe('glob', () => {
  it('** crosses /, * does not', () => {
    expect(matchesPattern('apps/**', 'apps/operator/lib/x.ts')).toBe(true);
    expect(matchesPattern('apps/*', 'apps/operator/lib/x.ts')).toBe(false);
    expect(matchesPattern('apps/*', 'apps/operator')).toBe(true);
  });
  it('escapes regex specials', () => {
    expect(matchesPattern('a.b+c', 'a.b+c')).toBe(true);
    expect(matchesPattern('a.b+c', 'aXbYc')).toBe(false);
    expect(patternToRegex('x.ts').source).toBe('^x\\.ts$');
  });
});

describe('watermark', () => {
  it('mergeWatermark keeps current for omitted fields, replaces fired list', () => {
    const cur = { ...emptyWatermark(), messages_since_ts: 't1', subscriptions_fired: ['a'] };
    const next = mergeWatermark(cur, { escalations_since_ts: 't2', subscriptions_fired: ['b', 'c'] });
    expect(next.messages_since_ts).toBe('t1');
    expect(next.escalations_since_ts).toBe('t2');
    expect(next.subscriptions_fired).toEqual(['b', 'c']);
  });
  it('normaliseWatermark repairs malformed input', () => {
    expect(normaliseWatermark(null)).toEqual(emptyWatermark());
    expect(normaliseWatermark({ messages_since_ts: 5 as unknown as string })).toEqual(emptyWatermark());
    expect(normaliseWatermark({ subscriptions_fired: ['ok', 3 as unknown as string] }).subscriptions_fired).toEqual(['ok']);
  });
});

describe('foldThread', () => {
  it('collects the connected related_msg_id component', () => {
    const all = [
      env({ msg_id: 'm1', kind: 'message' }),
      env({ msg_id: 'm2', kind: 'ack', related_msg_id: 'm1' }),
      env({ msg_id: 'm3', kind: 'message', related_msg_id: 'm2' }),
      env({ msg_id: 'x9', kind: 'message' }), // unrelated
    ];
    expect(foldThread(all, 'm1').map((l) => l.msg_id)).toEqual(['m1', 'm2', 'm3']);
    expect(foldThread(all, 'm3').map((l) => l.msg_id)).toEqual(['m1', 'm2', 'm3']);
    expect(foldThread(all, 'x9').map((l) => l.msg_id)).toEqual(['x9']);
  });
});

describe('filterInbox', () => {
  const lines = [
    env({ msg_id: 'a', kind: 'message', from: 'A', to: ['B'] }),
    env({ msg_id: 'b', kind: 'message', from: 'C', to: ['*'] }),
    env({ msg_id: 'c', kind: 'notify', from: 'C', to: ['B'] }),
    env({ msg_id: 'd', kind: 'message', from: 'B', to: ['B'] }), // own
  ];
  it('selects to-me + broadcast, excludes own + the notify firehose by default', () => {
    // 'c' is a notify — excluded by default per D-002 (the firehose is opt-in);
    // 'd' is own (from B) — excluded. So only the to-me message + broadcast.
    expect(filterInbox(lines, 'B').map((l) => l.msg_id)).toEqual(['a', 'b']);
  });
  it('honours excludeOwn=false and kind filter', () => {
    // excludeOwn:false re-includes own ('d'); notify ('c') is still default-excluded.
    expect(filterInbox(lines, 'B', { excludeOwn: false }).map((l) => l.msg_id).sort()).toEqual(['a', 'b', 'd']);
    // kinds:['notify'] opts INTO the firehose — only the notify.
    expect(filterInbox(lines, 'B', { kinds: ['notify'] }).map((l) => l.msg_id)).toEqual(['c']);
  });
});

describe('foldHandoffs', () => {
  const recs: HandoffRecord[] = [
    { ...env({ msg_id: 'h1', kind: 'handoff', ts: '2026-01-01T00:00:01.000Z' }), kind: 'handoff' },
    { ...env({ msg_id: 'h2', kind: 'handoff', ts: '2026-01-01T00:00:02.000Z' }), kind: 'handoff' },
    { ...env({ msg_id: 'a1', kind: 'handoff_accepted', related_msg_id: 'h1' }), kind: 'handoff_accepted' },
  ];
  it('pairs handoff with acceptance and filters by status', () => {
    expect(foldHandoffs(recs).map((x) => x.record.msg_id)).toEqual(['h1', 'h2']);
    expect(foldHandoffs(recs, { status: 'accepted' }).map((x) => x.record.msg_id)).toEqual(['h1']);
    expect(foldHandoffs(recs, { status: 'open' }).map((x) => x.record.msg_id)).toEqual(['h2']);
    expect(foldHandoffs(recs)[0]?.accepted_by?.msg_id).toBe('a1');
  });
});

describe('foldEscalations', () => {
  const opens: EscalationRecord[] = [
    { ...env({ msg_id: 'e1', kind: 'escalation', to: ['human'] }), kind: 'escalation', severity: 'question', resolved: null },
    { ...env({ msg_id: 'e2', kind: 'escalation', to: ['human'] }), kind: 'escalation', severity: 'blocker', resolved: null },
  ];
  const resolves: EscalationResolvedEvent[] = [
    { ...env({ msg_id: 'r1', kind: 'escalation_resolved', related_msg_id: 'e1' }), kind: 'escalation_resolved', related_msg_id: 'e1', choice: 'ok', note: 'n', by: 'human' },
  ];
  it('overlays resolution and filters by status', () => {
    expect(foldEscalations(opens, resolves, { status: 'resolved' }).map((e) => e.msg_id)).toEqual(['e1']);
    expect(foldEscalations(opens, resolves, { status: 'open' }).map((e) => e.msg_id)).toEqual(['e2']);
    const folded = foldEscalations(opens, resolves).find((e) => e.msg_id === 'e1');
    expect(folded?.resolved).toEqual({ choice: 'ok', ts: resolves[0].ts, by: 'human', note: 'n' });
  });
  it('first resolve wins on a double-resolve', () => {
    const dup: EscalationResolvedEvent[] = [
      { ...env({ msg_id: 'rB', kind: 'escalation_resolved', ts: '2026-01-01T00:00:09.000Z', related_msg_id: 'e1' }), kind: 'escalation_resolved', related_msg_id: 'e1', choice: 'second' },
      { ...env({ msg_id: 'rA', kind: 'escalation_resolved', ts: '2026-01-01T00:00:01.000Z', related_msg_id: 'e1' }), kind: 'escalation_resolved', related_msg_id: 'e1', choice: 'first' },
    ];
    expect(indexResolves(dup).get('e1')?.choice).toBe('first');
  });
  it('foldResolved with no event yields null', () => {
    expect(foldResolved(opens[0], undefined).resolved).toBeNull();
  });
});

describe('filterPlanEvents', () => {
  const lines = [
    env({ msg_id: 'p1', kind: 'plan_event', plan_slug: 'x', event: 'created' }),
    env({ msg_id: 'p2', kind: 'plan_event', plan_slug: 'y', event: 'promoted' }),
    env({ msg_id: 'm1', kind: 'message' }),
  ];
  it('keeps plan_event kinds and applies slug/event filters', () => {
    expect(filterPlanEvents(lines).map((l) => l.msg_id)).toEqual(['p1', 'p2']);
    expect(filterPlanEvents(lines, { planSlugs: ['y'] }).map((l) => l.msg_id)).toEqual(['p2']);
    expect(filterPlanEvents(lines, { events: ['created'] }).map((l) => l.msg_id)).toEqual(['p1']);
  });
});

describe('findUnknownFromItems', () => {
  it('returns sorted unknown from_items', () => {
    expect(
      findUnknownFromItems([{ from_items: ['P-002', 'P-001'] }, { from_items: ['P-003'] }], ['P-001']),
    ).toEqual(['P-002', 'P-003']);
    expect(findUnknownFromItems([{ from_items: ['P-001'] }], ['P-001'])).toEqual([]);
  });
});

describe('compareByTsThenId', () => {
  it('orders by ts then msg_id', () => {
    const a = env({ msg_id: 'b', kind: 'message', ts: '2026-01-01T00:00:00.000Z' });
    const b = env({ msg_id: 'a', kind: 'message', ts: '2026-01-01T00:00:01.000Z' });
    expect([b, a].sort(compareByTsThenId).map((l) => l.msg_id)).toEqual(['b', 'a']);
  });
});
