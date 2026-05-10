/**
 * Per-key cooldown marks (PG, migration 032).
 *
 * Replaces module-scoped `Map<string, number>` patterns where the value
 * is "the last time something happened". The TTL/cooldown logic stays
 * in the caller; this module only stores the timestamp.
 *
 * Namespace keys yourself: `'el-mint:' + agentId`, `'voice-test:' + workspace`, …
 *
 * Not in zero_harness publication — internal cooldown ledger.
 */

import { getOrgPg } from '@restart/db-org';

/**
 * Read the most-recent mark for `key`, or null if none. Caller subtracts
 * from `Date.now()` to compute "ms since last mark".
 */
export async function readCooldownMark(key: string): Promise<number | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ marked_at_ms: number }[]>`
    SELECT marked_at_ms FROM harness_shared.cooldown_marks WHERE key = ${key} LIMIT 1
  `;
  return rows.length > 0 ? Number(rows[0].marked_at_ms) : null;
}

/** Stamp `key` with the current time. */
export async function writeCooldownMark(key: string, markedAtMs: number = Date.now()): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.cooldown_marks (key, marked_at_ms, updated_at)
    VALUES (${key}, ${markedAtMs}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE
      SET marked_at_ms = EXCLUDED.marked_at_ms, updated_at = EXCLUDED.updated_at
  `;
}
