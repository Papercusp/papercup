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
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { configureCoordLog, resetCoordLog } from '../log';
import { listEscalations, listEscalationsPaginated } from '../escalations';

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
    VALUES ('escalations', ${msgId}, ${db.sql.json(body)}, ${ws})`;
}
async function insertResolve(msgId: string, relatedTo: string, ws = 'default'): Promise<void> {
  const body = { msg_id: msgId, kind: 'escalation_resolved', related_msg_id: relatedTo };
  await db.sql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id)
    VALUES ('escalations', ${msgId}, ${db.sql.json(body)}, ${ws})`;
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
  resetCoordLog();
  setFlagOverridesForTest(null);
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
      VALUES ('messages', 'm1', ${JSON.stringify({ msg_id: 'm1', kind: 'escalation' })}::text::jsonb, 'default')`;
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

  it('listEscalations(status=open) reads the projection instead of replaying the event log', async () => {
    configureCoordLog(new PgCoordLog({ getSql: () => db.sql, ensureSchema: async () => {}, workspaceId: 'default' }));
    setFlagOverridesForTest({ [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true });

    const openRows = [
      {
        ts: '2026-01-01T00:00:02.000Z',
        msg_id: 'projection-b',
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'question',
        summary: 'projection b',
        resolved: null,
      },
      {
        ts: '2026-01-01T00:00:01.000Z',
        msg_id: 'projection-a',
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'question',
        summary: 'projection a',
        resolved: null,
      },
    ] as const;

    for (const row of openRows) {
      await db.sql`
        INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
        VALUES ('default', ${row.msg_id}, ${row.ts}, ${db.sql.json(row)})`;
    }

    const got = await listEscalations({ status: 'open' });
    expect(got.map((e) => e.msg_id)).toEqual(['projection-a', 'projection-b']);
  });

  // EI-18712273081050373 — listEscalationsPaginated({status:'open'}) used to serve
  // its PAGE from a recency-windowed raw-event-log fold that never even looked at
  // this projection, so an old escalation buried under newer, fast-resolving churn
  // was unreachable no matter how large maxRecords got (live: trueOpenTotal:359,
  // page returning 0-1 rows). The fix serves the page straight from the projection
  // (which already IS the exact open set) and pages it with `offset` — this pins
  // that the WHOLE backlog is now reachable: sum of pages == trueOpenTotal.
  it('listEscalationsPaginated(status=open) is FULLY pageable via offset — sum of pages == trueOpenTotal (EI-18712273081050373)', async () => {
    configureCoordLog(new PgCoordLog({ getSql: () => db.sql, ensureSchema: async () => {}, workspaceId: 'default' }));
    setFlagOverridesForTest({ [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true });

    // Seed 7 open rows directly into the projection (mirrors the trigger's own
    // shape) with an explicit ts order so slicing is deterministic.
    const n = 7;
    for (let i = 1; i <= n; i++) {
      const msgId = `open-${String(i).padStart(2, '0')}`;
      const row = {
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: msgId,
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'question',
        summary: `escalation ${i}`,
        resolved: null,
      };
      await db.sql`
        INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
        VALUES ('default', ${msgId}, ${row.ts}, ${db.sql.json(row)})`;
    }

    // A small page size — the exact shape that used to return near-zero rows.
    const pageSize = 3;
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      const page = await listEscalationsPaginated({ status: 'open', maxRecords: pageSize, offset });
      expect(page.trueOpenTotal).toBe(n);
      seen.push(...page.escalations.map((e) => e.msg_id));
      offset += page.escalations.length;
      if (!page.truncated) break;
      guard += 1;
      expect(guard).toBeLessThan(10); // fail loudly instead of looping forever
    }

    // Every one of the 7 seeded opens was reached — the backlog is FULLY pageable,
    // not just the first (near-empty, in the old bug's repro) window.
    expect(seen.sort()).toEqual(Array.from({ length: n }, (_, i) => `open-${String(i + 1).padStart(2, '0')}`).sort());

    // The final page's own numbers must be internally consistent (no more of the
    // "trueOpenTotal:359 / page:0" contradiction the ticket reported).
    const firstPage = await listEscalationsPaginated({ status: 'open', maxRecords: pageSize, offset: 0 });
    expect(firstPage.escalations).toHaveLength(pageSize);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.offset).toBe(0);
  });
});
