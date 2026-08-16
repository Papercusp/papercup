import { describe, expect, it } from 'vitest';

import * as ungradedScope from './scout/ungraded-scope';
import { bareTableName, buildUngradedScopeAdvisory } from './pg-read-query';

const TABLES = ['harness_shared.scout_routed_ideas'];

describe('buildUngradedScopeAdvisory', () => {
  it('fires on the exact query shape that produced the wrong number', () => {
    // Measured 2026-08-16: this hand-written predicate answered 143 where
    // classifyUngraded answers 83.
    const a = buildUngradedScopeAdvisory(
      "SELECT count(*) FROM harness_shared.scout_routed_ideas WHERE human_grade IS NULL AND workspace_id='papercusp-workspace'",
      TABLES,
    );
    expect(a).not.toBeNull();
    expect(a).toContain('classifyUngraded');
    expect(a).toContain('origin');
  });

  it('names WHICH axes were left implicit, not just that something is wrong', () => {
    const a = buildUngradedScopeAdvisory(
      "SELECT * FROM harness_shared.scout_routed_ideas WHERE human_grade IS NULL AND origin='su-ideate'",
      TABLES,
    );
    // origin is named, so only the other two are missing.
    expect(a).toContain('outcome');
    expect(a).toContain('routed_at');
    expect(a).not.toMatch(/\(origin,/);
  });

  it('clears once all three axes are named — a deliberate query is left alone', () => {
    expect(
      buildUngradedScopeAdvisory(
        `SELECT origin, count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= 1
           AND (outcome IS NULL OR outcome = 'pending')) FROM harness_shared.scout_routed_ideas
         GROUP BY origin`,
        TABLES,
      ),
    ).toBeNull();
  });

  it('stays silent on a query that never reaches for human_grade', () => {
    expect(
      buildUngradedScopeAdvisory(
        "SELECT count(*) FROM harness_shared.scout_routed_ideas WHERE lens='risk-first'",
        TABLES,
      ),
    ).toBeNull();
  });

  it('stays silent on other tables', () => {
    expect(
      buildUngradedScopeAdvisory('SELECT human_grade FROM harness_shared.work_items', [
        'harness_shared.work_items',
      ]),
    ).toBeNull();
  });
});

/**
 * THE ANTI-ROT PIN.
 *
 * The advisory's whole admissibility rule is that it may only name an authority
 * that ALREADY carries a build-time guard — so that a rename breaks the build and
 * forces the advisory text to be updated, instead of leaving a runtime rule that
 * confidently cites a symbol which no longer exists. A stale guard naming a
 * renamed accessor is worse than no guard at all.
 *
 * These assertions ARE that pin. If someone renames `classifyUngraded` or
 * `readUngradedBreakdown`, this file goes red and names the advisory that must
 * change with it.
 */
describe('the advisory is pinned to the authority it cites', () => {
  it('names symbols that actually exist', () => {
    const advisory = buildUngradedScopeAdvisory(
      'SELECT * FROM harness_shared.scout_routed_ideas WHERE human_grade IS NULL',
      TABLES,
    );
    expect(advisory).not.toBeNull();
    for (const symbol of ['classifyUngraded', 'readUngradedBreakdown'] as const) {
      expect(advisory).toContain(symbol);
      expect(typeof ungradedScope[symbol]).toBe('function');
    }
  });

  it('cites the module path the authority actually lives at', () => {
    const advisory = buildUngradedScopeAdvisory(
      'SELECT * FROM harness_shared.scout_routed_ideas WHERE human_grade IS NULL',
      TABLES,
    );
    expect(advisory).toContain('lib/scout/ungraded-scope.ts');
  });

  it('the three axes it demands are the three the authority actually fixes', () => {
    // classifyUngraded reads exactly these row fields; if it grows or loses an
    // axis, the advisory's demand list must move with it.
    const bucket = ungradedScope.classifyUngraded(
      { origin: 'scout', humanGrade: null, outcome: null, routedAtMs: Date.now() },
      { policy: ungradedScope.DEFAULT_UNGRADED_EPOCH_POLICY },
    );
    expect(bucket).toBe('actionable');
    // A pre-epoch row buckets differently — proving routed_at is load-bearing,
    // which is why the advisory insists the caller name it.
    expect(
      ungradedScope.classifyUngraded(
        { origin: 'scout', humanGrade: null, outcome: null, routedAtMs: 0 },
        { policy: ungradedScope.DEFAULT_UNGRADED_EPOCH_POLICY },
      ),
    ).toBe('pre-epoch');
    // And terminality: an artifact that already landed is not gradeable.
    expect(
      ungradedScope.classifyUngraded(
        { origin: 'scout', humanGrade: null, outcome: 'shipped', routedAtMs: Date.now() },
        { policy: ungradedScope.DEFAULT_UNGRADED_EPOCH_POLICY },
      ),
    ).toBe('terminal');
  });

  // CALIBRATION CONTROL: the naive predicate the advisory exists to intercept
  // counts all three of the rows above as "ungraded", which is exactly the
  // over-count that made a 15-row backlog look like 1,082.
  it('control: the raw predicate cannot tell the three populations apart', () => {
    const rows = [
      { humanGrade: null, outcome: null, routedAtMs: Date.now() },
      { humanGrade: null, outcome: null, routedAtMs: 0 },
      { humanGrade: null, outcome: 'shipped', routedAtMs: Date.now() },
    ];
    expect(rows.filter((r) => r.humanGrade === null)).toHaveLength(3);
  });
});

describe('bareTableName', () => {
  it('unqualifies a schema-qualified name', () => {
    expect(bareTableName('harness_shared.scout_routed_ideas')).toBe('scout_routed_ideas');
    expect(bareTableName('scout_routed_ideas')).toBe('scout_routed_ideas');
  });
});
