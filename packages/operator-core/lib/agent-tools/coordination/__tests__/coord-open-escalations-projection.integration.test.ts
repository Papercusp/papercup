/**
 * coord-open-escalations-projection.integration.test.ts — P-005 (migration 355).
 *
 * Verifies the incremental trigger that maintains
 * harness_shared.coord_open_escalations (the materialized open-escalations
 * projection that replaces the unbounded ~35k-event full-surface replay in
 * listEscalations({status:'open'}) — pg_stat_statements pinned that replay as
 * ~88% of DB exec time).
 *
 * Applies the REAL migration file against a fresh PG + a minimal coord_event_log,
 * then drives inserts directly: an 'escalation' event adds the open row, an
 * 'escalation_resolved' event removes it, the WHEN(surface='escalations') guard
 * keeps it off the hot non-escalation write path, and the in-file backfill/prune
 * reconciles a pre-existing log. (The backfill's open-set SQL is also verified
 * against the live ~35k-event corpus separately — there 108 opens, matching the
 * fold.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

// Minimal coord_event_log shape (the migration references the table; the prod
// table has more columns but the trigger only reads surface/workspace_id/msg_id/
// ts/body). id is an identity PK so inserts order naturally.
const COORD_EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    surface      text        NOT NULL,
    writer_key   text,
    msg_id       text        NOT NULL,
    body         jsonb       NOT NULL,
    ts           timestamptz NOT NULL DEFAULT now(),
    workspace_id text        NOT NULL DEFAULT 'default',
    harness_slug text
  )`;

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ -> coordination -> agent-tools -> lib -> operator-core -> packages -> repo root
const repoRoot = join(here, '..', '..', '..', '..', '..', '..');
const MIG_355 = readFileSync(
  join(repoRoot, 'libs/papercusp/libs/db/sql/355-coord-open-escalations-projection.sql'),
  'utf8',
);

let db: FreshPgDb;

async function insertOpen(msgId: string, ws = 'default'): Promise<void> {
  const body = { msg_id: msgId, kind: 'escalation', summary: msgId, resolved: null };
  await db.sql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id)
    VALUES ('escalations', ${msgId}, ${JSON.stringify(body)}::jsonb, ${ws})`;
}
async function insertResolve(msgId: string, relatedTo: string, ws = 'default'): Promise<void> {
  const body = { msg_id: msgId, kind: 'escalation_resolved', related_msg_id: relatedTo };
  await db.sql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id)
    VALUES ('escalations', ${msgId}, ${JSON.stringify(body)}::jsonb, ${ws})`;
}
async function openMsgIds(ws = 'default'): Promise<string[]> {
  const rows = await db.sql<{ msg_id: string }[]>`
    SELECT msg_id FROM harness_shared.coord_open_escalations
     WHERE workspace_id = ${ws} ORDER BY msg_id`;
  return rows.map((r) => r.msg_id);
}

beforeAll(async () => {
  db = await createFreshPgDb('coord-open-esc');
  await db.sql.unsafe(COORD_EVENT_LOG_DDL);
  // .simple() runs ALL statements in the migration (the dollar-quoted function +
  // trigger + backfill) via the simple-query protocol; without it, unsafe() runs
  // only the first statement.
  await db.sql.unsafe(MIG_355).simple();
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.coord_event_log`;
  await db.sql`DELETE FROM harness_shared.coord_open_escalations`;
});

describe('coord_open_escalations projection trigger (migration 355)', () => {
  it('an escalation insert adds an open row; a sibling resolve removes it', async () => {
    await insertOpen('e1');
    expect(await openMsgIds()).toEqual(['e1']);

    await insertOpen('e2');
    expect(await openMsgIds()).toEqual(['e1', 'e2']);

    await insertResolve('r1', 'e1');
    expect(await openMsgIds()).toEqual(['e2']); // e1 resolved -> gone

    await insertResolve('r2', 'e2');
    expect(await openMsgIds()).toEqual([]); // both resolved
  });

  it('is workspace-scoped (a resolve only removes its own workspace row)', async () => {
    await insertOpen('e1', 'wsA');
    await insertOpen('e1', 'wsB'); // same msg_id, different workspace
    expect(await openMsgIds('wsA')).toEqual(['e1']);
    expect(await openMsgIds('wsB')).toEqual(['e1']);

    await insertResolve('r1', 'e1', 'wsA'); // resolve only wsA's e1
    expect(await openMsgIds('wsA')).toEqual([]);
    expect(await openMsgIds('wsB')).toEqual(['e1']); // wsB untouched
  });

  it('does NOT fire for non-escalation surfaces (WHEN guard keeps the hot path clean)', async () => {
    // A messages-surface row whose body even claims kind:'escalation' must be ignored.
    await db.sql`
      INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id)
      VALUES ('messages', 'm1', ${JSON.stringify({ msg_id: 'm1', kind: 'escalation' })}::jsonb, 'default')`;
    const n = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.coord_open_escalations`;
    expect(n[0].n).toBe(0);
  });

  it('backfill/prune reconciles a pre-existing log when the migration re-runs', async () => {
    // Seed BEFORE the projection exists by disabling the trigger, so only the
    // re-run backfill can reconcile (mirrors applying mig 355 to a populated DB).
    await db.sql`ALTER TABLE harness_shared.coord_event_log DISABLE TRIGGER coord_open_escalations_trg`;
    await insertOpen('e1'); // open, stays open
    await insertOpen('e2'); // will be resolved
    await insertResolve('r1', 'e2');
    await db.sql`ALTER TABLE harness_shared.coord_event_log ENABLE TRIGGER coord_open_escalations_trg`;
    expect(await openMsgIds()).toEqual([]); // projection still empty (trigger was off)

    // Re-run the migration's backfill/prune (idempotent) — should land exactly {e1}.
    await db.sql.unsafe(MIG_355).simple();
    expect(await openMsgIds()).toEqual(['e1']);
  });
});
