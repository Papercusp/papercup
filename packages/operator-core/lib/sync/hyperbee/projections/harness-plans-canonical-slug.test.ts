/**
 * WI-5720 — inbound retired-slug canonicalization for the plan-row projection.
 *
 * Regression cover for the real incident: months AFTER the papercup→papercusp rename
 * was declared complete (migration 359 fixed only the OUTBOUND capture path), inbound
 * federation re-materialised 78 plan rows under the retired `papercup` slug between
 * 2026-07-01 and 07-09. Those plans landed in a harness with no registered Pot, so
 * they vanished from the Pot's plan list. decodeValue is the single wire boundary
 * every downstream consumer (membership guard, write-authority, PG upsert, per-part
 * recompose) reads the slug from, so the canonicalization must hold there.
 */
import { describe, it, expect } from 'vitest';
import { _testing, type HarnessPlanRow } from './harness-plans';
import { RETIRED_HARNESS_SLUG_ALIASES } from '../../../harness/operator-home-harness';

function planRow(overrides: Partial<HarnessPlanRow> = {}): HarnessPlanRow {
  return {
    harness_slug: 'papercusp',
    plan_slug: 'some-plan-2026-07-25',
    content: '# Some plan\n',
    content_hash: 'deadbeef',
    title: 'Some plan',
    status: 'active',
    created: '2026-07-25',
    updated: '2026-07-25',
    owner: null,
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
    ...overrides,
  };
}

describe('harness-plans projection — retired harness_slug canonicalization (WI-5720)', () => {
  it('rewrites a retired papercup slug to papercusp at the wire boundary', () => {
    const decoded = _testing.decodeValue(planRow({ harness_slug: 'papercup' }));
    expect(decoded?.harness_slug).toBe('papercusp');
  });

  it('rewrites every alias in RETIRED_HARNESS_SLUG_ALIASES — the map is the contract', () => {
    for (const [retired, canonical] of Object.entries(RETIRED_HARNESS_SLUG_ALIASES)) {
      const decoded = _testing.decodeValue(planRow({ harness_slug: retired }));
      expect(decoded?.harness_slug, `alias ${retired}`).toBe(canonical);
    }
  });

  it('leaves a live slug untouched, by reference — a normal op pays nothing', () => {
    const row = planRow({ harness_slug: 'oddsmith-hive' });
    expect(_testing.decodeValue(row)).toBe(row);
  });

  it('preserves every other field while rewriting the slug', () => {
    const row = planRow({ harness_slug: 'papercup', plan_slug: 'p1', content: '# body', title: 't' });
    const decoded = _testing.decodeValue(row);
    expect(decoded).toEqual({ ...row, harness_slug: 'papercusp' });
    expect(row.harness_slug).toBe('papercup'); // input not mutated
  });

  it('still rejects a malformed wire row (canonicalization runs AFTER the shape guard)', () => {
    expect(_testing.decodeValue({ harness_slug: 'papercup' })).toBeNull();
    expect(_testing.decodeValue(null)).toBeNull();
  });
});
