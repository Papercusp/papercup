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
import { existsSync, readFileSync } from 'node:fs';
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
const MIG_1094 = readFileSync(
  join(repoRoot, 'libs/papercusp/libs/db/sql/1094-coord-open-escalations-trigger-update-fix.sql'),
  'utf8',
);
const MIG_1112_BASE = join(
  repoRoot,
  'libs/papercusp/libs/db/sql/1112-prevent-resolved-escalation-projection-resurrection.sql',
);
const MIG_1112 = readFileSync(existsSync(MIG_1112_BASE) ? MIG_1112_BASE : `${MIG_1112_BASE}.DRAFT`, 'utf8');

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
async function insertReopen(msgId: string, relatedTo: string, ws = 'default'): Promise<void> {
  const body = { msg_id: msgId, kind: 'escalation_reopened', related_msg_id: relatedTo };
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
  // The real ensureCoordEventLogTable (pg-log.ts) also creates this partial
  // unique index; the EI-22091069492876324 regression test below needs it, as
  // real coordLog.putEvent() writes rely on it for `ON CONFLICT (workspace_id,
  // surface, msg_id) WHERE surface IN (...)` to resolve to an arbiter index.
  await db.sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_event_uq
      ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
      WHERE surface IN ('handoffs', 'escalations')
  `);
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

  // EI-22091069492876324: openEscalation()'s coalesce/refresh fallback path
  // (findOpenDuplicate -> coordLog.putEvent) refreshes an EXISTING escalation's
  // coord_event_log row via `INSERT ... ON CONFLICT (workspace_id, surface,
  // msg_id) DO UPDATE`. Because the trigger this test's suite otherwise exercises
  // was `AFTER INSERT ONLY`, Postgres never fires it for a row that resolved via
  // the ON CONFLICT DO UPDATE arm -- so that refresh updated coord_event_log.body
  // (repeatCount/lastSeenTs advancing) while coord_open_escalations stayed frozen
  // at whatever it last held, PERMANENTLY (nothing else ever repairs it). This
  // reproduces the pre-fix bug against migration 355 alone, then proves 1094
  // (AFTER INSERT OR UPDATE + a real refresh instead of DO NOTHING) heals it.
  it('a coalesce-refresh via ON CONFLICT DO UPDATE (coordLog.putEvent) is invisible to the projection under 355 alone, and self-heals once 1094 is applied (EI-22091069492876324)', async () => {
    const upsertViaPutEventShape = async (repeatCount: number, summary: string) => {
      // Mirrors PgCoordLog.putEvent's EXACT statement shape (pg-log.ts) for the
      // 'escalations' surface -- the write path openEscalation's findOpenDuplicate
      // fallback actually takes.
      const body = { msg_id: 'e1', kind: 'escalation', summary, resolved: null, repeatCount };
      await db.sql`
        INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id)
        VALUES ('escalations', 'e1', ${db.sql.json(body)}, 'default')
        ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
        DO UPDATE SET body = EXCLUDED.body, ts = now()`;
    };
    const projectionBody = async (): Promise<{ repeatCount: number } | null> => {
      const rows = await db.sql<{ body: { repeatCount: number } }[]>`
        SELECT body FROM harness_shared.coord_open_escalations
         WHERE workspace_id = 'default' AND msg_id = 'e1'`;
      return rows[0]?.body ?? null;
    };

    // First write: a genuine INSERT (no prior 'e1' row) -- the trigger fires
    // normally under 355 alone; this is not yet the bug.
    await upsertViaPutEventShape(1, 'goal idle for <dur>');
    expect((await projectionBody())?.repeatCount).toBe(1);

    // Second write: 'e1' already exists, so this resolves via ON CONFLICT DO
    // UPDATE -- under migration 355's AFTER-INSERT-ONLY trigger this must NOT
    // reach the projection. Pinning this false is what makes the guard below
    // falsifiable: without 1094, the final assertion cannot pass.
    await upsertViaPutEventShape(2, 'goal idle for <dur>');
    expect((await projectionBody())?.repeatCount).toBe(1); // frozen — reproduces the bug

    // A further round of drift, exactly like the live incident (repeatCount
    // climbing in coord_event_log while the projection sits stuck at 1).
    await upsertViaPutEventShape(3, 'goal idle for <dur>');
    expect((await projectionBody())?.repeatCount).toBe(1); // still frozen

    // Apply the fix migration (idempotent CREATE OR REPLACE + trigger swap) on
    // this SAME connection/schema -- no fresh DB needed.
    await db.sql.unsafe(MIG_1094).simple();

    // The one-shot repair backfill inside 1094 must have healed the ALREADY
    // stale row immediately, without waiting for another write.
    expect((await projectionBody())?.repeatCount).toBe(3);

    // And the trigger must now fire on the SAME ON-CONFLICT-DO-UPDATE shape that
    // was silently swallowed before.
    await upsertViaPutEventShape(4, 'goal idle for <dur>');
    expect((await projectionBody())?.repeatCount).toBe(4);
  });

  // EI-22364876614483312: migration 1094's UPDATE trigger fixed stale open
  // metadata, but it treated an update of the original escalation as if it were
  // a new open. A later resolve was therefore undone whenever putEvent refreshed
  // the original. The latest lifecycle sibling -- not the row that happened to
  // fire the trigger -- must govern projection membership.
  it('an UPDATE of a resolved original cannot resurrect it, and stale sibling updates cannot override the latest lifecycle event (EI-22364876614483312)', async () => {
    // Establish the exact pre-fix trigger, independent of test order.
    await db.sql.unsafe(MIG_1094).simple();
    await insertOpen('e1');
    await insertResolve('r1', 'e1');
    expect(await openMsgIds()).toEqual([]);

    // Updating the immutable original after its resolve fires migration 1094's
    // unconditional escalation upsert and reproduces the live zombie row.
    await db.sql`
      UPDATE harness_shared.coord_event_log
         SET body = body || ${db.sql.json({ repeatCount: 2 })}
       WHERE workspace_id = 'default'
         AND surface = 'escalations'
         AND msg_id = 'e1'`;
    expect(await openMsgIds()).toEqual(['e1']);

    // Applying 1112 cleans the already-resurrected row immediately.
    await db.sql.unsafe(MIG_1112).simple();
    expect(await openMsgIds()).toEqual([]);

    // The same original UPDATE shape stays closed after the trigger repair.
    await db.sql`
      UPDATE harness_shared.coord_event_log
         SET body = body || ${db.sql.json({ repeatCount: 3 })}
       WHERE workspace_id = 'default'
         AND surface = 'escalations'
         AND msg_id = 'e1'`;
    expect(await openMsgIds()).toEqual([]);

    // A genuine later reopen makes it open. Updating the older resolve must not
    // close it again, because the newer reopen remains authoritative.
    await insertReopen('o1', 'e1');
    expect(await openMsgIds()).toEqual(['e1']);
    await db.sql`
      UPDATE harness_shared.coord_event_log
         SET body = body || ${db.sql.json({ note: 'old resolve refreshed' })}
       WHERE workspace_id = 'default'
         AND surface = 'escalations'
         AND msg_id = 'r1'`;
    expect(await openMsgIds()).toEqual(['e1']);

    // Symmetrically, a newer resolve closes it, and updating the older reopen
    // cannot resurrect it.
    await insertResolve('r2', 'e1');
    expect(await openMsgIds()).toEqual([]);
    await db.sql`
      UPDATE harness_shared.coord_event_log
         SET body = body || ${db.sql.json({ note: 'old reopen refreshed' })}
       WHERE workspace_id = 'default'
         AND surface = 'escalations'
         AND msg_id = 'o1'`;
    expect(await openMsgIds()).toEqual([]);
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

  // EI-19938772014458100 — the projection is sorted ASCENDING (oldest-first), and
  // slicing it from the front with offset:0 silently served the OLDEST maxRecords
  // rows while the tool documents (and every caller assumes) "newest-first". A
  // workspace with more than maxRecords open escalations therefore had every
  // RECENT escalation — including fresh blockers — permanently unreachable from
  // the default, no-args call. This pins that the DEFAULT page contains the
  // newest rows, not the oldest.
  it('the DEFAULT (no offset) page of listEscalationsPaginated(status=open) contains the NEWEST rows (EI-19938772014458100)', async () => {
    configureCoordLog(new PgCoordLog({ getSql: () => db.sql, ensureSchema: async () => {}, workspaceId: 'default' }));
    setFlagOverridesForTest({ [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true });

    // Seed a backlog wider than maxRecords, spanning an OLD cluster and a
    // RECENT cluster of timestamps — exactly the "old, never-resolved rows
    // bury fresh ones" shape from the bug report.
    const oldCount = 5;
    const recentCount = 5;
    const maxRecords = 3;
    for (let i = 1; i <= oldCount; i++) {
      const msgId = `old-${String(i).padStart(2, '0')}`;
      const row = {
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: msgId,
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'question',
        summary: `old escalation ${i}`,
        resolved: null,
      };
      await db.sql`
        INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
        VALUES ('default', ${msgId}, ${row.ts}, ${db.sql.json(row)})`;
    }
    for (let i = 1; i <= recentCount; i++) {
      const msgId = `recent-${String(i).padStart(2, '0')}`;
      const row = {
        ts: `2026-08-09T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: msgId,
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'blocker',
        summary: `recent escalation ${i}`,
        resolved: null,
      };
      await db.sql`
        INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
        VALUES ('default', ${msgId}, ${row.ts}, ${db.sql.json(row)})`;
    }
    const all = [
      ...Array.from({ length: oldCount }, (_, i) => `old-${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: recentCount }, (_, i) => `recent-${String(i + 1).padStart(2, '0')}`),
    ];

    const defaultPage = await listEscalationsPaginated({ status: 'open', maxRecords });
    expect(defaultPage.trueOpenTotal).toBe(oldCount + recentCount);
    // The newest `maxRecords` rows are the tail of `all` (all is already in ts order).
    expect(defaultPage.escalations.map((e) => e.msg_id)).toEqual(all.slice(-maxRecords));
    // Within the page, order stays ascending (byte-identical to the fold path).
    const pageTs = defaultPage.escalations.map((e) => e.ts);
    expect([...pageTs].sort()).toEqual(pageTs);
    // The newest row overall must be the LAST row of the default page.
    expect(defaultPage.escalations.at(-1)?.msg_id).toBe('recent-05');
  });

  // EI-15377: conditionKey/q on the PROJECTION fast path must see the WHOLE open
  // set (not a recency window) and must never carry filterWindowCaveat — that
  // flag exists specifically to warn about the legacy windowed fold path, which
  // this leg never falls back to when the projection read succeeds.
  it('conditionKey/q filter the COMPLETE open set via the projection and never carry filterWindowCaveat (EI-15377)', async () => {
    configureCoordLog(new PgCoordLog({ getSql: () => db.sql, ensureSchema: async () => {}, workspaceId: 'default' }));
    setFlagOverridesForTest({ [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true });

    // An OLD row that a small recency-windowed maxRecords would never reach on
    // the legacy fold path, to prove this leg reads the whole set regardless.
    const oldMatch = {
      ts: '2020-01-01T00:00:00.000Z',
      msg_id: 'old-dead-routines',
      from: 'A',
      to: ['human'],
      kind: 'escalation',
      severity: 'advisory',
      summary: 'dead routines stale',
      subjectSignature: 'dead-routines-papercusp',
      resolved: null,
    };
    // Many newer, unrelated rows crowding the recency window.
    for (let i = 1; i <= 10; i++) {
      const msgId = `noise-${String(i).padStart(2, '0')}`;
      const row = {
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: msgId,
        from: 'A',
        to: ['human'],
        kind: 'escalation',
        severity: 'advisory',
        summary: `unrelated noise ${i}`,
        resolved: null,
      };
      await db.sql`
        INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
        VALUES ('default', ${msgId}, ${row.ts}, ${db.sql.json(row)})`;
    }
    await db.sql`
      INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
      VALUES ('default', ${oldMatch.msg_id}, ${oldMatch.ts}, ${db.sql.json(oldMatch)})`;

    // A small maxRecords that would bury the old row under the noise on the
    // legacy fold path — the projection leg must still find it via conditionKey.
    const byKey = await listEscalationsPaginated({
      status: 'open',
      maxRecords: 3,
      conditionKey: 'dead-routines-papercusp',
    });
    expect(byKey.escalations.map((e) => e.msg_id)).toEqual(['old-dead-routines']);
    expect(byKey.filterWindowCaveat).toBeUndefined();

    const byQ = await listEscalationsPaginated({ status: 'open', maxRecords: 3, q: 'dead routines' });
    expect(byQ.escalations.map((e) => e.msg_id)).toEqual(['old-dead-routines']);
    expect(byQ.filterWindowCaveat).toBeUndefined();

    // A genuine miss against the complete open set proves absence (no caveat).
    const miss = await listEscalationsPaginated({ status: 'open', maxRecords: 3, conditionKey: 'no-such-key' });
    expect(miss.escalations).toEqual([]);
    expect(miss.filterWindowCaveat).toBeUndefined();
  });
});
