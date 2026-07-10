/**
 * P-050 dual-impl proof for CoordEventLog: run the SHARED conformance suite
 * (the one InMemoryCoordLog + FsCoordLog pass in
 * packages/coordination/src/event-log/event-log.test.ts) against the
 * PRODUCTION-grade `PgCoordLog` over a real Postgres handle. Three backends
 * passing the SAME assertions is what makes the "optional PG log" swappable
 * (P-011) and the dual-impl claim real (P-050) — the event-log analogue of
 * the peer's presence-conformance.test.ts.
 *
 * Connects via `connectionString()` (env→discovery→fallback, the resolver
 * `pgClientFields` uses — `getOrgPg()` needs an operator bootstrap a
 * standalone vitest run lacks) and mirrors getOrgPg()'s postgres-js options
 * (esp. `prepare: false`, which governs jsonb round-tripping). The
 * `coord_event_log` table is created idempotently via the package's own
 * `ensureCoordEventLogTable`, so the proof RUNS wherever PG is reachable —
 * live operator or CI testcontainer — and soft-skips only when no PG exists.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import { describeCoordEventLogConformance } from '@papercusp/coordination/event-log/conformance';
import { connectionString } from '../../../memory/mem0-connection';

let sql: Sql | null = null;
let pgOk = false;

try {
  const url = await connectionString();
  sql = postgres(url, {
    onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    prepare: false,
    max: 4,
  });
  await sql`SELECT 1`;
  await ensureCoordEventLogTable(sql);
  pgOk = true;
} catch (e) {
   
  console.error('[event-log-conformance] PG not reachable, skipping:', (e as Error)?.message);
}

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

// Scope every clear to a dedicated test workspace so the suite never touches
// real coord rows. This matters now that the operator writes live messages to
// harness_shared.coord_event_log (post-cutover) under the 'default' workspace —
// an unscoped DELETE would wipe them. D-007's workspace_id is exactly this lever.
const TEST_WS = 'test-coord-conformance';

describeCoordEventLogConformance(
  'PgCoordLog (live PG)',
  async () => {
    // A full clear of THIS test workspace per case gives every test an empty
    // surface to start from — matching the in-mem/fs factories.
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    return {
      log: new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS }),
      cleanup: async () => {
        await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
      },
    };
  },
  pgOk ? describe : describe.skip,
);

// D-007: two PgCoordLog instances bound to different workspace_ids share the
// table but never see each other's rows — the scoping that makes the
// multi-install case (Q-3) a non-event. Parity with coord_presence's
// workspace_id filter.
(pgOk ? describe : describe.skip)('PgCoordLog workspace_id isolation (D-007)', () => {
  it('a row written in one workspace is invisible to another', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id IN ('wsA', 'wsB')`;
    const wsA = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: 'wsA' });
    const wsB = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: 'wsB' });

    // LINE surface: A's message must not appear in B's union read.
    await wsA.appendLine('messages', 'agentA', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'm-a', kind: 'message', from: 'agentA', to: ['*'],
    });
    expect((await wsA.readLines('messages')).map((l) => l.msg_id)).toEqual(['m-a']);
    expect(await wsB.readLines('messages')).toEqual([]);

    // EVENT surface: the same msg_id in two workspaces are distinct rows
    // (the unique index includes workspace_id), each visible only in its own.
    await wsA.putEvent('escalations', 'shared-id', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'shared-id', kind: 'escalation', from: 'agentA', to: ['human'],
    });
    await wsB.putEvent('escalations', 'shared-id', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'shared-id', kind: 'escalation', from: 'agentB', to: ['human'],
    });
    expect((await wsA.getEvent('escalations', 'shared-id'))?.from).toBe('agentA');
    expect((await wsB.getEvent('escalations', 'shared-id'))?.from).toBe('agentB');

    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id IN ('wsA', 'wsB')`;
  });
});

// WI-3826 (fleet-reliability-verification-2026-07-10): the `ts` COLUMN must agree with the
// envelope's own `body->>'ts'` — a safe `WHERE ts >= $since` SQL pushdown (the optimization
// this bug was found while designing) is only possible when they can never diverge. Column
// used to default to now() at INSERT time, which could lag body.ts by however long
// sendMessage's audience/hive-scope resolution took between stamping `ts` and calling
// appendLine — silently dropping messages from any future since_ts pushdown (found: >1s
// drift on 2,317/53,560 live `messages` rows). appendLine now stamps `ts` FROM the envelope,
// so this asserts they agree by construction (the invariant the historical rows were
// one-time-repaired to by migration 546).
(pgOk ? describe : describe.skip)('coord_event_log.ts agrees with body->>\'ts\' (WI-3826)', () => {
  it('appendLine (LINE surface, e.g. messages) stamps the ts COLUMN from the envelope\'s own ts — never DB now()', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    // An envelope ts far from "now" proves the column is NOT defaulting to now() —
    // if it silently fell back to the DB default, this row's ts would land near the
    // test's wall-clock time, not two years in the past.
    const envelopeTs = '2024-03-01T00:00:00.000Z';
    await log.appendLine('messages', 'agent-ts-check', {
      ts: envelopeTs, msg_id: 'ts-invariant-1', kind: 'message', from: 'agent-ts-check', to: ['*'],
    });
    const rows = await sql!<{ ts: string; body: unknown }[]>`
      SELECT ts, body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${TEST_WS} AND msg_id = 'ts-invariant-1'
    `;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].ts).toISOString()).toBe(envelopeTs);
    const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
    expect(body.ts).toBe(envelopeTs);

    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });

  it('no row anywhere on the live coord_event_log.messages surface drifts >1s from its own body->>\'ts\' (the repaired invariant)', async () => {
    // A live-data assertion (not scoped to TEST_WS on purpose — the whole point is to
    // catch drift on REAL traffic, the same query the bug was found with). Soft-skips
    // when the table is empty (a fresh/CI PG with no live traffic yet).
    const [{ sampled, mismatch }] = await sql!<{ sampled: string; mismatch: string }[]>`
      SELECT count(*) AS sampled,
             count(*) FILTER (
               WHERE (body ->> 'ts') IS NOT NULL
                 AND abs(extract(epoch FROM (ts - (body ->> 'ts')::timestamptz))) > 1
             ) AS mismatch
      FROM harness_shared.coord_event_log
      WHERE surface = 'messages'
    `;
    if (Number(sampled) === 0) return; // nothing written yet on this PG — nothing to assert
    expect(Number(mismatch)).toBe(0);
  });
});

// EI-1576 regression: ensureCoordEventLogTable must be idempotent WITHOUT a
// destructive DROP/CREATE window. It runs against the LIVE org DB (here via
// connectionString, and in the operator's getOrgPg seam), so dropping an
// already-correct index — even momentarily — makes every concurrent putEvent
// upsert fail with `42P10: there is no unique or exclusion constraint matching
// the ON CONFLICT specification`. An index's OID is stable iff it was NOT
// dropped+recreated, so a second call that leaves the OID unchanged proves the
// window is gone.
(pgOk ? describe : describe.skip)('ensureCoordEventLogTable idempotency (EI-1576)', () => {
  it('does not drop+recreate an already-correct partial unique index', async () => {
    // First call guarantees the index exists in its correct, scoped shape.
    await ensureCoordEventLogTable(sql!);
    const oidOf = async (): Promise<string | undefined> =>
      (
        await sql!<{ oid: string }[]>`
          SELECT c.oid::text AS oid
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'harness_shared'
             AND c.relname = 'coord_event_log_event_uq'
        `
      )[0]?.oid;
    const before = await oidOf();
    expect(before).toBeTruthy(); // the partial unique index is present

    // A redundant call must be a no-op for the index — same OID, no churn,
    // no ACCESS-EXCLUSIVE window for concurrent upserts to fall into.
    await ensureCoordEventLogTable(sql!);
    expect(await oidOf()).toBe(before);

    // And the upsert the index backs still works end-to-end (would raise the
    // 42P10 above if the arbiter index were missing/mismatched).
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await log.putEvent('escalations', 'ei1576', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'ei1576', kind: 'escalation', from: 'a', to: ['human'],
    });
    await log.putEvent('escalations', 'ei1576', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'ei1576', kind: 'escalation', from: 'b', to: ['human'],
    });
    expect((await log.getEvent('escalations', 'ei1576'))?.from).toBe('b');
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });
});
