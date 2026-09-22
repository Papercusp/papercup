/**
 * Oracle tests for `scripts/audit-identity-column-domains.mjs` (WI-10002452).
 *
 * The audit itself needs a POPULATED database — its whole subject is a column's
 * live value domain — so it cannot assert anything from a test runner (a
 * testcontainers DB is empty; every column would be "unmeasurable" and the
 * check would pass vacuously). What IS testable, and what these tests pin, is
 * the ORACLE: given measured counts, does it reach the right verdict?
 *
 * The control below is PERMANENT and deliberately encodes the real pre-fix
 * measurement rather than a synthetic one. `owner_directives.owner_id` was
 * classified 'covered' while holding the human owner label — 203 non-null rows,
 * ZERO of them in the identity universe. If the oracle ever stops failing that
 * row, it has stopped being able to catch the bug it was written for, and the
 * live audit's "clean" would mean nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProbeSql,
  classifyIdentityColumnDomains,
  extractCoveredColumns,
} from '../../../../../scripts/audit-identity-column-domains.mjs';

/** The measured pre-fix defect. See the module doc above — do not "simplify"
 *  these numbers to round ones: they are the observation, not a fixture. */
const PRE_FIX_DEFECT = {
  key: 'owner_directives.owner_id',
  nonnull: 203,
  inUniverse: 0,
  distinct: 2,
};

/** The same table's column AFTER the fix — the calibration case. A control set
 *  that only contains a failing row cannot tell "the oracle works" from "the
 *  oracle fails everything". */
const POST_FIX_CORRECT = {
  key: 'owner_directives.recorded_by',
  nonnull: 203,
  inUniverse: 202,
  distinct: 57,
};

describe('classifyIdentityColumnDomains (WI-10002452 oracle)', () => {
  it('CONTROL: fails the historical owner_directives.owner_id row — a covered column with rows but zero identity values', () => {
    const res = classifyIdentityColumnDomains([PRE_FIX_DEFECT]);
    expect(res.verdict).toBe('inert-domain');
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].key).toBe('owner_directives.owner_id');
    expect(res.failures[0].reason).toMatch(/does not hold agent session ids/);
  });

  it('CALIBRATION: passes the post-fix recorded_by row, so the control above is not just "fails everything"', () => {
    const res = classifyIdentityColumnDomains([POST_FIX_CORRECT]);
    expect(res.verdict).toBe('clean');
    expect(res.failures).toEqual([]);
    expect(res.measured).toBe(1);
  });

  it('still fails the defect when it is mixed in with healthy columns (one bad row is not diluted)', () => {
    const res = classifyIdentityColumnDomains([
      POST_FIX_CORRECT,
      { key: 'routines.target_owner_id', nonnull: 759, inUniverse: 758, distinct: 759 },
      { key: 'agent_modes.owner_id', nonnull: 9753, inUniverse: 9741, distinct: 7879 },
      PRE_FIX_DEFECT,
    ]);
    expect(res.verdict).toBe('inert-domain');
    expect(res.failures.map((f) => f.key)).toEqual(['owner_directives.owner_id']);
    expect(res.measured).toBe(4);
  });

  it('treats an empty column as UNMEASURABLE, never as a pass', () => {
    const res = classifyIdentityColumnDomains([
      { key: 'pending_wakes.owner_id', nonnull: 0, inUniverse: 0, distinct: 0 },
      POST_FIX_CORRECT,
    ]);
    expect(res.unmeasurable).toEqual(['pending_wakes.owner_id']);
    // The empty column must NOT be counted as something the audit checked.
    expect(res.measured).toBe(1);
    expect(res.verdict).toBe('clean');
  });

  it('refuses a clean verdict when NOTHING was measurable — an instrument that measured nothing is not a clean bill', () => {
    const res = classifyIdentityColumnDomains([
      { key: 'pending_wakes.owner_id', nonnull: 0, inUniverse: 0, distinct: 0 },
      { key: 'work_item_claims.owner', nonnull: 0, inUniverse: 0, distinct: 0 },
    ]);
    expect(res.verdict).toBe('no-measurement');
    expect(res.measured).toBe(0);
    expect(res.failures).toEqual([]);
  });

  it('skips a column whose mixed value domain is deliberate, and says so rather than silently passing it', () => {
    // agent_facts.scope_ref legitimately holds work-item refs when scope != 'owner'.
    const res = classifyIdentityColumnDomains([
      { key: 'agent_facts.scope_ref', nonnull: 12817, inUniverse: 0, distinct: 6162 },
      POST_FIX_CORRECT,
    ]);
    expect(res.exempted).toEqual(['agent_facts.scope_ref']);
    expect(res.verdict).toBe('clean');
  });
});

describe('extractCoveredColumns', () => {
  const SRC = `
const ALLOWLIST: Record<string, Classification> = {
  'routines.target_owner_id': { status: 'covered', surface: 'loop-routine' },
  'owner_directives.owner_id': {
    status: 'exempt',
    reason: 'the HUMAN owner label, not a coord session id',
  },
  'owner_directives.recorded_by': {
    status: 'covered',
    surface: 'owner-directives',
  },
};

/** Column-name patterns that mean "current holder" */
`;

  it('returns covered entries and excludes exempt ones', () => {
    expect(extractCoveredColumns(SRC)).toEqual([
      'routines.target_owner_id',
      'owner_directives.recorded_by',
    ]);
  });

  it('throws rather than silently returning [] when the inventory shape changes', () => {
    // A silent [] would make the audit report "clean" over zero columns — the
    // false-green this whole file exists to prevent.
    expect(() => extractCoveredColumns('nothing to see here')).toThrow(/ALLOWLIST not found/);
  });
});

describe('buildProbeSql', () => {
  it('measures non-null, in-universe and distinct counts per column against harness_shared', () => {
    const sql = buildProbeSql(['owner_directives.recorded_by']);
    expect(sql).toContain('FROM harness_shared.owner_directives');
    expect(sql).toContain('count(recorded_by)::int AS nonnull');
    expect(sql).toContain('session_briefs');
    expect(sql).toContain('count(DISTINCT recorded_by)::int AS distinct_vals');
  });

  it('UNIONs multiple columns into one round-trip', () => {
    const sql = buildProbeSql(['a.owner_id', 'b.taken_by']);
    expect(sql.match(/UNION ALL/g)).toHaveLength(1);
  });
});
