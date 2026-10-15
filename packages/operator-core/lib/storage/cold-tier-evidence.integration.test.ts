import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { measureColdMounts, type ColdMountObservation } from './cold-tier-evidence';
import { measureDurableHeadroomTargets } from './retention-interval-evidence';

describe('cold tier native evidence ledgers', () => {
  let db: FreshPgDb;
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10) + h * 3_600_000).toISOString();
  const window = { workspaceId: 'workspace', harnessSlug: 'harness', host: 'fixture-host', windowStart: at(0), windowEnd: at(72) };
  beforeAll(async () => {
    db = await createFreshPgDb('cold-evidence');
    await db.sql.unsafe(`CREATE TABLE harness_shared.audit_log
      (id text PRIMARY KEY, ts bigint, actor text, action text, subject text, details jsonb, workspace_id text);
      CREATE TABLE harness_shared.disk_census_runs
      (run_id text, host text, device text, finished_at timestamptz, avail_bytes bigint, complete boolean);
      CREATE TABLE harness_shared.harness_plans
      (workspace_id text, harness_slug text, plan_slug text, status text, superseded_by text);
      CREATE TABLE harness_shared.work_items
      (workspace_id text, harness_slug text, feature_id text, status text)`);
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql.unsafe('TRUNCATE harness_shared.audit_log,harness_shared.disk_census_runs,harness_shared.harness_plans,harness_shared.work_items');
  });
  it('persists one boot witness and requires a different real native boot identity', async () => {
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const current: ColdMountObservation = { host: window.host, bootId: a, at: at(0), mounts: [
      { path: '/mnt/cold-a', source: '/dev/sda2', uuidSource: '/dev/sda2', uuid: a, type: 'xfs', nofail: true },
      { path: '/mnt/cold-b', source: '/dev/sdb3', uuidSource: '/dev/sdb3', uuid: b, type: 'xfs', nofail: true },
    ] };
    expect((await measureColdMounts(db.sql, window.workspaceId, async () => current)).verdict).toBe('unknown');
    expect((await measureColdMounts(db.sql, window.workspaceId, async () => ({ ...current, at: at(1) }))).verdict).toBe('unknown');
    expect((await db.sql`SELECT id FROM harness_shared.audit_log`).length).toBe(1);
    expect((await measureColdMounts(db.sql, window.workspaceId, async () => ({ ...current, bootId: b, at: at(2) }))).verdict).toBe('pass');
    expect((await measureColdMounts(db.sql, 'foreign-workspace', async () => ({ ...current, bootId: b, at: at(2) }))).verdict).toBe('unknown');
  });

  async function seedTargets() {
    await db.sql`INSERT INTO harness_shared.harness_plans VALUES
      ('workspace','harness','disk-headroom-standing-reclaim-2026-10-12','superseded','disk-durable-headroom-2026-10-15')`;
    await db.sql`INSERT INTO harness_shared.work_items VALUES ('workspace','harness','WI-10007751','done')`;
    await db.sql`INSERT INTO harness_shared.disk_census_runs
      SELECT device||hour, 'fixture-host',device, ${at(0)}::timestamptz+(hour+0.5)*interval '1 hour',
        CASE WHEN device='/' THEN 400000000000::bigint ELSE 2000000000000::bigint END,true
      FROM generate_series(0,71) hour CROSS JOIN (VALUES ('/'),('/mnt/data')) d(device)`;
    for (let h = 0; h < 72; h++) {
      const receipt = { id: `run-${h}`, host: window.host, schemaVersion: 1, startedAt: at(h + 0.2), finishedAt: at(h + 0.3),
        dryRun: false, complete: true, policyExhausted: true, errors: [], entries: [], delegates: [] };
      for (const phase of ['started', 'receipt']) {
        const details = phase === 'started' ? { ...receipt, finishedAt: '', complete: false } : receipt;
        await db.sql`INSERT INTO harness_shared.audit_log VALUES (${`${h}-${phase}`}, ${Date.parse(phase === 'started' ? receipt.startedAt : receipt.finishedAt)},
          'system:disk-retention',${`disk-retention:${phase}`},${receipt.id},${db.sql.json(details)},'workspace')`;
      }
    }
  }
  it('joins all native starts/receipts and exact target samples in real PostgreSQL', async () => {
    await seedTargets();
    expect((await measureDurableHeadroomTargets(db.sql, window)).verdict).toBe('pass');
    await db.sql`DELETE FROM harness_shared.audit_log WHERE id='30-receipt'`;
    expect((await measureDurableHeadroomTargets(db.sql, window)).verdict).toBe('unknown');
    expect((await measureDurableHeadroomTargets(db.sql, { ...window, host: 'other-host' })).verdict).toBe('unknown');
  });
  it('does not hide a middle dip or hostless legacy attempt behind good endpoints', async () => {
    await seedTargets();
    await db.sql`UPDATE harness_shared.audit_log SET details=details-'host' WHERE id='30-started'`;
    expect((await measureDurableHeadroomTargets(db.sql, window)).verdict).toBe('unknown');
    await db.sql`UPDATE harness_shared.audit_log SET details=details||'{"host":"fixture-host"}'::jsonb WHERE id='30-started'`;
    await db.sql`UPDATE harness_shared.disk_census_runs SET avail_bytes=399999999999 WHERE run_id='/30'`;
    expect((await measureDurableHeadroomTargets(db.sql, window)).verdict).toBe('fail');
  });
});
