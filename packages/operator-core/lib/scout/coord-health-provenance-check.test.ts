/**
 * coord-health-provenance-check.test.ts — coord-derived-fields-2026-08-31 P-008.
 *
 * Pins the pure halves of the `youMayNotKnow.provenance` mechanism check: the
 * ledger-ref matcher and the aggregate-only pattern emission (D-004 contract —
 * no sender dimension, silent below the minimum sample, never per-message).
 */
import { describe, it, expect } from 'vitest';
import {
  buildCoordHealthPatterns,
  computedClaimMatchesLedger,
  loadCoordProvenanceCheck,
  type CoordProvenanceCheck,
} from './coord-health-lane';

describe('computedClaimMatchesLedger (pure)', () => {
  it('matches an exact kind:id citation', () => {
    expect(computedClaimMatchesLedger('work-item:WI-9', ['plan:x', 'work-item:WI-9'])).toBe(true);
  });

  it('matches a bare-id citation against its kinded ledger row', () => {
    expect(computedClaimMatchesLedger('WI-9', ['work-item:WI-9'])).toBe(true);
    expect(computedClaimMatchesLedger('my-plan-slug', ['plan:my-plan-slug'])).toBe(true);
  });

  it('does not match a different id, a substring, or an empty claim', () => {
    expect(computedClaimMatchesLedger('WI-9', ['work-item:WI-99'])).toBe(false);
    expect(computedClaimMatchesLedger('I-9', ['work-item:WI-9'])).toBe(false);
    expect(computedClaimMatchesLedger('', ['work-item:WI-9'])).toBe(false);
    expect(computedClaimMatchesLedger('   ', ['work-item:WI-9'])).toBe(false);
  });

  it('returns false on an empty ledger — an unmatched verdict, never a throw', () => {
    expect(computedClaimMatchesLedger('WI-9', [])).toBe(false);
  });

  it('trims the claim before matching', () => {
    expect(computedClaimMatchesLedger('  WI-9  ', ['work-item:WI-9'])).toBe(true);
  });
});

describe('loadCoordProvenanceCheck (fail-soft)', () => {
  it('returns undefined (never throws) when the database is unreachable', async () => {
    await expect(loadCoordProvenanceCheck('unit-test-no-db')).resolves.toBeUndefined();
  });
});

describe('provenance-check pattern emission (aggregate-only, D-004)', () => {
  const baseInput = {
    escalationStorms: [],
    wakeStorms: [],
    unansweredTargets: [],
    claimConflicts: 0,
  };
  const reading = (over: Partial<CoordProvenanceCheck>): CoordProvenanceCheck => ({
    computedSeen: 10,
    checked: 10,
    matched: 7,
    unmatched: 3,
    unknown: 0,
    samples: [{ ref: 'work-item:WI-1' }],
    ...over,
  });

  it('emits ONE corpus-wide pattern at/above the minimum checked sample', () => {
    const out = buildCoordHealthPatterns({ ...baseInput, provenanceCheck: reading({}) });
    const hits = out.filter((p) => p.ref === 'coord:computed-provenance-check');
    expect(hits).toHaveLength(1);
    expect(hits[0].summary).toContain('7/10');
    // One-sided semantics must reach the reader, not just the code comment.
    expect(hits[0].detail).toContain('not refuted');
  });

  it('is SILENT below the minimum — a rate over a handful of claims is noise', () => {
    const out = buildCoordHealthPatterns({
      ...baseInput,
      provenanceCheck: reading({ checked: 4, matched: 3, unmatched: 1 }),
    });
    expect(out.some((p) => p.ref === 'coord:computed-provenance-check')).toBe(false);
  });

  it('is silent when the reading is absent', () => {
    const out = buildCoordHealthPatterns({ ...baseInput });
    expect(out.some((p) => p.ref === 'coord:computed-provenance-check')).toBe(false);
  });

  it('carries NO sender dimension anywhere — ref is unkeyed, samples are refs only', () => {
    const out = buildCoordHealthPatterns({ ...baseInput, provenanceCheck: reading({}) });
    const hit = out.find((p) => p.ref === 'coord:computed-provenance-check');
    expect(hit).toBeDefined();
    // The ref is the bare family name — never `coord:computed-provenance-check:<agent>`.
    expect(hit!.ref).toBe('coord:computed-provenance-check');
    expect(`${hit!.summary} ${hit!.detail}`).not.toMatch(/su-[0-9a-f]/);
  });

  it('weight tracks the unmatched share and stays below the incident band', () => {
    const clean = buildCoordHealthPatterns({
      ...baseInput,
      provenanceCheck: reading({ matched: 10, unmatched: 0 }),
    }).find((p) => p.ref === 'coord:computed-provenance-check')!;
    const dirty = buildCoordHealthPatterns({
      ...baseInput,
      provenanceCheck: reading({ matched: 0, unmatched: 10 }),
    }).find((p) => p.ref === 'coord:computed-provenance-check')!;
    expect(dirty.weight!).toBeGreaterThan(clean.weight!);
    expect(dirty.weight!).toBeLessThanOrEqual(0.65);
  });
});
