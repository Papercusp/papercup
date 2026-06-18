/**
 * handoffs.test.ts — a handoff's accepted/open state is DERIVED by pairing each
 * `handoff` with its sibling `handoff_accepted` (by related_msg_id). A bug shows a
 * handoff as unclaimed when it was accepted (double-pickup) or hides an open one.
 * Pinned: isHandoffRecord guard, the pairing, status filtering, and (ts,msg_id)
 * ordering. Only `handoff` kinds become top-level items (acceptances are overlays).
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/handoffs.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isHandoffRecord, foldHandoffs } from './handoffs';
import type { HandoffRecord } from './handoffs';
import type { CoordEnvelope } from './envelope';

const h = (msg_id: string, ts: string): HandoffRecord =>
  ({ msg_id, ts, kind: 'handoff', from: 'a', to: ['b'], plan_slug: 'p', summary: 's' }) as HandoffRecord;
const acc = (msg_id: string, ts: string, related: string): HandoffRecord =>
  ({ msg_id, ts, kind: 'handoff_accepted', from: 'b', to: ['a'], related_msg_id: related }) as HandoffRecord;

describe('isHandoffRecord', () => {
  it('accepts handoff + handoff_accepted, rejects other kinds', () => {
    expect(isHandoffRecord(h('h1', 't1'))).toBe(true);
    expect(isHandoffRecord(acc('a1', 't2', 'h1'))).toBe(true);
    expect(isHandoffRecord({ kind: 'message' } as unknown as CoordEnvelope)).toBe(false);
  });
});

describe('foldHandoffs', () => {
  it('pairs a handoff with its acceptance and leaves an unaccepted one open', () => {
    const out = foldHandoffs([h('h1', 't1'), acc('a1', 't3', 'h1'), h('h2', 't2')]);
    expect(out).toHaveLength(2); // only the two `handoff` kinds are top-level items
    expect(out.find((x) => x.record.msg_id === 'h1')?.accepted_by?.msg_id).toBe('a1');
    expect(out.find((x) => x.record.msg_id === 'h2')?.accepted_by).toBeUndefined();
  });

  it('status:"open" keeps only unaccepted; status:"accepted" keeps only accepted', () => {
    const recs = [h('h1', 't1'), acc('a1', 't3', 'h1'), h('h2', 't2')];
    expect(foldHandoffs(recs, { status: 'open' }).map((x) => x.record.msg_id)).toEqual(['h2']);
    expect(foldHandoffs(recs, { status: 'accepted' }).map((x) => x.record.msg_id)).toEqual(['h1']);
  });

  it('sorts handoffs ascending by (ts, msg_id)', () => {
    const out = foldHandoffs([h('b', '2026-01-01T00:00:02Z'), h('a', '2026-01-01T00:00:01Z')]);
    expect(out.map((x) => x.record.msg_id)).toEqual(['a', 'b']);
  });
});
