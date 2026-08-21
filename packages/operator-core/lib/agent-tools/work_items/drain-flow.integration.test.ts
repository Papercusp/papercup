import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { readDrainFlow, withDrainBugAdmission } = await import('./drain-flow');

const WORKSPACE = 'default';
const HARNESS = 'papercusp';
const OWNER = 'su-drain';
const START = '2026-08-13T08:00:00.000Z';
const START_MS = Date.parse(START);
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('drain-flow');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items RESTART IDENTITY`;
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

async function seed(input: {
  id: string;
  kind?: string;
  severity?: string | null;
  createdBy?: string | null;
  createdAt: number;
  closedAt?: number | null;
  terminalOwner?: string | null;
}): Promise<void> {
  const payload = {
    _ei: {
      ...(input.createdBy ? { created_by: input.createdBy } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
    },
  };
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       payload, created_ts, updated_ts, closed_ts, terminal_owner)
    VALUES
      (${WORKSPACE}, ${HARNESS}, ${input.id}, ${input.id}, '',
       ${input.closedAt ? 'done' : 'open'}, ${input.kind ?? 'bug'},
       ${db.sql.json(payload)}, ${input.createdAt}, ${input.closedAt ?? input.createdAt},
       ${input.closedAt ?? null}, ${input.terminalOwner ?? null})
  `;
}

describe('DRAIN flow exact-store oracle', () => {
  it('attributes opens and terminal transitions from their canonical writers, split by severity', async () => {
    await seed({ id: 'opened-critical', severity: 'critical', createdBy: OWNER, createdAt: START_MS + 1_000 });
    await seed({ id: 'opened-other', severity: 'major', createdBy: 'su-other', createdAt: START_MS + 2_000 });
    await seed({
      id: 'old-closed-by-owner',
      severity: 'major',
      createdBy: OWNER,
      createdAt: START_MS - 10_000,
      closedAt: START_MS + 3_000,
      terminalOwner: OWNER,
    });
    await seed({
      id: 'opened-minor-closed-other',
      severity: 'minor',
      createdBy: OWNER,
      createdAt: START_MS + 4_000,
      closedAt: START_MS + 5_000,
      terminalOwner: 'su-other',
    });
    await seed({ id: 'opened-default-minor', createdBy: OWNER, createdAt: START_MS + 6_000 });
    await seed({ id: 'non-bug', kind: 'change', severity: 'critical', createdBy: OWNER, createdAt: START_MS + 7_000 });

    const stored = await db.sql<Array<{ feature_id: string; created_by: string | null; severity: string | null }>>`
      SELECT feature_id,
             payload #>> '{_ei,created_by}' AS created_by,
             payload #>> '{_ei,severity}' AS severity
        FROM harness_shared.work_items
       ORDER BY feature_id
    `;
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature_id: 'opened-critical', created_by: OWNER, severity: 'critical' }),
      expect.objectContaining({ feature_id: 'opened-default-minor', created_by: OWNER, severity: null }),
    ]));

    const report = await readDrainFlow({
      workspaceId: WORKSPACE,
      harness: HARNESS,
      ownerId: OWNER,
      drainStartedAt: START,
      sql: db.sql,
    });

    expect(report.totals).toEqual({ opened: 3, terminaled: 1, net: 2 });
    expect(report.bySeverity).toEqual({
      critical: { opened: 1, terminaled: 0, net: 1 },
      major: { opened: 0, terminaled: 1, net: -1 },
      minor: { opened: 2, terminaled: 0, net: 2 },
      nit: { opened: 0, terminaled: 0, net: 0 },
    });
    expect(report.breaker.tripped).toBe(true);
  });

  it('counts beyond the 2,000-row listing ceiling', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         payload, created_ts, updated_ts)
      SELECT ${WORKSPACE}, ${HARNESS}, 'EI-many-' || n, 'many ' || n, '', 'open', 'bug',
             jsonb_build_object('_ei', jsonb_build_object('created_by', ${OWNER}::text, 'severity', 'nit')),
             ${START_MS}::bigint + n, ${START_MS}::bigint + n
        FROM generate_series(1, 2105) AS n
    `;

    const report = await readDrainFlow({
      workspaceId: WORKSPACE,
      harness: HARNESS,
      ownerId: OWNER,
      drainStartedAt: START,
      sql: db.sql,
    });
    expect(report.totals).toEqual({ opened: 2105, terminaled: 0, net: 2105 });
    expect(report.bySeverity.nit.opened).toBe(2105);
  });

  it('holds the advisory gate through persistence so the next filing sees the first', async () => {
    const args = {
      workspaceId: WORKSPACE,
      harness: HARNESS,
      ownerId: OWNER,
      drainStartedAt: START,
      sql: db.sql,
    };
    const persist = async () => {
      await seed({ id: 'first-admitted', severity: 'minor', createdBy: OWNER, createdAt: START_MS + 1_000 });
      return 'created';
    };
    const first = await withDrainBugAdmission(args, persist);
    expect(first).toMatchObject({ ok: true, allowed: true, value: 'created' });

    let secondPersisted = false;
    const second = await withDrainBugAdmission(args, async () => {
      secondPersisted = true;
      return 'should-not-run';
    });
    expect(second).toMatchObject({ ok: true, allowed: false, code: 'drain_flow_circuit_open' });
    expect(secondPersisted).toBe(false);
  });
});
