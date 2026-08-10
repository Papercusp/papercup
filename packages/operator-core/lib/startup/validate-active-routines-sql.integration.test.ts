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
import { pauseUnregisteredRoutine } from './validate-active-routines';

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
