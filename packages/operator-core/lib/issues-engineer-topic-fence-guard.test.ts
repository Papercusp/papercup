/**
 * WI-9252 recurrence guard: `listIssues`' topic filter must resolve topic
 * membership ONCE, behind an optimization fence — never as a correlated
 * subquery in the WHERE clause.
 *
 * WHY A SOURCE-LEVEL INVARIANT AND NOT AN EXPLAIN ASSERTION. The defect is a
 * PLAN choice, and the plan only goes wrong at production scale: with ~17k
 * candidate rows and a `LIMIT 500`, the planner believes it can stop early and
 * picks a nested-loop semi-join, re-running the tag probe once per candidate
 * row. At integration-test fixture scale (a handful of rows) the planner will
 * happily pick either shape and both are correct, so an `EXPLAIN` assertion
 * there would be measuring nothing while looking rigorous. The thing that is
 * stable across scales is the SQL we emit, so that is what this pins.
 *
 * Measured on the live box 2026-08-03, papercusp-observation topic, LIMIT 500:
 *
 *   correlated EXISTS       111,909 buffers, coord_links loops = 16,984, ~424ms
 *   explicit JOIN           111,909 buffers, loops = 16,984   (planner flattens it)
 *   IN (uncorrelated)       111,909 buffers, loops = 16,984   (also flattened)
 *   WITH ... MATERIALIZED    58,054 buffers, loops = 1,        ~290ms
 *
 * The middle two rows are why this guard is worth having: "make it a JOIN like
 * countIssues does" is the intuitive fix and it is worth exactly zero. Only a
 * fence changes the plan, so a well-meaning simplification back to any of the
 * first three forms silently restores a ~2x regression on the single largest
 * DB consumer on the box.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, 'issues-engineer.ts');

/** Slice out one top-level async function body (exported or private). */
function functionSource(src: string, name: string): string {
  const exportedStart = src.indexOf(`export async function ${name}(`);
  const privateStart = src.indexOf(`async function ${name}(`);
  const start = exportedStart === -1 ? privateStart : exportedStart;
  expect(start, `${name} not found in issues-engineer.ts`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport async function ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

/** The two properties that together mean "resolved once, not per row". */
function hasMaterializedFence(fn: string): boolean {
  return /AS\s+MATERIALIZED/i.test(fn);
}
function hasCorrelatedTagProbe(fn: string): boolean {
  // The correlated form binds the tag edge to the OUTER row's id.
  return /cl\.src_ref\s*=\s*engineer_issues\.issue_id/i.test(fn);
}

describe('WI-9252: listIssues topic membership is resolved once, behind a fence', () => {
  const src = readFileSync(SRC, 'utf8');
  // listIssues is now a bounded public wrapper; listIssuesWithLimit owns the SQL
  // for both the bounded and file-export paths, so guard the actual writer.
  const listIssues = functionSource(src, 'listIssuesWithLimit');

  it('resolves topic membership behind a MATERIALIZED fence', () => {
    expect(hasMaterializedFence(listIssues)).toBe(true);
  });

  it('does NOT correlate the tag probe to the outer row', () => {
    expect(hasCorrelatedTagProbe(listIssues)).toBe(false);
  });

  it('references the fenced CTE from the topic predicate', () => {
    expect(/IN\s*\(\s*SELECT\s+src_ref\s+FROM\s+tagged\s*\)/i.test(listIssues)).toBe(true);
  });

  /**
   * CALIBRATION. Without these, the three assertions above also pass when the
   * matchers are broken (e.g. a typo'd regex that never matches makes
   * `hasCorrelatedTagProbe` false for every input, so the second test is
   * vacuously green). These pin the matchers against a known-BAD and a
   * known-GOOD snippet, so the guard is proven to discriminate rather than
   * merely to be quiet.
   */
  describe('matcher calibration (controls — not assertions about the real file)', () => {
    const BAD_correlated = `
      const rows = await sql\`
        SELECT x FROM harness_shared.engineer_issues
         WHERE EXISTS (
           SELECT 1 FROM harness_shared.coord_links cl
            WHERE cl.rel = 'tagged' AND cl.src_ref = engineer_issues.issue_id
         )
         ORDER BY created_at DESC LIMIT 500\`;`;

    const GOOD_fenced = `
      const cte = sql\`WITH tagged AS MATERIALIZED (
        SELECT cl.src_ref FROM harness_shared.coord_links cl WHERE cl.rel = 'tagged')\`;
      const rows = await sql\`\${cte} SELECT x FROM harness_shared.engineer_issues
         WHERE issue_id IN (SELECT src_ref FROM tagged)
         ORDER BY created_at DESC LIMIT 500\`;`;

    it('flags the pre-WI-9252 correlated form', () => {
      expect(hasCorrelatedTagProbe(BAD_correlated)).toBe(true);
      expect(hasMaterializedFence(BAD_correlated)).toBe(false);
    });

    it('accepts the fenced form', () => {
      expect(hasCorrelatedTagProbe(GOOD_fenced)).toBe(false);
      expect(hasMaterializedFence(GOOD_fenced)).toBe(true);
    });
  });

  /**
   * countIssues deliberately keeps a plain JOIN: it has no ORDER BY/LIMIT, so
   * the planner already picks a hash join there (measured loops = 1, 12,280
   * buffers). Pinned so that a future reader "fixing" it to match listIssues
   * has to read this comment first — the fence is the answer to LIMIT-driven
   * early-stop, not to topic joins in general.
   */
  it('countIssues is intentionally left as a plain JOIN', () => {
    const countIssues = functionSource(src, 'countIssues');
    expect(hasMaterializedFence(countIssues)).toBe(false);
  });
});
