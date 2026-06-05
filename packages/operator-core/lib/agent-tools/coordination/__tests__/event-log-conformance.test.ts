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
  // eslint-disable-next-line no-console
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
