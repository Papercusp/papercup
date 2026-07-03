/**
 * metering-store.integration.test.ts — the P-205 durable metering ledger
 * (`harness_shared.p2p_metering_spend` / `p2p_metering_contribution`, mig 483)
 * against REAL Postgres (p2p-work-distribution-2026-07-02, WI-1938).
 *
 * The pure decision core is fully covered by metering-ledger.test.ts; THIS file
 * covers what only a real DB can: the transactional read-decide-write round
 * trip, PK upserts, the H14 unit fence held against the PERSISTED unit, the M22
 * cap held against the PERSISTED total (across "restarts" — i.e. separate store
 * calls), workspace isolation, and the load-replay fidelity of
 * loadMeteringLedger. Mirrors resource-allotments.integration.test.ts
 * (createOrgTestDb fixture; every store fn takes `sqlOverride`; unique
 * workspace id per test so the PKs isolate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { contributionOf, spentOn } from './metering-ledger';
import {
  loadMeteringLedger,
  recordContributionDurable,
  recordSpendDurable,
  resolveMeteringWorkspace,
} from './metering-store';

const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('p2p metering store (real PG, mig 483)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('spend: accumulates across separate durable calls onto one (host,fleet,axis) row', async () => {
    const workspaceId = 'ws-meter-spend';
    const base = { workspaceId, hostRef: 'tower', fleetSlug: 'ml-fleet', axis: 'remote' as const, unit: 'usd-micros' as const };
    const a = await recordSpendDurable({ ...base, amount: 1500 }, db.adminSql);
    expect(a.ok).toBe(true);
    const b = await recordSpendDurable({ ...base, amount: 500 }, db.adminSql);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.total).toBe(2000);
    const rows = await db.adminSql`
      SELECT amount, unit FROM harness_shared.p2p_metering_spend
       WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1); // PK upsert, never a second row
    expect(Number(rows[0].amount)).toBe(2000);
    expect(rows[0].unit).toBe('usd-micros');
  });

  it('spend: H14 unit fence holds against the PERSISTED unit (refusal writes nothing)', async () => {
    const workspaceId = 'ws-meter-unitfence';
    const base = { workspaceId, hostRef: 'tower', fleetSlug: 'ml-fleet', axis: 'local' as const };
    const a = await recordSpendDurable({ ...base, amount: 60, unit: 'slot-seconds' }, db.adminSql);
    expect(a.ok).toBe(true);
    const bad = await recordSpendDurable({ ...base, amount: 5, unit: 'slots' }, db.adminSql);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('meter_unit_mismatch');
    const rows = await db.adminSql`
      SELECT amount, unit FROM harness_shared.p2p_metering_spend
       WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(60); // unchanged — refusal wrote nothing
    expect(rows[0].unit).toBe('slot-seconds');
  });

  it('contribution: M22 cap holds against the PERSISTED total across separate calls', async () => {
    const workspaceId = 'ws-meter-m22';
    const base = { workspaceId, attestedUserId: '279242982', axis: 'local' as const, unit: 'tokens' as const, perUserCap: 100 };
    const a = await recordContributionDurable({ ...base, amount: 80 }, db.adminSql);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.credited).toBe(80);
    expect(a.capped).toBe(false);
    // "Restart": a separate durable call must see the persisted 80 and clamp.
    const b = await recordContributionDurable({ ...base, amount: 50 }, db.adminSql);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.credited).toBe(20); // only headroom to the cap
    expect(b.capped).toBe(true);
    expect(b.total).toBe(100);
    const rows = await db.adminSql`
      SELECT amount FROM harness_shared.p2p_metering_contribution
       WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(100); // stored total is post-cap
  });

  it('loadMeteringLedger replays persisted rows into a pure-core-identical ledger', async () => {
    const workspaceId = 'ws-meter-load';
    await recordSpendDurable(
      { workspaceId, hostRef: 'tower', fleetSlug: 'ml-fleet', axis: 'remote', amount: 42, unit: 'usd-micros' },
      db.adminSql,
    );
    await recordContributionDurable(
      { workspaceId, attestedUserId: '1567022', axis: 'local', amount: 7, unit: 'slots', perUserCap: null },
      db.adminSql,
    );
    const ledger = await loadMeteringLedger(workspaceId, db.adminSql);
    expect(spentOn(ledger, 'tower', 'ml-fleet', 'remote')).toBe(42);
    expect(contributionOf(ledger, '1567022', 'local')).toBe(7);
    // Absent counters read 0 through the same pure accessors.
    expect(spentOn(ledger, 'tower', 'other-fleet', 'remote')).toBe(0);
  });

  it('workspace isolation: rows never leak across partitions; unresolvable ws refuses/empties', async () => {
    const wsA = 'ws-meter-iso-a';
    const wsB = 'ws-meter-iso-b';
    await recordSpendDurable(
      { workspaceId: wsA, hostRef: 'tower', fleetSlug: 'f', axis: 'remote', amount: 5, unit: 'tokens' },
      db.adminSql,
    );
    const ledgerB = await loadMeteringLedger(wsB, db.adminSql);
    expect(spentOn(ledgerB, 'tower', 'f', 'remote')).toBe(0);
    // WI-1564: 'default' / '*' / empty are unresolvable partitions.
    expect(resolveMeteringWorkspace('default')).toBeUndefined();
    expect(resolveMeteringWorkspace('*')).toBeUndefined();
    expect(resolveMeteringWorkspace('  ')).toBeUndefined();
    const refused = await recordSpendDurable(
      { workspaceId: 'default', hostRef: 'tower', fleetSlug: 'f', axis: 'remote', amount: 5, unit: 'tokens' },
      db.adminSql,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) return;
    expect(refused.code).toBe('workspace_unresolved');
    const empty = await loadMeteringLedger('default', db.adminSql);
    expect(Object.keys(empty.spend)).toHaveLength(0);
  });

  it('invalid amounts are refused by the pure core before any SQL write', async () => {
    const workspaceId = 'ws-meter-invalid';
    for (const amount of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await recordSpendDurable(
        { workspaceId, hostRef: 'tower', fleetSlug: 'f', axis: 'remote', amount, unit: 'tokens' },
        db.adminSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid_amount');
    }
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.p2p_metering_spend
       WHERE workspace_id = ${workspaceId}`;
    expect(rows[0].n).toBe(0);
  });
});
