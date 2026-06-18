/**
 * control-plane.integration.test.ts — the gym autoloop control plane
 * (getAutoloop/setAutoloop over gym_autoloop_config, mig 110), against a real
 * Postgres. Both take sql directly (injectable).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - setAutoloop is a read-merge-write upsert: a PARTIAL set PRESERVES unset
 *    fields (enabled/spentUsd/status/lastCycle…);
 *  - budgetUsd distinguishes null from undefined — `null` CLEARS the cap,
 *    `undefined` PRESERVES the existing cap (the `q.budgetUsd !== undefined`
 *    test, not `??`);
 *  - full round-trip via getAutoloop; null for an unknown harness.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { getAutoloop, setAutoloop } = await import('./control-plane');

const WS = 'ws-cp';
const HS = 'web';
let rootSql: postgres.Sql;
const read = () => getAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS });

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_autoloop_config (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      budget_usd double precision,
      spent_usd double precision NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'idle',
      last_cycle integer, last_cycle_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.gym_autoloop_config`;
});

describe('setAutoloop / getAutoloop (PG)', () => {
  it('full upsert round-trips every field', async () => {
    const cfg = await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(cfg).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
  });

  it('a PARTIAL set preserves unset fields (read-merge-write)', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 7 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, status: 'running' }); // only status
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 7, status: 'running' }); // rest preserved
  });

  it('budgetUsd: undefined PRESERVES the cap, null CLEARS it', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: 100 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, spentUsd: 5 }); // budgetUsd undefined → preserve
    expect((await read())!.budgetUsd).toBe(100);
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: null }); // explicit null → clear the cap
    expect((await read())!.budgetUsd).toBeNull();
  });

  it('getAutoloop returns null for an unknown harness', async () => {
    expect(await getAutoloop(rootSql, { workspaceId: WS, harnessSlug: 'nope' })).toBeNull();
  });
});
