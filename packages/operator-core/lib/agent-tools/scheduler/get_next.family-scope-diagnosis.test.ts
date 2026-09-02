/**
 * get_next.family-scope-diagnosis.test.ts — the RECURRENCE GUARD for
 * EI-18741395910746959.
 *
 * The bug: `fleet:launch-on-plan` authored a plan-scoped claim spec with NO
 * `kind` filter leaf at all (the plan's items were all kind:'feature'). Every
 * member's `scheduler:get_next` miss then diagnosed via `buildMissDiagnosis`,
 * whose entire pool/floor/breakdown computation runs EXCLUSIVELY over the
 * issue-family (bug/change/task) claim path — it structurally cannot see a
 * feature-family miss. So the reported diagnosis said "matches 0 issue-family
 * row(s)" as if that were the whole story, when the real reason the caller's
 * feature-family items didn't come back was never examined at all. A member
 * reading that message has no way to tell "the issue-family diagnosis found
 * nothing AND is the whole picture" apart from "the issue-family diagnosis
 * found nothing but your items are feature-family, so this says nothing about
 * them" — those are very different situations with different remedies.
 *
 * The fix (specKindFilterValues + specIsIssueFamilyOnly + the familyScopeNote
 * they gate in buildMissDiagnosis): read the caller's OWN claim spec's `kind`
 * filter leaf (top-level or nested one level inside an `all`). Only when it
 * restricts EXCLUSIVELY to issue-family kinds does the issue-family-only
 * diagnosis tell the whole story silently; otherwise (no kind leaf at all, or
 * one that includes a feature-family kind) the diagnosis now appends an
 * explicit NOTE saying so, pointing the caller at plans:items / work_items:get
 * instead of trusting an issue-family-only zero.
 *
 * specKindFilterValues/specIsIssueFamilyOnly are pure + exported specifically
 * so this can be asserted without a DB — the DB-backed half (buildMissDiagnosis
 * threading issueFamilyOnly into `familyScopeNote` and the returned
 * `diagnosis.issueFamilyOnlyDiagnosis`) is covered by reading the wiring at
 * get_next.ts:322-345 (asserted via source-text checks below, the established
 * pattern for this file's sibling *.test.ts files where a live DB claim isn't
 * needed to pin the logic).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { specKindFilterValues, specIsIssueFamilyOnly } from './get_next';

describe('EI-18741395910746959 — specKindFilterValues', () => {
  it('returns undefined when the spec has no filter at all', () => {
    expect(specKindFilterValues(undefined)).toBeUndefined();
    expect(specKindFilterValues({})).toBeUndefined();
    expect(specKindFilterValues({ view: {} })).toBeUndefined();
  });

  it('returns undefined for a plan-only filter with no kind leaf (the exact repro shape)', () => {
    const spec = { view: { filter: { field: 'plan', op: '=', value: 'agent-trap-guards-2026-07-26' } } };
    expect(specKindFilterValues(spec)).toBeUndefined();
  });

  it('extracts a top-level `kind in [...]` leaf', () => {
    const spec = { view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } } };
    expect(specKindFilterValues(spec)).toEqual(['bug', 'change']);
  });

  it('extracts a `kind in [...]` leaf nested one level inside an `all`', () => {
    const spec = {
      view: {
        filter: {
          all: [
            { field: 'plan', op: '=', value: 'some-plan' },
            { field: 'kind', op: 'in', value: ['feature'] },
          ],
        },
      },
    };
    expect(specKindFilterValues(spec)).toEqual(['feature']);
  });
});

describe('EI-18741395910746959 — specIsIssueFamilyOnly', () => {
  it('is false with no kind filter — the exact bug repro (a plan-only spec over feature-family items)', () => {
    const spec = { view: { filter: { field: 'plan', op: '=', value: 'agent-trap-guards-2026-07-26' } } };
    expect(specIsIssueFamilyOnly(spec)).toBe(false);
  });

  it('is true when the kind filter restricts exclusively to issue-family kinds', () => {
    expect(specIsIssueFamilyOnly({ view: { filter: { field: 'kind', op: 'in', value: ['bug'] } } })).toBe(true);
    expect(
      specIsIssueFamilyOnly({ view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] } } }),
    ).toBe(true);
  });

  it('is false when the kind filter includes ANY feature-family kind, even mixed with issue kinds', () => {
    expect(specIsIssueFamilyOnly({ view: { filter: { field: 'kind', op: 'in', value: ['feature'] } } })).toBe(false);
    expect(specIsIssueFamilyOnly({ view: { filter: { field: 'kind', op: 'in', value: ['chunk'] } } })).toBe(false);
    expect(
      specIsIssueFamilyOnly({ view: { filter: { field: 'kind', op: 'in', value: ['bug', 'feature'] } } }),
    ).toBe(false);
  });

  it('is false for an undefined/empty spec (no kind constraint ⇒ both families structurally reachable)', () => {
    expect(specIsIssueFamilyOnly(undefined)).toBe(false);
    expect(specIsIssueFamilyOnly({})).toBe(false);
  });
});

describe('EI-18741395910746959 — buildMissDiagnosis threads the family-scope note (wiring guard)', () => {
  const SRC = readFileSync(resolve(__dirname, './get_next.ts'), 'utf8');

  it('gates the family-scope NOTE on specIsIssueFamilyOnly, appended to the returned error', () => {
    expect(SRC).toContain('const issueFamilyOnly = specIsIssueFamilyOnly(rec?.spec);');
    expect(SRC).toMatch(/error:\s*`\$\{STATIC\}\. Diagnosis: \$\{aggregate\}\.\$\{shadowedFleetNote\}\$\{namedSummary\}\$\{breakdownSummary\}\$\{flagReadErrorNote\}\$\{familyScopeNote\}`/);
  });

  it('the note explicitly tells the caller to check plans:items / work_items:get instead of trusting the issue-family zero', () => {
    expect(SRC).toContain('plans:items / work_items:get');
    expect(SRC).toContain('rather than trusting an issue-family-only 0 here');
  });

  it('the diagnosis payload surfaces issueFamilyOnlyDiagnosis so a programmatic caller can branch on it too', () => {
    expect(SRC).toMatch(/diagnosis:\s*\{[\s\S]*?issueFamilyOnlyDiagnosis:\s*issueFamilyOnly/);
  });
});
