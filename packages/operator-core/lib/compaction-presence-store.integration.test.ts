/**
 * compaction-presence-store.integration.test.ts — the agent-managed-compaction
 * data-layer round-trips against a REAL Postgres (agent-managed-compaction-2026-07-01
 * P-006 / P-009). PgPresenceStore.setCompactionLimit / setContextEstimate persist to
 * coord_presence and read back via get(); a later write preserves the limit; setters
 * no-op on an unknown owner. Mirrors the coord-capability-pg-stores rig.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *   packages/operator-core/lib/compaction-presence-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';
import { PgPresenceStore, ensureCoordPresenceTable } from '@papercusp/coordination/presence';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `compaction_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });
  await ensureCoordPresenceTable(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const store = () => new PgPresenceStore({ getSql: () => sql, ensureSchema: async () => {} });
const identity = (ownerId: string) => ({
  ownerId,
  ownerLabel: 'test',
  source: 'test',
  workspaceId: 'default',
});
const owner = () => `own_${randomBytes(4).toString('hex')}`;

describe('PgPresenceStore compaction columns (agent-managed-compaction)', () => {
  it('setCompactionLimit persists and a later write preserves it', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { intent: 'work' });
    await s.setCompactionLimit(o, 160_000);
    expect((await s.get(o))?.compactionLimit).toBe(160_000);
    // ON CONFLICT DO UPDATE must NOT wipe the limit on a later declare/heartbeat.
    await s.write(identity(o), { intent: 'more' });
    expect((await s.get(o))?.compactionLimit).toBe(160_000);
  });

  it('setContextEstimate persists tokens + a timestamp', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    await s.setContextEstimate(o, 144_000);
    const rec = await s.get(o);
    expect(rec?.contextTokens).toBe(144_000);
    expect(rec?.contextEstimatedAt).toBeTruthy();
  });

  it('setters no-op for an unknown owner (no row created)', async () => {
    const s = store();
    const o = `ghost_${randomBytes(4).toString('hex')}`;
    await s.setCompactionLimit(o, 100_000);
    await s.setContextEstimate(o, 50_000);
    expect(await s.get(o)).toBeNull();
  });

  it('fresh presence has null compaction columns by default', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    const rec = await s.get(o);
    expect(rec?.compactionLimit ?? null).toBeNull();
    expect(rec?.contextTokens ?? null).toBeNull();
  });
});
