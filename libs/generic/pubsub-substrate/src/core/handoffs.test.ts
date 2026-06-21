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
const exp = (msg_id: string, ts: string, related: string): HandoffRecord =>
  ({ msg_id, ts, kind: 'handoff_expired', from: 'system:handoff-reconcile', to: ['a'], related_msg_id: related }) as HandoffRecord;
const rep = (msg_id: string, ts: string, related: string): HandoffRecord =>
  ({ msg_id, ts, kind: 'handoff_repinged', from: 'system:handoff-reconcile', to: ['a'], related_msg_id: related }) as HandoffRecord;

describe('isHandoffRecord', () => {
  it('accepts handoff + handoff_accepted + handoff_expired + handoff_repinged, rejects other kinds', () => {
    expect(isHandoffRecord(h('h1', 't1'))).toBe(true);
    expect(isHandoffRecord(acc('a1', 't2', 'h1'))).toBe(true);
    expect(isHandoffRecord(exp('e1', 't2', 'h1'))).toBe(true);
    expect(isHandoffRecord(rep('r1', 't2', 'h1'))).toBe(true);
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

describe('foldHandoffs — expiry (F-FIX-037)', () => {
  it('pairs a handoff with its expiry; status:"open" excludes expired; status:"expired" returns it', () => {
    const recs = [h('h1', 't1'), h('h2', 't2'), exp('e2', 't3', 'h2')];
    const all = foldHandoffs(recs);
    expect(all.find((x) => x.record.msg_id === 'h2')?.expired_by?.msg_id).toBe('e2');
    expect(foldHandoffs(recs, { status: 'open' }).map((x) => x.record.msg_id)).toEqual(['h1']); // h2 expired → not open
    expect(foldHandoffs(recs, { status: 'expired' }).map((x) => x.record.msg_id)).toEqual(['h2']);
  });

  it('acceptance DOMINATES expiry: an accepted+expired handoff is accepted, never open/expired', () => {
    const recs = [h('h1', 't1'), acc('a1', 't2', 'h1'), exp('e1', 't3', 'h1')];
    expect(foldHandoffs(recs, { status: 'open' })).toHaveLength(0);
    expect(foldHandoffs(recs, { status: 'expired' })).toHaveLength(0);
    expect(foldHandoffs(recs, { status: 'accepted' }).map((x) => x.record.msg_id)).toEqual(['h1']);
  });
});

describe('foldHandoffs — re-ping (coord-dispatch-reliability P-003)', () => {
  it('surfaces repinged_by on the paired handoff', () => {
    const recs = [h('h1', 't1'), h('h2', 't2'), rep('r2', 't3', 'h2')];
    const all = foldHandoffs(recs);
    expect(all.find((x) => x.record.msg_id === 'h2')?.repinged_by?.msg_id).toBe('r2');
    expect(all.find((x) => x.record.msg_id === 'h1')?.repinged_by).toBeUndefined();
  });

  it('a re-ping is NOT a terminal status: a re-pinged-but-unaccepted handoff stays OPEN', () => {
    const recs = [h('h1', 't1'), rep('r1', 't2', 'h1')];
    // still open (the re-ping only nudges the offerer) — and carries the marker.
    expect(foldHandoffs(recs, { status: 'open' }).map((x) => x.record.msg_id)).toEqual(['h1']);
    expect(foldHandoffs(recs, { status: 'open' })[0].repinged_by?.msg_id).toBe('r1');
    // a re-ping alone never makes it accepted/expired.
    expect(foldHandoffs(recs, { status: 'accepted' })).toHaveLength(0);
    expect(foldHandoffs(recs, { status: 'expired' })).toHaveLength(0);
  });

  it('a handoff can be both re-pinged and then accepted: acceptance still wins', () => {
    const recs = [h('h1', 't1'), rep('r1', 't2', 'h1'), acc('a1', 't3', 'h1')];
    const open = foldHandoffs(recs, { status: 'open' });
    expect(open).toHaveLength(0); // accepted → no longer open
    const accepted = foldHandoffs(recs, { status: 'accepted' });
    expect(accepted.map((x) => x.record.msg_id)).toEqual(['h1']);
    expect(accepted[0].repinged_by?.msg_id).toBe('r1'); // marker still surfaced
    expect(accepted[0].accepted_by?.msg_id).toBe('a1');
  });
});
