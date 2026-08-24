/**
 * P-003 — one owner-loop fire-state row across arm/fire/checkpoint re-homes.
 *
 * This is intentionally broader than autoloop-state.integration.test.ts's writer
 * probes.  It drives the real routine materializer (arm), fire-slot CAS + outcome
 * writers (fire), and carry-note store (checkpoint), then repeats the lifecycle
 * under a different harness.  The final database assertion is global by owner role:
 * changing descriptive harness metadata must never mint another autoloop_state row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const WS = 'ws-owner-loop-p003';
const FIRST_HARNESS = 'papercusp';
const SECOND_HARNESS = 'rehomed-harness';
const OWNER = 'su-owner-loop-p003';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql, db: h.db }),
  };
});

vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { materializeLoop, getLoopStatus, loopRoutineName } = await import('./loop');
const { claimFire, recordFire, readFireState, resetFireErrors } = await import('../../autoloop');
const { setLoopCarryNote, getLoopCarryNote, loopScope } = await import('../../carry-note');

const ROLE = loopRoutineName(OWNER);
let org: OrgTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  h.db = drizzle(sql);
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.autoloop_state WHERE role = ${ROLE}`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS} AND name = ${ROLE}`;
  await sql`DELETE FROM harness_shared.carry_notes
             WHERE scope IN (${loopScope(FIRST_HARNESS, OWNER)}, ${loopScope(SECOND_HARNESS, OWNER)})`;
});

describe('P-003 owner-loop identity across harness scope', () => {
  it('arm → fire → checkpoint → re-home → fire → checkpoint leaves exactly one fire-state row', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: FIRST_HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first scope',
      sql,
    });
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({
      harnessSlug: FIRST_HARNESS,
      ownerId: OWNER,
      active: true,
    });

    expect(await claimFire(FIRST_HARNESS, ROLE, null, 'first-claim')).toBe(true);
    await recordFire(FIRST_HARNESS, ROLE, 'error: first scope', 'error');
    expect(await readFireState(FIRST_HARNESS, ROLE)).toMatchObject({ consecutiveErrors: 1 });

    await setLoopCarryNote(
      { harness: FIRST_HARNESS, ownerId: OWNER, workspaceId: WS },
      'checkpoint under first scope',
    );
    expect(await getLoopCarryNote({ harness: FIRST_HARNESS, ownerId: OWNER, workspaceId: WS })).toBe(
      'checkpoint under first scope',
    );

    await materializeLoop({
      workspaceId: WS,
      harnessSlug: SECOND_HARNESS,
      ownerId: OWNER,
      intervalSec: 120,
      kickoff: 'second scope',
      sql,
    });
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({
      harnessSlug: SECOND_HARNESS,
      ownerId: OWNER,
      active: true,
    });

    // A role-specific control issued through the NEW harness must still reach the
    // pre-rehome row.  This pins P-001's non-upsert write path as part of the same
    // lifecycle, rather than proving only the happy fire writer.
    expect(await resetFireErrors(SECOND_HARNESS, ROLE)).toBe(1);
    expect(await readFireState(SECOND_HARNESS, ROLE)).toMatchObject({ consecutiveErrors: 0 });

    const beforeSecondFire = await readFireState(SECOND_HARNESS, ROLE);
    expect(beforeSecondFire?.lastFiredAt).not.toBeNull();
    expect(
      await claimFire(
        SECOND_HARNESS,
        ROLE,
        beforeSecondFire!.lastFiredAt!.getTime(),
        'second-claim',
      ),
    ).toBe(true);

    // claimFire is itself a writer.  The metadata must move at the CAS boundary,
    // not only later when recordFire happens to run, or a claimed turn that dies
    // before its outcome is recorded leaves the row describing the old harness.
    const claimedRows = await sql<Array<{ harness_slug: string; last_status: string | null }>>`
      SELECT harness_slug, last_status
        FROM harness_shared.autoloop_state
       WHERE role = ${ROLE}`;
    expect(claimedRows).toEqual([{ harness_slug: SECOND_HARNESS, last_status: 'second-claim' }]);

    await recordFire(SECOND_HARNESS, ROLE, 'ok', 'ok');

    await setLoopCarryNote(
      { harness: SECOND_HARNESS, ownerId: OWNER, workspaceId: WS },
      'checkpoint under second scope',
    );
    expect(await getLoopCarryNote({ harness: SECOND_HARNESS, ownerId: OWNER, workspaceId: WS })).toBe(
      'checkpoint under second scope',
    );

    const rows = await sql<
      Array<{
        workspace_id: string;
        harness_slug: string;
        role: string;
        last_status: string | null;
        consecutive_errors: number;
      }>
    >`
      SELECT workspace_id, harness_slug, role, last_status, consecutive_errors
        FROM harness_shared.autoloop_state
       WHERE role = ${ROLE}`;

    expect(rows).toEqual([
      {
        workspace_id: WS,
        harness_slug: SECOND_HARNESS,
        role: ROLE,
        last_status: 'ok',
        consecutive_errors: 0,
      },
    ]);
    expect(await readFireState('third-unrelated-harness', ROLE)).toMatchObject({
      consecutiveErrors: 0,
    });
  });
});
