/**
 * WI-6658 — coord:roster needs a CHEAP projection, because the token cost of the
 * full read is what pushes agents to hand-query `coord_presence` for liveness —
 * the one place the verdict does not exist as a column (the defect closed in
 * EI-18801042715296007).
 *
 * Measured on this box before building (132-row workspace roster):
 *   full view=live payload ......... 135,427 chars  (~33.9k tokens, 37 keys/row)
 *   project:'liveness' ............. 10,632 chars  (~2.7k tokens)   -92%
 *   project:'ids' ..................  5,894 chars  (~1.5k tokens)   -96%
 *   project:'liveness' + states:live .. 692 chars  (~173 tokens)  -99.5%
 *
 * That measurement is why BOTH levers exist: at a ~1500-token per-result budget
 * the projection ALONE still overflows and comes back truncated, so it would
 * hand back a PARTIAL roster that reads like a complete answer. Only the
 * projection + state filter returns a whole, trustworthy one.
 *
 * These are pure-function tests: the projection deliberately operates on the
 * OUTPUT of assemblePresenceSnapshot, so it needs no IO seam — which is the
 * design property test 4 pins.
 */

import { describe, it, expect } from 'vitest';
import { projectRosterRows, filterRosterRowsByState } from './presence-snapshot';

/** A roster shaped like the real emitted payload: the wide row is what makes the
 *  full read expensive, and the null-state row is the federated peer. */
const rows: Record<string, unknown>[] = [
  {
    ownerId: 'su-aaa',
    ownerLabel: 'su · aaa',
    sessionState: 'live',
    confirmLiveness: false,
    wakeable: true,
    intent: 'a long declared intent string that is part of why the full row is ~1KB',
    currentPlanSlug: 'some-plan-2026-07-28',
    claimedItems: ['WI-1', 'WI-2'],
    heartbeatAt: '2026-07-28T13:00:00.000Z',
    contextPressure: 'ok',
  },
  {
    ownerId: 'su-bbb',
    ownerLabel: 'su · bbb',
    sessionState: 'parked',
    confirmLiveness: false,
    wakeable: true,
    intent: 'another long intent',
    claimedItems: [],
  },
  {
    ownerId: 'su-ccc',
    ownerLabel: 'su · ccc',
    sessionState: 'suspect',
    confirmLiveness: true,
    wakeable: false,
    intent: 'draining maybe',
  },
  {
    // A federated peer: no LOCAL wakeability entry, so the oracle derives no
    // verdict and sessionState is emitted as null.
    ownerId: 'su-fed',
    ownerLabel: 'su · fed',
    sessionState: null,
    confirmLiveness: null,
    federated: true,
  },
];

describe('projectRosterRows', () => {
  it("project:'full' is the untouched default — the same array, not a copy", () => {
    // Referential identity is the crisp guard that the DEFAULT read path applies
    // zero transformation, so existing callers stay byte-identical.
    expect(projectRosterRows(rows, 'full')).toBe(rows);
  });

  it("project:'ids' emits ownerIds as bare strings", () => {
    expect(projectRosterRows(rows, 'ids')).toEqual(['su-aaa', 'su-bbb', 'su-ccc', 'su-fed']);
  });

  it("project:'liveness' emits ownerId + sessionState and drops everything else", () => {
    const out = projectRosterRows(rows, 'liveness') as Record<string, unknown>[];
    expect(out[0]).toEqual({ ownerId: 'su-aaa', sessionState: 'live' });
    expect(out[1]).toEqual({ ownerId: 'su-bbb', sessionState: 'parked' });
    // the expensive fields are gone
    expect(out[0]).not.toHaveProperty('intent');
    expect(out[0]).not.toHaveProperty('claimedItems');
    expect(out[0]).not.toHaveProperty('wakeable');
  });

  it("project:'liveness' keeps confirmLiveness ONLY when it is set", () => {
    const out = projectRosterRows(rows, 'liveness') as Record<string, unknown>[];
    // false/null must not widen the common row...
    expect(out[0]).not.toHaveProperty('confirmLiveness');
    expect(out[3]).not.toHaveProperty('confirmLiveness');
    // ...but a real nudge must survive the projection, or the lens would hide
    // exactly the rows a coordinator must not trust at face value.
    expect(out[2]).toEqual({ ownerId: 'su-ccc', sessionState: 'suspect', confirmLiveness: true });
  });

  it('projects the ORACLE verdict verbatim — it never re-derives one', () => {
    // The load-bearing anti-divergence property. sessionState is assembled from
    // six legs (two not in Postgres), so the ONLY safe cheap path is emitting
    // fewer fields of the same verdict. Every emitted state must be identical to
    // the input's — including the federated null, which must NOT be coerced into
    // a guess like 'ended'.
    const out = projectRosterRows(rows, 'liveness') as Record<string, unknown>[];
    expect(out.map((r) => r.sessionState)).toEqual(rows.map((r) => r.sessionState));
    expect(out[3].sessionState).toBeNull();
  });

  it('is dramatically smaller — the whole point of the item', () => {
    const full = JSON.stringify(projectRosterRows(rows, 'full')).length;
    const liveness = JSON.stringify(projectRosterRows(rows, 'liveness')).length;
    const ids = JSON.stringify(projectRosterRows(rows, 'ids')).length;
    expect(liveness).toBeLessThan(full * 0.5);
    expect(ids).toBeLessThan(liveness);
  });
});

describe('filterRosterRowsByState', () => {
  it('is a pass-through when no states are given (same array, nothing excluded)', () => {
    expect(filterRosterRowsByState(rows, undefined)).toEqual({ rows, unknownStateExcluded: 0 });
    expect(filterRosterRowsByState(rows, [])).toEqual({ rows, unknownStateExcluded: 0 });
  });

  it('keeps only the requested states', () => {
    const { rows: out } = filterRosterRowsByState(rows, ['live']);
    expect(out.map((r) => r.ownerId)).toEqual(['su-aaa']);
  });

  it('accepts several states', () => {
    const { rows: out } = filterRosterRowsByState(rows, ['live', 'parked']);
    expect(out.map((r) => r.ownerId)).toEqual(['su-aaa', 'su-bbb']);
  });

  it('REPORTS the unknown-state rows it excluded rather than dropping them silently', () => {
    // The honesty property. A federated peer has no derivable verdict, so it
    // matches no filter — but an empty/short result must never be confusable
    // with "there are no live peers". That confusion is the same failure mode as
    // steering a liveness question onto a keepalive column.
    const { rows: out, unknownStateExcluded } = filterRosterRowsByState(rows, ['live']);
    expect(out).toHaveLength(1);
    expect(unknownStateExcluded).toBe(1);
  });

  it('reports zero excluded when every row has a derived state', () => {
    const allKnown = rows.filter((r) => r.sessionState !== null);
    const { unknownStateExcluded } = filterRosterRowsByState(allKnown, ['live']);
    expect(unknownStateExcluded).toBe(0);
  });

  it('composes with the projection to answer "which owners are live?" cheaply', () => {
    const { rows: live } = filterRosterRowsByState(rows, ['live']);
    const projected = projectRosterRows(live, 'liveness');
    expect(projected).toEqual([{ ownerId: 'su-aaa', sessionState: 'live' }]);
    // the composed answer is a rounding error next to the full read
    const full = JSON.stringify(projectRosterRows(rows, 'full')).length;
    expect(JSON.stringify(projected).length).toBeLessThan(full * 0.1);
  });
});
