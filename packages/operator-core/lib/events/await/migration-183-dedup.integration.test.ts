/**
 * migration-183-dedup.integration.test.ts — turn-lifecycle-control P-006 / D-002.
 *
 * Migration 183 (`183-event-awaits-inbox-wake-one-per-agent.sql`) has two steps:
 *   1. DEDUP pre-existing duplicate standing inbox-wake awaits to one-per-agent
 *      (keep the newest, cancel the rest with fired_reason='deduped-by-183'); then
 *   2. CREATE the partial UNIQUE INDEX the upsert's ON CONFLICT arbiter relies on.
 *
 * The empty→head `fresh-migrate` path proves the migration *applies* clean, but it
 * can never exercise step-1 — a fresh DB has no duplicates to collapse. Yet step-1
 * is load-bearing: if it left >1 row for any agent, step-2's CREATE UNIQUE INDEX
 * would throw at DEPLOY time. This test seeds the exact dirty state the live audit
 * found (e.g. s-1780806524346 had 7 standing rows) and runs the REAL migration SQL
 * file against it, asserting the dedup + index recreation behave correctly.
 *
 * No bespoke partial-migration harness needed: the migration is idempotent +
 * re-runnable (CREATE UNIQUE INDEX IF NOT EXISTS), so we take a head DB, DROP the
 * index to recreate the pre-183 "plain-insert" world, seed duplicates, and re-run
 * the file — which is precisely what step-1 → step-2 does on the live data at deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/operator-core/lib/events/await → repo root is five levels up.
const REPO_ROOT = resolve(__dirname, '../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

function readMigration183(): string {
  const file = readdirSync(SQL_DIR).find((f) => /^183-.*\.sql$/.test(f));
  if (!file) throw new Error(`migration 183 not found in ${SQL_DIR}`);
  return readFileSync(join(SQL_DIR, file), 'utf8');
}

const INDEX = 'event_awaits_inbox_wake_one_per_agent';

describe('migration 183 step-1 dedup (real SQL, real PG) — P-006', () => {
  let db: OrgTestDb;
  let migration183: string;

  beforeAll(async () => {
    db = await createOrgTestDb();
    migration183 = readMigration183();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // Insert one standing inbox-wake await row directly (bypassing the upsert), at a
  // chosen created_at so the dedup's "keep newest" ordering is deterministic.
  async function seedStandingRow(subscriber: string, createdAt: string, note: string) {
    const sql = db.adminSql;
    const [row] = await sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note, wake_handle,
         timeout_behavior, expires_ts, once, min_sleep_sec, urgency, created_at)
      VALUES
        ('ws-dedup-test', ${subscriber}, ${'coord:inbox-wake:' + subscriber}, 'wake',
         ${note}, NULL, 'expire', NULL, false, 60, false, ${createdAt}::timestamptz)
      RETURNING id
    `;
    return Number(row.id);
  }

  function activeStanding(subscriber: string) {
    return db.adminSql`
      SELECT id, note, fired_reason, cancelled_at
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${subscriber}
         AND event_key = ${'coord:inbox-wake:' + subscriber}
         AND policy = 'wake' AND once = false AND cancelled_at IS NULL
       ORDER BY id
    `;
  }

  it('collapses a pile of duplicate standing rows to ONE (newest kept), the rest cancelled with the dedup reason; then the unique index is back', async () => {
    const sql = db.adminSql;
    const agent = 's-dedup-victim';

    // Recreate the pre-183 world: drop the index so plain inserts are allowed,
    // then seed 7 duplicate standing rows (the live s-1780806524346 pileup).
    await sql.unsafe(`DROP INDEX IF EXISTS harness_shared.${INDEX}`);
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) {
      // created_at strictly increasing → row #7 is unambiguously the newest.
      ids.push(await seedStandingRow(agent, `2026-06-08T12:00:0${i}Z`, `row-${i}`));
    }
    const newestId = ids[ids.length - 1];
    expect((await activeStanding(agent)).length).toBe(7); // dirty state confirmed

    // Run the ACTUAL migration file (step-1 dedup + step-2 recreate index).
    await sql.unsafe(migration183);

    // Exactly one active standing row remains, and it is the newest one.
    const survivors = await activeStanding(agent);
    expect(survivors).toHaveLength(1);
    expect(Number(survivors[0].id)).toBe(newestId);
    expect(survivors[0].note).toBe('row-7');

    // The other six are cancelled, attributed to the dedup.
    const cancelled = await sql`
      SELECT count(*)::int AS n
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${agent}
         AND cancelled_at IS NOT NULL
         AND fired_reason = 'deduped-by-183'
    `;
    expect(cancelled[0].n).toBe(6);

    // Step-2 landed: the partial unique index exists again…
    const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = ${INDEX}`;
    expect(idx).toHaveLength(1);
    // …and it now FORBIDS a second live standing inbox-wake row for the agent.
    await expect(
      seedStandingRow(agent, '2026-06-08T13:00:00Z', 'should-violate'),
    ).rejects.toThrow(/duplicate key value|unique/i);
  });

  it('is idempotent + re-runnable: a second run with no duplicates is a clean no-op', async () => {
    const sql = db.adminSql;
    const agent = 's-dedup-clean';
    // One legitimate standing row (the post-183 steady state).
    const onlyId = await seedStandingRow(agent, '2026-06-08T12:30:00Z', 'sole');
    // Re-running the migration must neither cancel it nor error (index already present).
    await sql.unsafe(migration183);
    const survivors = await activeStanding(agent);
    expect(survivors).toHaveLength(1);
    expect(Number(survivors[0].id)).toBe(onlyId);
  });
});
