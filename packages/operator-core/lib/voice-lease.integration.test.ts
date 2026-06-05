/**
 * voice-lease.integration.test.ts — cross-surface single-listener arbitration
 * against real testcontainer PG (the unit test mocks the DB; this drives the
 * real drizzle insert/upsert/delete + the on-demand ensureLeaseTable DDL).
 *
 * Proves the arbitration the desktop+phone rely on to avoid stereo responses:
 * grant-on-empty, same-owner refresh, refuse a different active owner,
 * force-preempt (phone taps), expired-takeover, expiry filtering in
 * readVoiceLease, release, and that the voiceLease.current sync-invalidate
 * fires exactly on owner change (so other listeners demote).
 *
 * P-009 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: null as unknown as import('postgres').Sql,
  db: null as unknown,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
const notifySyncInvalidate = vi.fn();
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...a) }));

import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from './voice-lease';

const WS = 'ws-lease';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('voicelease');
  // ensureLeaseTable's DDL GRANTs to harness_app; create the role so its
  // CREATE-TABLE batch commits. The role is CLUSTER-wide and persists on the
  // reused testcontainer, so creating it must be idempotent. Pre-create the
  // table so ensureLeaseTable's CREATE-IF-NOT-EXISTS is a no-op.
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE harness_shared.voice_lease (
      workspace_id   TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('desktop','mobile')),
      expires_at_ms  BIGINT NOT NULL
    );
  `);
  h.sql = db.sql;
  h.db = drizzle(db.sql);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  notifySyncInvalidate.mockClear();
  await db.sql`DELETE FROM harness_shared.voice_lease`;
});

async function expireLease() {
  await db.sql`UPDATE harness_shared.voice_lease SET expires_at_ms = ${Date.now() - 5000} WHERE workspace_id = ${WS}`;
}

describe('claimVoiceLease — arbitration', () => {
  it('grants on an empty lease and emits the owner-change invalidate', async () => {
    const out = await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    expect(out.granted).toBe(true);
    expect(await readVoiceLease(WS)).toMatchObject({ ownerId: 'tabA', ownerKind: 'desktop' });
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: WS });
  });

  it('refreshes the same owner without emitting an invalidate', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    notifySyncInvalidate.mockClear();
    const out = await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    expect(out.granted).toBe(true);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('refuses a different owner while the lease is active (no stereo)', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    notifySyncInvalidate.mockClear();
    const out = await claimVoiceLease({ workspaceId: WS, ownerId: 'phone1', ownerKind: 'mobile' });
    expect(out.granted).toBe(false);
    expect(out.lease.ownerId).toBe('tabA');
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('force-preempts an active different owner (phone tap) + invalidates', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    notifySyncInvalidate.mockClear();
    const out = await claimVoiceLease({ workspaceId: WS, ownerId: 'phone1', ownerKind: 'mobile', force: true });
    expect(out.granted).toBe(true);
    expect((await readVoiceLease(WS))?.ownerKind).toBe('mobile');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: WS });
  });

  it('takes over an expired lease (new owner) + invalidates', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    await expireLease();
    notifySyncInvalidate.mockClear();
    const out = await claimVoiceLease({ workspaceId: WS, ownerId: 'phone1', ownerKind: 'mobile' });
    expect(out.granted).toBe(true);
    expect((await readVoiceLease(WS))?.ownerId).toBe('phone1');
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: WS });
  });
});

describe('readVoiceLease', () => {
  it('returns null once the lease has expired', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    expect(await readVoiceLease(WS)).not.toBeNull();
    await expireLease();
    expect(await readVoiceLease(WS)).toBeNull(); // WHERE expires_at_ms >= now filters it
  });
});

describe('releaseVoiceLease', () => {
  it('clears the lease and emits the invalidate', async () => {
    await claimVoiceLease({ workspaceId: WS, ownerId: 'tabA', ownerKind: 'desktop' });
    notifySyncInvalidate.mockClear();
    await releaseVoiceLease({ workspaceId: WS, ownerId: 'tabA' });
    expect(await readVoiceLease(WS)).toBeNull();
    expect(notifySyncInvalidate).toHaveBeenCalledWith('voiceLease.current', { workspaceId: WS });
  });
});
