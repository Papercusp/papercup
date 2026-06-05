import { describe, it, expect } from 'vitest';
import { rankFleetFeed } from './feed';
import type { FleetSignal } from '../../curation/salience-policy';

function sig(
  p: Partial<FleetSignal> & Pick<FleetSignal, 'id' | 'kind' | 'title' | 'ts'>,
): FleetSignal {
  return { ...p } as FleetSignal;
}

// Newest-first (the shape gatherFleetSignals returns).
const signals: FleetSignal[] = [
  sig({ id: 'p1', kind: 'progress', title: 'routine', ts: '2026-06-04T05:00:00Z' }),
  sig({ id: 'd1', kind: 'decision', title: 'review owed', ts: '2026-06-04T04:00:00Z', harness: 'papercup' }),
  sig({ id: 'b1', kind: 'blocker', title: 'blocked!', ts: '2026-06-04T03:00:00Z' }),
  sig({ id: 'c1', kind: 'completion', title: 'fleet-internal done', ts: '2026-06-04T02:00:00Z' }),
  sig({ id: 'c2', kind: 'completion', title: 'user work done', ts: '2026-06-04T01:00:00Z', userRequested: true }),
  sig({ id: 'e1', kind: 'escalation', title: 'esc', ts: '2026-06-04T00:00:00Z', harness: 'restart' }),
];

describe('rankFleetFeed', () => {
  it('classifies each signal by base disposition + urgency (no idempotency overlay)', () => {
    const byId = Object.fromEntries(rankFleetFeed(signals).map((r) => [r.id, r]));
    expect(byId.b1.disposition).toBe('surface');
    expect(byId.b1.urgent).toBe(true);
    expect(byId.e1.urgent).toBe(true);
    expect(byId.d1.disposition).toBe('surface');
    expect(byId.d1.urgent).toBe(false);
    expect(byId.c2.disposition).toBe('surface'); // user-requested completion → surface
    expect(byId.c1.disposition).toBe('batch'); // fleet-internal completion → batch
    expect(byId.p1.disposition).toBe('batch'); // routine progress → batch
  });

  it('ranks urgent first, then surface-before-batch, then recency (stable)', () => {
    const rows = rankFleetFeed(signals);
    // Urgent (blocker b1, escalation e1) lead; within the tier, input recency
    // (b1 newer than e1) is preserved by the stable sort.
    expect(rows[0].id).toBe('b1');
    expect(rows[1].id).toBe('e1');
    // Non-urgent surface (decision d1, user-completion c2) before any batch.
    const surfaceNonUrgent = rows.filter((r) => r.disposition === 'surface' && !r.urgent).map((r) => r.id);
    expect(surfaceNonUrgent).toEqual(['d1', 'c2']);
    expect(rows[rows.length - 1].disposition).toBe('batch');
  });

  it('surfaceOnly drops the batch signals', () => {
    const rows = rankFleetFeed(signals, { surfaceOnly: true });
    expect(rows.every((r) => r.disposition === 'surface')).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual(['b1', 'c2', 'd1', 'e1']);
  });

  it('harness filter scopes to one project', () => {
    expect(rankFleetFeed(signals, { harness: 'papercup' }).map((r) => r.id)).toEqual(['d1']);
  });

  it('limit caps the result', () => {
    expect(rankFleetFeed(signals, { limit: 2 })).toHaveLength(2);
  });

  it('empty in → empty out', () => {
    expect(rankFleetFeed([])).toEqual([]);
  });
});
