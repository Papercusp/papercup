import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractFunctionBody,
  judgePgActiveQueriesSafety,
  stripLineComments,
} from './pg-active-queries-self-exclusion';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEV_DATA = join(REPO_ROOT, 'packages/operator-core/lib/dev-data.ts');
const TOOL = join(REPO_ROOT, 'packages/operator-core/lib/agent-tools/dev/pg_active_queries.ts');

/** A tool source with the current (safe) shape: a limit, and no pattern. */
const SAFE_TOOL = `
  args: z.object({
    limit: z.number().int().positive().max(200).optional(),
  }),
`;

const SAFE_DEV_DATA = `
export async function pgActiveQueries(limit = 50) {
  const rows = await sql\`
    SELECT pid, state, query FROM pg_stat_activity
    WHERE datname = current_database()
      AND query NOT ILIKE '%pg_stat_activity%'
  \`;
  return { queries: rows };
}
export async function pgTableSizes() {}
`;

describe('pg_active_queries self-exclusion doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a pgActiveQueries whose self-exclusion was removed', () => {
      const withoutExclusion = `
export async function pgActiveQueries(limit = 50) {
  const rows = await sql\`
    SELECT pid, state, query FROM pg_stat_activity
    WHERE datname = current_database()
  \`;
  return { queries: rows };
}
export async function pgTableSizes() {}
`;
      const v = judgePgActiveQueriesSafety({
        devDataSource: withoutExclusion,
        toolSource: SAFE_TOOL,
      });
      expect(v.ok).toBe(false);
      expect(v.selfExclusionAt).toEqual([]);
      expect(v.problems.join(' ')).toContain('no longer excludes its own backend');
    });

    it('does NOT accept the predicate when it survives only inside a comment', () => {
      // The realistic regression: someone comments the predicate out "to see all rows"
      // and leaves the line in place, so any grep for the TEXT still finds it.
      const commentedOut = `
export async function pgActiveQueries(limit = 50) {
  const rows = await sql\`
    SELECT pid FROM pg_stat_activity
    // AND query NOT ILIKE '%pg_stat_activity%'
  \`;
}
export async function pgTableSizes() {}
`;
      const v = judgePgActiveQueriesSafety({
        devDataSource: commentedOut,
        toolSource: SAFE_TOOL,
      });
      expect(v.ok).toBe(false);
      expect(v.selfExclusionAt).toEqual([]);
    });

    it('accepts pid <> pg_backend_pid() as an equally valid self-exclusion', () => {
      const byPid = `
export async function pgActiveQueries(limit = 50) {
  const rows = await sql\`
    SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid()
  \`;
}
export async function pgTableSizes() {}
`;
      const v = judgePgActiveQueriesSafety({ devDataSource: byPid, toolSource: SAFE_TOOL });
      expect(v.ok).toBe(true);
      expect(v.selfExclusionAt.length).toBeGreaterThan(0);
    });

    it('catches a pattern argument added to the tool, which reopens the trap', () => {
      const withPattern = `
  args: z.object({
    limit: z.number().int().positive().max(200).optional(),
    pattern: z.string().optional(),
  }),
`;
      const v = judgePgActiveQueriesSafety({
        devDataSource: SAFE_DEV_DATA,
        toolSource: withPattern,
      });
      expect(v.ok).toBe(false);
      expect(v.patternArgs).toContain('pattern');
      expect(v.problems.join(' ')).toContain('pattern-shaped argument');
    });

    it('reports a MISSING pgActiveQueries rather than silently passing', () => {
      // A rename/removal must not read as "no problems found" — that is the failure
      // mode this whole class of doc claim exists to prevent.
      const v = judgePgActiveQueriesSafety({
        devDataSource: 'export async function somethingElse() {}',
        toolSource: SAFE_TOOL,
      });
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('was not found');
    });
  });

  describe('extractFunctionBody', () => {
    it('does not credit a predicate belonging to a neighbouring function', () => {
      const twoFns = `
export async function pgActiveQueries() {
  const rows = await sql\`SELECT pid FROM pg_stat_activity\`;
}
export async function otherProbe() {
  const rows = await sql\`SELECT 1 WHERE query NOT ILIKE '%pg_stat_activity%'\`;
}
`;
      const body = extractFunctionBody(twoFns, 'pgActiveQueries');
      expect(body).not.toBeNull();
      expect(body).not.toContain('otherProbe');
      expect(judgePgActiveQueriesSafety({ devDataSource: twoFns, toolSource: SAFE_TOOL }).ok).toBe(
        false,
      );
    });

    it('returns null for a function that is not present', () => {
      expect(extractFunctionBody('export async function foo() {}', 'pgActiveQueries')).toBeNull();
    });
  });

  describe('stripLineComments', () => {
    it('drops a trailing comment but keeps the code before it', () => {
      expect(stripLineComments('const a = 1; // note').join('')).toContain('const a = 1;');
    });
  });

  describe('the live tree', () => {
    it('keeps dev:pg_active_queries safe to recommend as the self-match-free probe', () => {
      const v = judgePgActiveQueriesSafety({
        devDataSource: readFileSync(DEV_DATA, 'utf8'),
        toolSource: readFileSync(TOOL, 'utf8'),
      });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      // Positive control on the INSTRUMENT, not the subject: an unreadable or empty file
      // would also yield "no pattern args", so assert the judge actually saw the predicate.
      expect(v.selfExclusionAt.length).toBeGreaterThan(0);
      expect(v.patternArgs).toEqual([]);
    });
  });
});
