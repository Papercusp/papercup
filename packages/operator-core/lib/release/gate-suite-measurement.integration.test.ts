import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
import { trackGateStall } from '../harness/routines/release-actions';
import { buildGateSuiteMeasurement, parseGateSuiteMeasurement } from './test-pass-reuse-report';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'suite-measurement-a', installSlug: 'suite-measurement' };
const other = { ...target, workspaceId: 'suite-measurement-b' };
const measurement = (runGroupId: string, completedAtMs: number) => buildGateSuiteMeasurement(
  'AFFECTED_TASK_CACHE_SUMMARY hits=2 misses=1 proofIdentity=current-run group=missing scope=missing reasons={"passing":2,"noProof":1}',
  'a'.repeat(40), { command: 'npm run test:affected', runGroupId, startedAtMs: 100, completedAtMs })!;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE install_slug = ${target.installSlug}`;
  for (const t of [target, other]) {
    await sql`INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
      VALUES (${t.workspaceId}, ${t.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
        'system:green-checkpoint', TRUE, ${t.workspaceId}, '{"sentinel":true,"gate_health":{"foreignKey":"keep"}}'::jsonb)`;
  }
});

async function health(workspaceId = target.workspaceId) {
  const rows = await sql<{ gh: unknown; sentinel: boolean }[]>`SELECT metadata->'gate_health' AS gh,
    (metadata->>'sentinel')::boolean AS sentinel FROM harness_shared.routines
    WHERE workspace_id = ${workspaceId} AND install_slug = ${target.installSlug}`;
  const raw = rows[0]!.gh;
  expect(rows[0]!.sentinel).toBe(true);
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

describe('P009 last actual suite persistence (real isolated Postgres)', () => {
  it('retains the newest measured run across replay-only ticks and late writes, scoped by workspace', async () => {
    const newer = measurement('suite-new', 500);
    // A promotion-held suite must persist too; it need not change the live verdict counters.
    await trackGateStall(target, 'perf-held', undefined, undefined, null, undefined, null, undefined, { suiteMeasurement: newer });
    expect(parseGateSuiteMeasurement((await health()).lastSuiteMeasurement)).toEqual(newer);
    await trackGateStall(target, 'skipped-locked');
    await trackGateStall(target, 'perf-held', undefined, undefined, null, undefined, null, undefined,
      { suiteMeasurement: measurement('suite-older-delivered-late', 200) });
    expect(parseGateSuiteMeasurement((await health()).lastSuiteMeasurement)).toEqual(newer);
    expect((await health()).foreignKey).toBe('keep');
    expect((await health(other.workspaceId)).lastSuiteMeasurement).toBeUndefined();
  });

  it('keeps a concurrent newer measurement when a status writer finishes later', async () => {
    const newer = measurement('suite-concurrent', 500);
    await Promise.all([
      trackGateStall(target, 'advanced', undefined, undefined, null, undefined, null, undefined,
        { suiteMeasurement: measurement('suite-old-status', 200) }),
      trackGateStall(target, 'perf-held', undefined, undefined, null, undefined, null, undefined, { suiteMeasurement: newer }),
    ]);
    expect(parseGateSuiteMeasurement((await health()).lastSuiteMeasurement)).toEqual(newer);
  });
});
