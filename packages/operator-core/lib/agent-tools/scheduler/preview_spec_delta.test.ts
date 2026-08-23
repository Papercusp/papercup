import { describe, expect, it } from 'vitest';
import {
  resolvePreviewHarness,
  deltaFamilyScopeIncomplete,
  FAMILY_SCOPE_BLIND_SPOT_WARNING,
} from './preview_spec_delta';
import previewSpecDeltaTool from './preview_spec_delta';

const proposedSpecWithoutRevision = {
  specVersion: '1.0',
  specId: 'preview-test',
  view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  states: ['open'],
};

describe('scheduler:preview_spec_delta args — proposed spec is self-describing', () => {
  it('publishes revision as required and accepts the complete shared claim-spec shape', () => {
    const missingRevision = previewSpecDeltaTool.args.safeParse({
      fleet: 'fleet-a',
      proposed: proposedSpecWithoutRevision,
    });
    expect(missingRevision.success).toBe(false);
    if (!missingRevision.success) {
      expect(missingRevision.error.issues.some((issue) => issue.path.join('.') === 'proposed.revision')).toBe(true);
    }

    const complete = previewSpecDeltaTool.args.safeParse({
      fleet: 'fleet-a',
      proposed: { ...proposedSpecWithoutRevision, revision: 1 },
    });
    expect(complete.success).toBe(true);
  });
});

describe('resolvePreviewHarness — operator scope must not become a literal harness', () => {
  it('rejects an unscoped operator context instead of previewing an empty `*` lane', () => {
    expect(resolvePreviewHarness(undefined, null, '*')).toBeUndefined();
  });

  it('inherits a concrete ambient harness from an unscoped sentinel argument', () => {
    expect(resolvePreviewHarness('*', null, 'papercusp')).toBe('papercusp');
  });

  it('prefers a concrete stored scope over the operator-context sentinel', () => {
    expect(resolvePreviewHarness(undefined, 'papercusp', '*')).toBe('papercusp');
  });

  it('falls back from a stale wildcard stored scope to a concrete ambient harness', () => {
    expect(resolvePreviewHarness(undefined, '*', 'papercusp')).toBe('papercusp');
  });

  it('gives an explicit concrete harness precedence over stored and ambient scopes', () => {
    expect(resolvePreviewHarness('papercusp', 'other-harness', '*')).toBe('papercusp');
  });
});

/**
 * EI-21177555351818650 regression: scheduler:preview_spec_delta reported
 * currentClaimable=0 / proposedClaimable=0 — including for a proposal naming
 * feature-family WI-40469/WI-40491/WI-40500 by id explicitly — while
 * scheduler:get_next claimed WI-40469 seconds later under the same stored spec.
 * Root cause: readClaimSpecDelta's candidate subquery is issue-family-only
 * (item_kind IN ('bug','change','task')); scheduler:get_next also claims from the
 * feature-family table via its tier 1/2. deltaFamilyScopeIncomplete is the guard
 * that flags a reading as non-exhaustive whenever a feature-family row could be
 * reachable — pinning it here keeps the two oracles' DISAGREEMENT from ever being
 * silent again, even though this function cannot make the counts themselves
 * exhaustive (that needs a feature-family-aware engine, out of scope here).
 */
describe('deltaFamilyScopeIncomplete — the issue-family blind spot must never be silent', () => {
  const idOnlyFilter = {
    field: 'id',
    op: 'in',
    value: ['WI-40469', 'WI-40491', 'WI-40500'],
  };
  const issueOnlyKindFilter = { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] };
  const featureAdmittingKindFilter = { field: 'kind', op: 'in', value: ['bug', 'feature'] };

  it('is false when BOTH specs restrict exclusively to issue-family kinds — the reading is exhaustive', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    expect(deltaFamilyScopeIncomplete(spec, spec)).toBe(false);
  });

  it('is true when the CURRENT spec has no kind filter at all (the live repro: the fleet sentinel spec)', () => {
    const current = { view: { filter: { all: [idOnlyFilter] } } };
    const proposed = { view: { filter: issueOnlyKindFilter } };
    expect(deltaFamilyScopeIncomplete(current, proposed)).toBe(true);
  });

  it('is true for an explicit id-list proposal with no kind leaf — the live repro\'s second preview', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    const idListProposal = { view: { filter: idOnlyFilter } };
    expect(deltaFamilyScopeIncomplete(spec, idListProposal)).toBe(true);
    expect(deltaFamilyScopeIncomplete(idListProposal, spec)).toBe(true);
  });

  it('is true when either spec\'s kind filter explicitly admits a non-issue kind', () => {
    const spec = { view: { filter: issueOnlyKindFilter } };
    const featureSpec = { view: { filter: featureAdmittingKindFilter } };
    expect(deltaFamilyScopeIncomplete(spec, featureSpec)).toBe(true);
    expect(deltaFamilyScopeIncomplete(featureSpec, spec)).toBe(true);
  });

  it('the warning names the blind spot and tells the reader to verify with scheduler:get_next', () => {
    expect(FAMILY_SCOPE_BLIND_SPOT_WARNING).toContain('feature-family');
    expect(FAMILY_SCOPE_BLIND_SPOT_WARNING).toContain('scheduler:get_next');
  });
});
