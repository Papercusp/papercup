/**
 * Unit tests for the PURE half of condition-object.ts (P-001 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * No database: the claim-state decision is deliberately separated from the query
 * so its edge cases are testable directly, and `nowMs` is injected so the
 * lease-expiry boundary needs no sleeping (a test that sleeps to cross a real
 * deadline is a test that flakes in CI).
 *
 * The case that earns most of this file is `held` vs `lease-expired`. Both have a
 * non-null `takenBy`, so a reader that treats "someone is on it" as
 * `takenBy != null` reports a dead agent's abandoned lease as live ownership —
 * strictly worse than reporting no owner, because it suppresses the next agent
 * from picking the condition up. That is the failure the enum exists to prevent,
 * so it is pinned here rather than left to the caller.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveConditionObject,
  claimStateOf,
  leaseExpired,
  CONDITION_LINK_REL,
  type ConditionWorkItemRow,
} from './condition-object';

const NOW = Date.parse('2026-08-03T01:00:00.000Z');
const KEY = 'green-stall:papercusp';

function row(over: Partial<ConditionWorkItemRow> = {}): ConditionWorkItemRow {
  return {
    workItem: 'EI-1',
    title: 'gate is red',
    status: 'open',
    takenBy: null,
    takenAt: null,
    expiresAt: null,
    ...over,
  };
}

describe('resolveConditionObject', () => {
  it('reports no-object when nothing is linked to the key', () => {
    const got = resolveConditionObject(KEY, [], NOW);
    expect(got.claimState).toBe('no-object');
    expect(got.workItem).toBeNull();
    expect(got.takenBy).toBeNull();
    expect(got.duplicates).toEqual([]);
    // The key is echoed back even with no rows, so a batched caller can key its
    // map off the result without tracking which requests came back empty.
    expect(got.conditionKey).toBe(KEY);
  });

  it('reports claimable for a linked item nobody holds', () => {
    const got = resolveConditionObject(KEY, [row()], NOW);
    expect(got.claimState).toBe('claimable');
    expect(got.workItem).toBe('EI-1');
    expect(got.takenBy).toBeNull();
  });

  it('reports held for a claim whose lease has not lapsed', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', takenAt: '2026-08-03T00:50:00Z', expiresAt: '2026-08-03T02:00:00Z' })],
      NOW,
    );
    expect(got.claimState).toBe('held');
    expect(got.takenBy).toBe('su-abc');
  });

  it('reports held for a claim with NO expiry — an absent lease is not a lapsed one', () => {
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', expiresAt: null })], NOW);
    expect(got.claimState).toBe('held');
  });

  it('reports lease-expired — NOT held — for a lapsed claim, so a dead holder never reads as live', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-dead', expiresAt: '2026-08-03T00:30:00Z' })],
      NOW,
    );
    expect(got.claimState).toBe('lease-expired');
    // takenBy is still reported: the caller wants to know WHO abandoned it.
    expect(got.takenBy).toBe('su-dead');
  });

  it('treats an expiry exactly at now as expired (boundary is inclusive)', () => {
    const got = resolveConditionObject(
      KEY,
      [row({ takenBy: 'su-abc', expiresAt: new Date(NOW).toISOString() })],
      NOW,
    );
    expect(got.claimState).toBe('lease-expired');
  });

  it('ignores an unparseable expiry rather than treating it as lapsed', () => {
    const got = resolveConditionObject(KEY, [row({ takenBy: 'su-abc', expiresAt: 'not-a-date' })], NOW);
    expect(got.claimState).toBe('held');
  });
});

describe('duplicate filings — the condition this plan exists to remove', () => {
  it('picks the oldest row as canonical and reports the rest as duplicates', () => {
    // Caller orders by created_ts, so rows[0] is the oldest.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2' }), row({ workItem: 'EI-3' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-1');
    expect(got.duplicates).toEqual(['EI-2', 'EI-3']);
  });

  it('prefers a genuinely HELD row over an older unheld one', () => {
    // If any agent is actually live on the condition, that is the answer the
    // caller needs — otherwise a stale unclaimed duplicate would mask a real owner.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2', takenBy: 'su-live', expiresAt: '2026-08-03T02:00:00Z' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-2');
    expect(got.claimState).toBe('held');
    expect(got.duplicates).toEqual(['EI-1']);
  });

  it('does NOT let an expired-lease row outrank the oldest row', () => {
    // A lapsed claim is not ownership, so it must not win canonical position.
    const got = resolveConditionObject(
      KEY,
      [row({ workItem: 'EI-1' }), row({ workItem: 'EI-2', takenBy: 'su-dead', expiresAt: '2026-08-03T00:30:00Z' })],
      NOW,
    );
    expect(got.workItem).toBe('EI-1');
    expect(got.claimState).toBe('claimable');
  });

  it('reports every duplicate rather than silently collapsing them', () => {
    // Six agents filed one condition on 2026-08-02/03 and none saw the others.
    // Until P-002's partial unique index lands, duplicates are REAL and must be
    // visible — a resolver that hid them would make the problem unmeasurable.
    const rows = ['EI-1', 'EI-2', 'EI-3', 'EI-4', 'EI-5', 'EI-6'].map((id) => row({ workItem: id }));
    const got = resolveConditionObject('single-primary:no-primary', rows, NOW);
    expect(got.workItem).toBe('EI-1');
    expect(got.duplicates).toHaveLength(5);
  });
});

describe('claimStateOf / leaseExpired', () => {
  it('never returns no-object for an existing row', () => {
    expect(claimStateOf(row(), NOW)).toBe('claimable');
    expect(claimStateOf(row({ takenBy: 'x' }), NOW)).toBe('held');
  });

  it('an unclaimed row has no lease to expire', () => {
    expect(leaseExpired(row({ takenBy: null, expiresAt: '2000-01-01T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('vocabulary', () => {
  it('reuses the existing `about` rel rather than inventing one', () => {
    // `about` is already in LINK_RELS ("this item concerns a target — a topic,
    // event key, or object"). A new rel here would be a parallel surface for a
    // relationship the substrate already names.
    expect(CONDITION_LINK_REL).toBe('about');
  });
});
