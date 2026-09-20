/**
 * gate-reaper.integration.test.ts — `sweepSessionIndependentGates` against real Postgres.
 *
 * WI-10002067 REGRESSION GUARD. The close UPDATE cast the gate id to `::uuid`
 * while `harness_shared.session_pending_gates.id` is BIGINT, so the FIRST gate
 * that qualified raised SQLSTATE 22P02 — and because that `await` sits inside
 * the per-row loop with no inner catch, one throw aborted the ENTIRE sweep,
 * which `gate-watch-action`'s outer try/catch then swallowed into a log line
 * that never reached the journal.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `gate-reaper.test.ts`: that file covers
 * `decideGateReap`, a pure function, and stayed fully green the whole time the
 * feature was broken — nothing in it ever lets the sweep WRITE. A cast error
 * lives only in the SQL, so only a test that executes the real statement can
 * see it. The measured production signature was transcript-watcher closes
 * landing normally while asker_gone/default_applied sat at exactly zero
 * against 238 open gates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-gate-reaper-test';

const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { sweepSessionIndependentGates } = await import('./gate-reaper');

let org: OrgTestDb;
let sql: Sql;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Insert one open gate aged `openedAgoMs` in the past, with no `coord_presence`
 *  row and no `adv_sessions` row — so its asker resolves to `unknown` and the
 *  age floor alone decides. That keeps the fixture to a single table. */
async function insertGate(sessionId: string, openedAgoMs: number): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.session_pending_gates
      (workspace_id, session_id, client, kind, ref_id, question, source, opened_at)
    VALUES (
      ${WS}, ${sessionId}, 'claude', 'permission_wait', ${`ref:${sessionId}`},
      'does this gate close?', 'watcher',
      now() - (${openedAgoMs}::bigint * interval '1 millisecond')
    )
    RETURNING id::text AS id
  `;
  return rows[0]!.id;
}

async function readGate(id: string) {
  const rows = await sql<Array<{ closed_reason: string | null; closed_at: Date | null }>>`
    SELECT closed_reason, closed_at
      FROM harness_shared.session_pending_gates
     WHERE id = ${id}::bigint
  `;
  return rows[0];
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  // Deliberately UNSCOPED: the sweep's own SELECT carries no workspace_id
  // predicate, so it examines gates across every tenant in the database. A
  // WHERE workspace_id = WS cleanup would leave foreign rows visible to the
  // sweep and make the counter assertions below non-deterministic.
  await sql`DELETE FROM harness_shared.session_pending_gates`;
});

describe('sweepSessionIndependentGates (real PG)', () => {
  it('CLOSES an aged gate whose asker cannot be observed, writing closed_reason=asker_gone', async () => {
    const id = await insertGate('sess-aged', 60 * DAY_MS);

    const result = await sweepSessionIndependentGates({ limit: 50 });

    expect(result.examined).toBe(1);
    expect(result.closedAskerGone).toBe(1);

    // THE load-bearing assertion. The counters above are computed before the
    // UPDATE runs, so they stay correct even when every write throws — which is
    // exactly how the ::uuid regression stayed invisible. Only reading the row
    // back proves the close actually reached Postgres.
    const row = await readGate(id);
    expect(row?.closed_at).not.toBeNull();
    expect(row?.closed_reason).toBe('asker_gone');
  });

  it('LEAVES a gate inside the unknown-grace window open — calibration, so a close-everything mutant cannot pass', async () => {
    const id = await insertGate('sess-fresh', 1 * DAY_MS);

    const result = await sweepSessionIndependentGates({ limit: 50 });

    expect(result.examined).toBe(1);
    expect(result.closedAskerGone).toBe(0);
    expect(result.skipped['asker-unknown-within-grace']).toBe(1);

    const row = await readGate(id);
    expect(row?.closed_at).toBeNull();
    expect(row?.closed_reason).toBeNull();
  });

  it('honours `limit` as a COUNT of gates examined, not a duration', async () => {
    for (let i = 0; i < 4; i += 1) await insertGate(`sess-bulk-${i}`, 60 * DAY_MS);

    const result = await sweepSessionIndependentGates({ limit: 2 });

    // `limit` reaches the sweep through `readPositiveMs`, whose name suggests
    // milliseconds; this pins that a small integer is honoured verbatim as a
    // row budget, so a future unit conversion there cannot pass silently.
    expect(result.examined).toBe(2);
    expect(result.closedAskerGone).toBe(2);
    expect(result.truncatedByLimit).toBe(true);

    const [{ still_open }] = await sql<Array<{ still_open: string }>>`
      SELECT count(*)::text AS still_open
        FROM harness_shared.session_pending_gates
       WHERE closed_at IS NULL
    `;
    expect(still_open).toBe('2');
  });
});
