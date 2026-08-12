/**
 * WI-37757 — the auto-deactivate UPDATE must PREPARE and EXECUTE against real Postgres.
 *
 * Why this file exists at all: `validate-active-routines.test.ts` mocks `sql`, so it
 * asserts the UPDATE was *called* with the right shape. A statement that Postgres
 * cannot PREPARE is therefore invisible to it BY CONSTRUCTION — and one shipped:
 *
 *     jsonb_build_object('pausedAtMs', ${Date.now()})   -- no cast
 *     => ERROR: could not determine data type of parameter $1
 *
 * `jsonb_build_object` takes "any" arguments, so a bare parameter has no inferable
 * type. The throw was caught, logged as `[routine-validation] auto-deactivate FAILED`,
 * and the row stayed active — which silently defeated the whole self-silencing design
 * documented in enforceActiveRoutines' header comment. Measured live 2026-08-10:
 * 3 rows, active=true, pause metadata NULL, re-logging FATAL on every worker boot.
 *
 * The test drives the PRODUCTION statement through the exported `pauseUnregisteredRoutine`
 * seam rather than a copy of the SQL, so it cannot drift away from what boot runs.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/startup/validate-active-routines-sql.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  ROUTINE_VALIDATION_WAVE_MS,
  claimRoutineValidationWave,
  clearRoutineValidationMarks,
  pauseUnregisteredRoutine,
  readRoutineValidationMarks,
  writeRoutineValidationMark,
} from './validate-active-routines';
import { EMPTY_INSTALL_SLUG } from './routine-validation-episode';

let org: OrgTestDb;
let sql: Sql;

const WS = 'ws-routine-validation-sql';
const SLUG = 'papercusp/.papercusp/lib-api/search-core/_media/rerank';
const NAME = 'git-sync';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active)
    VALUES
      (${`r-${WS}`}, ${WS}, ${SLUG}, ${NAME}, 'schedule', '{}'::jsonb, 'system:git-sync', true)
  `;
});

describe('pauseUnregisteredRoutine (real Postgres)', () => {
  it('PREPAREs and pauses the row — the statement must not fail on parameter type inference', async () => {
    const updated = await pauseUnregisteredRoutine(sql as never, {
      workspaceId: WS,
      installSlug: SLUG,
      routineName: NAME,
    });

    expect(updated.map((r) => r.name)).toEqual([NAME]);

    const [row] = await sql<Array<{ active: boolean; paused_by: string | null; paused_at_ms: number | null }>>`
      SELECT active,
             metadata -> 'pause' ->> 'pausedBy' AS paused_by,
             (metadata -> 'pause' ->> 'pausedAtMs')::bigint AS paused_at_ms
        FROM harness_shared.routines
       WHERE workspace_id = ${WS} AND install_slug = ${SLUG} AND name = ${NAME}
    `;

    expect(row.active).toBe(false);
    expect(row.paused_by).toBe('routine-validation:enforce');
    // The cast must land a NUMBER in the jsonb, not a string or null — a `::text`
    // cast would "fix" the PREPARE error while writing the wrong jsonb type.
    expect(typeof row.paused_at_ms).toBe('number');
    expect(row.paused_at_ms).toBeGreaterThan(1_700_000_000_000);
  });

  it('is idempotent: a second call matches 0 rows because of the active = true predicate', async () => {
    await pauseUnregisteredRoutine(sql as never, { workspaceId: WS, installSlug: SLUG, routineName: NAME });
    const second = await pauseUnregisteredRoutine(sql as never, { workspaceId: WS, installSlug: SLUG, routineName: NAME });

    // This is the property the header comment relies on for "the FATAL simply stops
    // recurring": once paused, no later boot re-selects the row.
    expect(second).toHaveLength(0);
  });

  it('FALSIFIER: the uncast form really is rejected by Postgres, so the cast is load-bearing', async () => {
    // Proves this guard can fail, WITHOUT mutating the shared source tree to do it
    // (a mutate-and-restore probe races git-sync's whole-tree sweep and has committed
    // a mutant here before). The uncast statement is reproduced inline purely as the
    // negative control; the positive path above drives the real production statement.
    await expect(
      sql`SELECT jsonb_build_object('pausedAtMs', ${Date.now()}) AS v`,
    ).rejects.toThrow(/could not determine data type of parameter/i);

    // ...and the cast is exactly what fixes it.
    const [ok] = await sql<Array<{ v: { pausedAtMs: number } }>>`
      SELECT jsonb_build_object('pausedAtMs', ${Date.now()}::bigint) AS v
    `;
    expect(typeof ok.v.pausedAtMs).toBe('number');
  });
});

/**
 * EI-18685043834332306 — the recurrence-aging statements, for the same reason as above.
 *
 * Three things in these statements are invisible to a mocked-`sql` unit test BY CONSTRUCTION,
 * and each fails in a way that is WORSE than a crash because it makes the alarm go quiet:
 *
 *  1. `::bigint` on every `jsonb_build_object` value (WI-37757 again — a bare parameter under
 *     an "any" argument cannot be typed, so the statement never PREPAREs);
 *  2. `COALESCE(NULLIF(install_slug, ''), '<empty>')` in all four statements — the caller has
 *     already substituted that placeholder, so matching the raw column never matches the row,
 *     the wave gate is never won, and the `unpauseable-routine` class goes SILENT;
 *  3. the `CASE WHEN … ~ '^[0-9]+$'` fence around the wave-gate cast — one hand-edited mark
 *     would otherwise abort the statement, taking down the guard itself.
 *
 * All four statements are driven through their exported seams, never a copy of the SQL.
 */
const BLANK_WS = 'ws-routine-validation-episode';
const BLANK_NAME = 'orphaned-routine';
const CLS = 'unpauseable-routine' as const;

async function insertRow(workspaceId: string, installSlug: string, name: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active)
    VALUES
      (${`r-${workspaceId}-${name}`}, ${workspaceId}, ${installSlug}, ${name},
       'schedule', '{}'::jsonb, 'system:noop', true)
  `;
}

async function rawMark(name: string): Promise<unknown> {
  const [row] = await sql<Array<{ mark: unknown }>>`
    SELECT metadata->'validation'->${CLS}::text AS mark
      FROM harness_shared.routines
     WHERE workspace_id = ${BLANK_WS} AND name = ${name}
  `;
  return row?.mark ?? null;
}

describe('routine-validation episode marks (real Postgres)', () => {
  beforeEach(async () => {
    await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${BLANK_WS}`;
    // A BLANK install_slug — the exact data-integrity bug the `unpauseable-routine` FATAL
    // reports, and the case the key normalization exists for.
    await insertRow(BLANK_WS, '', BLANK_NAME);
  });

  it('PREPAREs, and round-trips a mark on a BLANK install_slug via the <empty> placeholder', async () => {
    const now = Date.now();

    // The caller passes the PLACEHOLDER, never the raw column value — `validateActiveRoutines`
    // substituted it upstream (`slug || '<empty>'`). If the statements matched the raw column
    // this would affect 0 rows, and the failure would be SILENCE rather than an error.
    const won = await claimRoutineValidationWave(sql as never, {
      workspaceId: BLANK_WS,
      installSlug: EMPTY_INSTALL_SLUG,
      routineName: BLANK_NAME,
      cls: CLS,
      mark: { firstSeenMs: now - 1000, lastSeenMs: now, occurrences: 1 },
      waveCutoffMs: now - ROUTINE_VALIDATION_WAVE_MS,
    });
    expect(won).toBe(true);

    // The `::bigint` casts must land NUMBERS in the jsonb, not strings — a `::text` cast
    // would "fix" the PREPARE error while writing the wrong jsonb type.
    const raw = (await rawMark(BLANK_NAME)) as Record<string, unknown>;
    expect(typeof raw.firstSeenMs).toBe('number');
    expect(typeof raw.lastSeenMs).toBe('number');
    expect(typeof raw.occurrences).toBe('number');

    // ...and the read seam projects the SAME normalized key the writer matched on, so a
    // successor boot recognizes its own mark.
    const marks = await readRoutineValidationMarks(sql as never, BLANK_WS, CLS);
    expect(marks).toEqual([
      {
        key: `${EMPTY_INSTALL_SLUG}/${BLANK_NAME}`,
        mark: { firstSeenMs: now - 1000, lastSeenMs: now, occurrences: 1 },
      },
    ]);
  });

  it('FALSIFIER: matching the RAW column instead of the normalized one matches 0 rows', async () => {
    // Proves the normalization is load-bearing without mutating the shared tree: the same
    // predicate against the raw column is reproduced inline purely as the negative control.
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.routines
       WHERE workspace_id = ${BLANK_WS} AND install_slug = ${EMPTY_INSTALL_SLUG}
    `;
    expect(n).toBe(0); // the row's slug is '', so the placeholder never matches it raw

    const [{ n: normalized }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.routines
       WHERE workspace_id = ${BLANK_WS}
         AND COALESCE(NULLIF(install_slug, ''), ${EMPTY_INSTALL_SLUG}) = ${EMPTY_INSTALL_SLUG}
    `;
    expect(normalized).toBe(1);
  });

  it('THE WAVE GATE serializes concurrent workers: the second claim in a wave loses', async () => {
    const now = Date.now();
    const args = {
      workspaceId: BLANK_WS,
      installSlug: EMPTY_INSTALL_SLUG,
      routineName: BLANK_NAME,
      cls: CLS,
      mark: { firstSeenMs: now, lastSeenMs: now, occurrences: 1 },
      waveCutoffMs: now - ROUTINE_VALIDATION_WAVE_MS,
    };

    expect(await claimRoutineValidationWave(sql as never, args)).toBe(true);
    // This is what stops ~15 worker processes each logging the identical FATAL line in the
    // same second — the predicate, not a lock.
    expect(await claimRoutineValidationWave(sql as never, args)).toBe(false);

    // A LATER wave (cutoff moved past the stored lastSeenMs) claims again, so the guard
    // coalesces a boot wave without ever going permanently quiet.
    expect(
      await claimRoutineValidationWave(sql as never, {
        ...args,
        waveCutoffMs: now + ROUTINE_VALIDATION_WAVE_MS,
      }),
    ).toBe(true);
  });

  it('THE CASE FENCE: a corrupt lastSeenMs re-alarms instead of aborting the statement', async () => {
    // `->>` yields TEXT. Without the regex fence the cast would raise on this row and take the
    // whole guard down — which is the exact failure this guard exists to catch, one level up.
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_build_object('validation',
               jsonb_build_object(${CLS}::text, jsonb_build_object('lastSeenMs', 'not-a-number')))
       WHERE workspace_id = ${BLANK_WS} AND name = ${BLANK_NAME}
    `;

    const now = Date.now();
    await expect(
      claimRoutineValidationWave(sql as never, {
        workspaceId: BLANK_WS,
        installSlug: EMPTY_INSTALL_SLUG,
        routineName: BLANK_NAME,
        cls: CLS,
        mark: { firstSeenMs: now, lastSeenMs: now, occurrences: 1 },
        waveCutoffMs: now - ROUTINE_VALIDATION_WAVE_MS,
      }),
    ).resolves.toBe(true); // reads as 0, i.e. older than any cutoff — fail toward alarming

    // FALSIFIER: the unfenced cast really does raise on that same value.
    await expect(
      sql`SELECT ('not-a-number')::bigint AS v`,
    ).rejects.toThrow(/invalid input syntax for type bigint/i);
  });

  it('clears marks from rows that are no longer offending, and keeps the ones that are', async () => {
    const now = Date.now();
    await insertRow(BLANK_WS, 'still-broken', 'other-routine');
    const m = { firstSeenMs: now, lastSeenMs: now, occurrences: 1 };

    await writeRoutineValidationMark(sql as never, {
      workspaceId: BLANK_WS, installSlug: EMPTY_INSTALL_SLUG, routineName: BLANK_NAME, cls: CLS, mark: m,
    });
    await writeRoutineValidationMark(sql as never, {
      workspaceId: BLANK_WS, installSlug: 'still-broken', routineName: 'other-routine', cls: CLS, mark: m,
    });

    const cleared = await clearRoutineValidationMarks(sql as never, BLANK_WS, CLS, [
      'still-broken/other-routine',
    ]);

    // The count is not cosmetic: it is what tells the summary the offender set SHRANK, which
    // is half of the transition test.
    expect(cleared).toBe(1);
    expect(await rawMark(BLANK_NAME)).toBeNull();
    expect(await rawMark('other-routine')).not.toBeNull();
  });

  it('an EMPTY current-offender list clears every mark for the class', async () => {
    const now = Date.now();
    await writeRoutineValidationMark(sql as never, {
      workspaceId: BLANK_WS,
      installSlug: EMPTY_INSTALL_SLUG,
      routineName: BLANK_NAME,
      cls: CLS,
      mark: { firstSeenMs: now, lastSeenMs: now, occurrences: 1 },
    });

    // No offenders means the condition is fully resolved, so the episode must end — otherwise
    // a fixed routine carries a stale episode forever and the NEXT occurrence reads as chronic.
    expect(await clearRoutineValidationMarks(sql as never, BLANK_WS, CLS, [])).toBe(1);
    expect(await readRoutineValidationMarks(sql as never, BLANK_WS, CLS)).toEqual([]);
  });
});
