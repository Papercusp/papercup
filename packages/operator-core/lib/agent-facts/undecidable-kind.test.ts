import { describe, expect, it } from 'vitest';

import { FACT_KINDS, validateUndecidableSettledBy } from './store';

/**
 * plan agent-epistemics-2026-08-02 P-002 — the first-class UNKNOWN.
 *
 * These cover the RULE, not the plumbing: an `undecidable` must name its own
 * exit, and `settledBy` must not silently attach to a modality where it has no
 * referent. The DB round-trip is covered by applying migration 730 (a migration
 * is verified by APPLYING it, not by unit tests).
 */
describe("FACT_KINDS — 'undecidable' is a fourth modality", () => {
  it('carries the three original modalities plus undecidable, and does not reorder them', () => {
    // Order matters only in that existing rows/readers reference these by value;
    // asserting the full tuple catches an accidental rename or drop.
    expect(FACT_KINDS).toEqual(['conclusion', 'assumption', 'convention', 'undecidable']);
  });
});

describe('validateUndecidableSettledBy', () => {
  it("REFUSES an undecidable with no exit — the failure mode the modality exists to prevent", () => {
    for (const missing of [null, undefined, '', '   ']) {
      const err = validateUndecidableSettledBy('undecidable', missing);
      expect(err).toBeTruthy();
      expect(err).toContain('requires settledBy');
    }
  });

  it('explains WHY rather than just refusing — the message must survive being read by a hurried agent', () => {
    const err = validateUndecidableSettledBy('undecidable', null) ?? '';
    // The distinction that makes the rule non-arbitrary.
    expect(err).toContain('nobody COULD determine this');
    expect(err).toContain('nobody has tried lately');
  });

  it('accepts an undecidable that names a concrete probe', () => {
    expect(
      validateUndecidableSettledBy(
        'undecidable',
        "gate_health->'inFlightRetriage' in harness_shared.routines, scoping BOTH install_slug and workspace_id",
      ),
    ).toBeNull();
  });

  it('REFUSES settledBy on a settled modality — there it has no referent', () => {
    for (const kind of ['conclusion', 'assumption', 'convention']) {
      const err = validateUndecidableSettledBy(kind, 'some probe');
      expect(err, `kind=${kind}`).toBeTruthy();
      expect(err).toContain("only meaningful for kind:'undecidable'");
    }
  });

  it('is silent when settledBy is absent on a non-undecidable kind, including an undeclared kind', () => {
    for (const kind of ['conclusion', 'assumption', 'convention', null]) {
      expect(validateUndecidableSettledBy(kind, null), `kind=${kind}`).toBeNull();
      expect(validateUndecidableSettledBy(kind, undefined), `kind=${kind}`).toBeNull();
      // Whitespace-only is treated as absent, not as a value — so it must not
      // trip the "refused on another kind" branch either.
      expect(validateUndecidableSettledBy(kind, '   '), `kind=${kind}`).toBeNull();
    }
  });
});
