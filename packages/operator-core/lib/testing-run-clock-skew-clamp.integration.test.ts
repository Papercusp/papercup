/**
 * testing-run-clock-skew-clamp.integration.test.ts — pins migration 850's
 * BEFORE INSERT OR UPDATE trigger on harness_shared.test_runs against REAL
 * Postgres (testcontainer + the full migrated baseline).
 *
 * EI-20857750690095410 / EI-20816222655077027: a vitest run under a faked
 * process clock (measured at exactly +30d and +365d offsets) wrote 47 rows whose
 * started_at/finished_at were months in the FUTURE. Both recency indexes on this
 * table are `... finished_at DESC`, so those rows won every latestPerFile /
 * sinceHours slice for their file and masked the real results — a full-looking,
 * ok-returning read that is silently wrong.
 *
 * The guard is in the DATABASE, not the reporter, because (a) there are 7+
 * INSERT sites and two of them are bundled build artifacts (serve.mjs) no
 * source-level clamp can reach, and (b) a writer running under a faked clock
 * cannot detect its own skew — comparing new Date() to new Date() always agrees.
 * now() is the one clock a test process cannot fake.
 *
 * WHAT THIS FILE PINS — the OUTCOME, not just the mechanism:
 *   - a far-future finished_at is clamped, with duration_ms PRESERVED;
 *   - the recency ordering the bug actually broke (a poisoned row must not
 *     outrank a real newer run for the same file);
 *   - the UPDATE path, not just INSERT;
 *   - a 'running' row (finished_at NULL) with a future started_at.
 *
 * CALIBRATION CONTROLS (load-bearing — without them the clamp assertions pass
 * vacuously): a trigger that simply stamped now() onto EVERY row would satisfy
 * every "is it sane now?" assertion above. So we also pin that an ordinary past
 * row is returned BYTE-IDENTICAL, and that a within-tolerance future row is
 * left alone — which is what proves the tolerance is a real boundary rather
 * than zero.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';

/** Migration 850, read from disk so this test pins the FILE, not a copy of its
 *  intent — and so it works whether or not the draft has been armed yet. */
function readMigration850(): string {
  const armed = fileURLToPath(
    new URL('../../../libs/papercusp/libs/db/sql/850-test-runs-future-timestamp-clamp.sql', import.meta.url),
  );
  const draft = `${armed}.DRAFT`;
  const path = existsSync(armed) ? armed : draft;
  if (!existsSync(path)) throw new Error(`migration 850 not found at ${armed} or ${draft}`);
  const text = readFileSync(path, 'utf8');
  // Guard against a silently-empty read making every assertion below vacuous.
  if (!text.includes('test_runs_clamp_future_timestamps')) {
    throw new Error(`migration 850 at ${path} does not define the clamp trigger`);
  }
  return text;
}

const FRAMEWORK = 'vitest';

describe('migration 850 — test_runs future-timestamp clamp', () => {
  let db: OrgTestDb;
  let sql: OrgTestDb['adminSql'];

  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    // Idempotent (CREATE OR REPLACE / DROP TRIGGER IF EXISTS), so applying it
    // here is safe whether or not the migration runner already did.
    await sql.unsafe(readMigration850()).simple();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** Insert one row with server-computed timestamps, then read back the stored
   *  values plus sanity predicates evaluated IN SQL (no JS timezone parsing). */
  async function insertAndRead(opts: {
    filePath: string;
    durationMs: number | null;
    startedExpr: string;
    finishedExpr: string | null;
  }) {
    const [ins] = await sql.unsafe<{ id: number }[]>(
      `INSERT INTO harness_shared.test_runs
         (file_path, framework, status, duration_ms, started_at, finished_at, source, branch)
       VALUES ($1, $2, 'fail', $3, ${opts.startedExpr}, ${opts.finishedExpr ?? 'NULL'}, 'local', 'staging')
       RETURNING id`,
      [opts.filePath, FRAMEWORK, opts.durationMs],
    );
    const [row] = await sql.unsafe<
      {
        finished_sane: boolean;
        started_sane: boolean;
        span_secs: string | null;
        finished_null: boolean;
        drift_secs: string | null;
      }[]
    >(
      `SELECT finished_at IS NULL AS finished_null,
              COALESCE(finished_at <= now() + interval '5 minutes', true) AS finished_sane,
              started_at <= now() + interval '5 minutes' AS started_sane,
              EXTRACT(EPOCH FROM (finished_at - started_at))::text AS span_secs,
              EXTRACT(EPOCH FROM (now() - COALESCE(finished_at, started_at)))::text AS drift_secs
         FROM harness_shared.test_runs WHERE id = $1`,
      [ins.id],
    );
    return { id: ins.id, ...row };
  }

  it('clamps a far-future finished_at to the DB clock and PRESERVES duration_ms', async () => {
    const r = await insertAndRead({
      filePath: 'packages/operator-core/lib/__clamp-far-future.test.ts',
      durationMs: 5000,
      startedExpr: `now() + interval '365 days' - interval '5 seconds'`,
      finishedExpr: `now() + interval '365 days'`,
    });

    expect(r.finished_sane).toBe(true);
    expect(r.started_sane).toBe(true);
    // The run really took 5s; a constant clock offset does not change an
    // elapsed delta, so the span must survive the clamp intact.
    expect(Number(r.span_secs)).toBeCloseTo(5, 1);
    // And it must land at ~now, not merely "not in the future".
    expect(Math.abs(Number(r.drift_secs))).toBeLessThan(120);
  });

  it('clamps the UPDATE path too, not just INSERT', async () => {
    const r = await insertAndRead({
      filePath: 'packages/operator-core/lib/__clamp-update.test.ts',
      durationMs: 250,
      startedExpr: `now() - interval '1 hour'`,
      finishedExpr: `now() - interval '1 hour' + interval '250 milliseconds'`,
    });

    await sql.unsafe(
      `UPDATE harness_shared.test_runs
          SET finished_at = now() + interval '30 days'
        WHERE id = $1`,
      [r.id],
    );

    const [after] = await sql.unsafe<{ finished_sane: boolean }[]>(
      `SELECT finished_at <= now() + interval '5 minutes' AS finished_sane
         FROM harness_shared.test_runs WHERE id = $1`,
      [r.id],
    );
    expect(after.finished_sane).toBe(true);
  });

  it("clamps a 'running' row whose started_at is in the future (finished_at NULL)", async () => {
    const r = await insertAndRead({
      filePath: 'packages/operator-core/lib/__clamp-running.test.ts',
      durationMs: null,
      startedExpr: `now() + interval '200 days'`,
      finishedExpr: null,
    });
    expect(r.finished_null).toBe(true);
    expect(r.started_sane).toBe(true);
  });

  // ---- The property the bug actually broke -------------------------------
  it('a poisoned row no longer outranks a real newer run for the same file', async () => {
    const filePath = 'packages/operator-core/lib/__clamp-recency.test.ts';

    // A poisoned row, written the way the faked-clock run wrote them...
    await insertAndRead({
      filePath,
      durationMs: 0,
      startedExpr: `now() + interval '365 days'`,
      finishedExpr: `now() + interval '365 days'`,
    });
    // ...then the REAL, later run that triage actually needs to see.
    const [real] = await sql.unsafe<{ id: number }[]>(
      `INSERT INTO harness_shared.test_runs
         (file_path, framework, status, duration_ms, started_at, finished_at, source, branch)
       VALUES ($1, $2, 'pass', 12, now(), now(), 'local', 'staging')
       RETURNING id`,
      [filePath, FRAMEWORK],
    );

    // This is the ordering every latestPerFile / file-history read uses.
    const [top] = await sql.unsafe<{ id: number; status: string }[]>(
      `SELECT id, status FROM harness_shared.test_runs
        WHERE file_path = $1
        ORDER BY finished_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [filePath],
    );
    expect(top.id).toBe(real.id);
    expect(top.status).toBe('pass');
  });

  // ---- Calibration controls ----------------------------------------------
  it('CONTROL: leaves an ordinary past row byte-identical (the clamp is not "stamp now() on everything")', async () => {
    const filePath = 'packages/operator-core/lib/__clamp-control-past.test.ts';
    const [ins] = await sql.unsafe<{ id: number }[]>(
      `INSERT INTO harness_shared.test_runs
         (file_path, framework, status, duration_ms, started_at, finished_at, source, branch)
       VALUES ($1, $2, 'pass', 1667,
               timestamptz '2026-08-09 23:07:00+00', timestamptz '2026-08-09 23:07:02+00',
               'local', 'staging')
       RETURNING id`,
      [filePath, FRAMEWORK],
    );
    const [row] = await sql.unsafe<{ started_iso: string; finished_iso: string }[]>(
      `SELECT to_char(started_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS started_iso,
              to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS finished_iso
         FROM harness_shared.test_runs WHERE id = $1`,
      [ins.id],
    );
    expect(row.started_iso).toBe('2026-08-09 23:07:00');
    expect(row.finished_iso).toBe('2026-08-09 23:07:02');
  });

  it('CONTROL: leaves a WITHIN-tolerance future row alone (the tolerance is a real boundary, not zero)', async () => {
    const filePath = 'packages/operator-core/lib/__clamp-control-tolerance.test.ts';
    const [ins] = await sql.unsafe<{ id: number }[]>(
      `INSERT INTO harness_shared.test_runs
         (file_path, framework, status, duration_ms, started_at, finished_at, source, branch)
       VALUES ($1, $2, 'pass', 100, now() + interval '60 seconds', now() + interval '60 seconds', 'local', 'staging')
       RETURNING id`,
      [filePath, FRAMEWORK],
    );
    const [row] = await sql.unsafe<{ still_future: boolean }[]>(
      `SELECT finished_at > now() + interval '30 seconds' AS still_future
         FROM harness_shared.test_runs WHERE id = $1`,
      [ins.id],
    );
    // Untouched: benign app-host-vs-DB clock offset must not be rewritten.
    expect(row.still_future).toBe(true);
  });
});
