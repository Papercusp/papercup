/**
 * claim-holder — the non-conflict holder projection (P-029 / D-060).
 *
 * Pure: no PG, no fixtures. The properties pinned here are the ones the ruling
 * turns on — an honest unknown instead of a mechanism string, a 3-valued `stale`,
 * and a projection that can never fail the read it decorates.
 */
import { describe, it, expect } from 'vitest';
import {
  autoConvertClaimIntent,
  declaredGoalOf,
  projectClaimHolder,
  INTENT_STALE_SEC,
} from './claim-holder';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const agoSec = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('declaredGoalOf', () => {
  it('passes a real declared goal through, trimmed', () => {
    expect(declaredGoalOf('  Ship P-029: surface the holder goal  ', 'P-029')).toEqual({
      goalText: 'Ship P-029: surface the holder goal',
    });
  });

  it('reports a blank intent as none-declared, never as an empty goal', () => {
    for (const blank of ['', '   ', null, undefined]) {
      expect(declaredGoalOf(blank, 'P-001')).toEqual({
        goalText: null,
        goalUnknown: 'none-declared',
      });
    }
  });

  it('refuses to render the auto-convert MECHANISM string as a goal', () => {
    // Measured 2026-07-27: 5 of 15 claims carry exactly this. Echoing it would
    // report a third of holders as having declared a goal when none did.
    expect(declaredGoalOf(autoConvertClaimIntent('P-412'), 'P-412')).toEqual({
      goalText: null,
      goalUnknown: 'auto-claimed',
    });
  });

  it('only suppresses the auto-convert string for the item it names', () => {
    // A holder whose declared goal happens to mention ANOTHER item's auto-convert
    // is still a declared goal — the match is exact, not a substring sniff.
    const other = autoConvertClaimIntent('P-412');
    expect(declaredGoalOf(other, 'P-029').goalText).toBe(other);
  });
});

describe('projectClaimHolder', () => {
  const base = {
    ownerId: 'su-8d9a6',
    ownerLabel: 'su · su-8d9a6',
    itemId: 'P-029',
    intent: 'Build the non-conflict claim read',
    acquiredTs: agoSec(120),
    lastActivityTs: agoSec(60),
    nowMs: NOW,
  };

  it('projects the goal, label and declaredAt off the claim row', () => {
    expect(projectClaimHolder(base)).toEqual({
      ownerId: 'su-8d9a6',
      ownerLabel: 'su · su-8d9a6',
      goalText: 'Build the non-conflict claim read',
      declaredAt: base.acquiredTs,
      stale: false,
    });
  });

  it('returns null when there is NO holder — never a placeholder row', () => {
    expect(projectClaimHolder({ ...base, ownerId: null })).toBeNull();
    expect(projectClaimHolder({ ...base, ownerId: '  ' })).toBeNull();
  });

  it('keeps the holder — with an honest goalUnknown — when the goal is unreadable', () => {
    // D-056: an unreadable goal removes the GOAL, never the holder and never the
    // row; visibility must not leak through the shape of the list.
    const h = projectClaimHolder({ ...base, intent: '' });
    expect(h?.ownerId).toBe('su-8d9a6');
    expect(h?.goalText).toBeNull();
    expect(h?.goalUnknown).toBe('none-declared');
  });

  it('derives stale from last activity against INTENT_STALE_SEC', () => {
    expect(projectClaimHolder({ ...base, lastActivityTs: agoSec(INTENT_STALE_SEC - 1) })?.stale).toBe(false);
    // Boundary: exactly at the threshold is NOT yet stale (matches computeIntentStale).
    expect(projectClaimHolder({ ...base, lastActivityTs: agoSec(INTENT_STALE_SEC) })?.stale).toBe(false);
    expect(projectClaimHolder({ ...base, lastActivityTs: agoSec(INTENT_STALE_SEC + 1) })?.stale).toBe(true);
  });

  it('reports stale as NULL — not false — when activity is unknown or unparseable', () => {
    // A missing/garbled activity stamp must never read as "fresh": that would
    // advertise an abandoned claim as live work.
    expect(projectClaimHolder({ ...base, lastActivityTs: null })?.stale).toBeNull();
    expect(projectClaimHolder({ ...base, lastActivityTs: 'not-a-date' })?.stale).toBeNull();
  });

  it('normalizes a blank owner label to null rather than an empty string', () => {
    expect(projectClaimHolder({ ...base, ownerLabel: '   ' })?.ownerLabel).toBeNull();
    expect(projectClaimHolder({ ...base, ownerLabel: undefined })?.ownerLabel).toBeNull();
  });

  it('is TOTAL — every partial input yields a value, never a throw (P-026 rule f)', () => {
    // The projection decorates a read; it must not be able to fail one.
    expect(() =>
      projectClaimHolder({ ownerId: 'su-x', itemId: 'P-001' }),
    ).not.toThrow();
    expect(projectClaimHolder({ ownerId: 'su-x', itemId: 'P-001' })).toEqual({
      ownerId: 'su-x',
      ownerLabel: null,
      goalText: null,
      goalUnknown: 'none-declared',
      declaredAt: null,
      stale: null,
    });
  });

  it('is READER-INDEPENDENT: the same claim projects identically for every caller', () => {
    // Load-bearing. `plans:items` caches these rows under a key that does NOT
    // include the caller, so a reader-relative field here would serve the first
    // caller's view to everyone for the SWR window. This test is the guard: it
    // fails the moment the projection grows an argument that varies per reader.
    expect(projectClaimHolder(base)).toEqual(projectClaimHolder(base));
    expect(Object.keys(projectClaimHolder(base) ?? {}).sort()).toEqual([
      'declaredAt',
      'goalText',
      'ownerId',
      'ownerLabel',
      'stale',
    ]);
  });
});
