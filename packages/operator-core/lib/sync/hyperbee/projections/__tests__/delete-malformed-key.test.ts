/**
 * D3 — composite-key projections silently no-op a malformed delete key.
 *
 * `feature-queue`, `feature-working-set`, and `presence` all parse their delete
 * key as `<github_user_id>/<machine-or-feature>` and `return` early on a key that
 * lacks a `/`, has an empty part, or carries a non-numeric / non-positive user id
 * (`sepIdx <= 0` || `!Number.isFinite(userId)` || `userId <= 0` || empty tail).
 *
 * The contract these prove: a corrupt / unparseable del key must NEVER reach the
 * SQL client — issuing a DELETE with a defaulted/NaN id could erase the wrong row
 * (or, with a `WHERE github_user_id = NaN`, throw and wedge the merge). The
 * projections take the SQL client from `opts.sql`, so a mock client that throws
 * on ANY call proves the early-return floor: every bad key resolves without
 * throwing AND issues no destructive SQL.
 *
 * Pure unit — the mock sql is a `vi.fn` tagged-template; no PG needed.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { buildFeatureQueueProjection } from '../feature-queue';
import { buildFeatureWorkingSetProjection } from '../feature-working-set';
import { buildPresenceProjection } from '../presence';

/** A postgres-js stand-in whose every invocation FAILS the test if reached. The
 *  projections only ever call it as a tagged template (``sql`...` ``) or, for the
 *  working-set recompute, as `sql.unsafe(...)`; both route through this spy. */
function makeAssertNotCalledSql(): { sql: postgres.Sql; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(() => {
    throw new Error('SQL client was invoked for a malformed delete key — must no-op');
  });
  const fn = ((..._args: unknown[]) => spy()) as unknown as postgres.Sql;
  // working-set's recompute uses sql.unsafe(query, params); route it through the spy too.
  (fn as unknown as { unsafe: () => unknown }).unsafe = () => spy();
  return { sql: fn, spy };
}

// Each bad key: no `/`, non-numeric user id, zero user id, negative user id,
// empty user part, empty tail part.
const BAD_KEYS = [
  'notakey', // no separator
  '', // empty
  'abc/F-123', // non-numeric user id
  '0/F-123', // zero user id (must be > 0)
  '-1/F-123', // negative user id
  '/F-123', // empty user part (sepIdx === 0 → sepIdx <= 0 returns)
  '12345/', // empty tail (feature_id / machine_label)
];

describe('D3 — malformed delete key is a silent no-op that issues no SQL', () => {
  it('feature-queue deleteFromPg', async () => {
    const { sql, spy } = makeAssertNotCalledSql();
    const p = buildFeatureQueueProjection({ workspaceId: 'w', harnessSlug: 'sheets', sql });
    for (const key of BAD_KEYS) {
      await expect(p.deleteFromPg(key, 1000)).resolves.toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('feature-working-set deleteFromPg (also never reaches the recompute UPDATE)', async () => {
    const { sql, spy } = makeAssertNotCalledSql();
    const p = buildFeatureWorkingSetProjection({ workspaceId: 'w', harnessSlug: 'sheets', sql });
    for (const key of BAD_KEYS) {
      await expect(p.deleteFromPg(key, 1000)).resolves.toBeUndefined();
    }
    // The early-return must fire BEFORE the `const sql = ...` AND before the
    // unconditional recomputeWorkingUsers() — neither the DELETE nor the
    // recompute UPDATE may run for an unparseable key.
    expect(spy).not.toHaveBeenCalled();
  });

  it('presence deleteFromPg', async () => {
    const { sql, spy } = makeAssertNotCalledSql();
    const p = buildPresenceProjection({ workspaceId: 'w', harnessSlug: 'sheets', sql });
    for (const key of BAD_KEYS) {
      await expect(p.deleteFromPg(key, 1000)).resolves.toBeUndefined();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('a WELL-FORMED key DOES reach the SQL client (negative control — the no-op is key-shaped, not blanket)', async () => {
    const { sql, spy } = makeAssertNotCalledSql();
    const p = buildFeatureQueueProjection({ workspaceId: 'w', harnessSlug: 'sheets', sql });
    // A valid `<userId>/<featureId>` key parses → the guard passes → the DELETE
    // is attempted (our spy throws to prove it was reached).
    await expect(p.deleteFromPg('12345/F-001', 1000)).rejects.toThrow(/SQL client was invoked/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
