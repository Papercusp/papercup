/**
 * payload-spool — REAL-PG coverage for `PgGatewayPayloadStore.sweep` (EI-21858853737380027).
 *
 * MEASURED INCIDENT (WI-1091844, 2026-08-30): `payload-spool.test.ts` had exactly one
 * describe block covering sweep/GC behavior, and every case in it built
 * `memoryGatewayPayloadSpool()` — a double whose sweep reclaims unconditionally on
 * `refs === 0`. The production adapter's sweep instead treats `expires_at` as a
 * required condition (a TTL/legacy-grace backstop, not just a safety floor), and at
 * the time of the incident it ANDed `expires_at IS NOT NULL`, which was NULL on every
 * pre-policy row — so it reclaimed nothing for 38 hours while 66 GB / 74,250 rows
 * accumulated with the (double-only) suite green throughout. That specific gap was
 * fixed (the legacy-backfill + NULL-expiry grace-period branch below), but nothing
 * before this file ever ran a single assertion against a REAL Postgres for this
 * adapter — the existing `PgGatewayPayloadStore` unit tests use a `fakeSql()` that
 * only records SQL TEXT SHAPE, which can stay green even if the real query's
 * semantics are wrong (a typo'd interval unit, an operator precedence slip, a
 * misindexed WHERE clause — none of those fail a string-contains assertion).
 *
 * This file is the "shared contract, both implementations" guard the ticket asks
 * for, scoped to what genuinely IS shared between the double and the adapter — the
 * double sweeps a ref_count=0 row IMMEDIATELY with no time dimension; the adapter
 * deliberately delays that reclaim until an explicit or backfilled expiry has
 * passed (a resurrection window for a retry arriving between settle and sweep), so
 * the two are not literally interchangeable under the same clock-free assertions.
 * What follows: (1) the safety properties that genuinely must hold identically for
 * both (never sweep a referenced payload, never go refcount-negative) — proven
 * against the real adapter, and (2) the adapter's actual sweep/GC contract —
 * legacy-row backfill, TTL expiry, the ref_count floor, and bounded batching —
 * exercised against a real `harness_shared.gateway_payload_blobs` table so a
 * regression in the real SQL fails a real assertion instead of a string match.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@papercusp/artifact-registry';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../test/_pg-helpers';
import {
  DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS,
  DEFAULT_PAYLOAD_SPOOL_TTL_MS,
  PgGatewayPayloadStore,
  createGatewayPayloadSpool,
  memoryGatewayPayloadSpool,
  type GatewayPayloadSpool,
} from './payload-spool';

const WS = 'ws-payload-spool-it';
const body = (text: string) => Buffer.from(text, 'utf8');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pspool');
  await applyMigrationsForTest(db.sql, ['1022-gateway-payload-spool-blobs.sql'], {
    runtimeTables: ['harness_shared.gateway_payload_blobs'],
  });
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.gateway_payload_blobs`;
});

// ── (1) SHARED SAFETY CONTRACT — genuinely identical for both implementations. ──

function safetyContract(name: string, make: () => GatewayPayloadSpool) {
  describe(`refcounted retention — safety contract (${name})`, () => {
    it('does not sweep a payload a live receipt still names', async () => {
      const spool = make();
      const { payloadRef } = await spool.spool(body('pinned by a receipt'));

      await spool.retain(payloadRef!);
      const removed = await spool.sweep();

      expect(removed).toBe(0);
      expect(await spool.read(payloadRef!)).not.toBeNull();
    });

    it('keeps a shared (deduped) payload alive while any receipt still holds it', async () => {
      const spool = make();
      const bytes = body('shared between two receipts');
      const first = await spool.spool(bytes);
      const second = await spool.spool(Buffer.from(bytes));
      expect(second.payloadRef).toBe(first.payloadRef);

      await spool.retain(first.payloadRef!);
      await spool.retain(second.payloadRef!);
      await spool.release(first.payloadRef!);

      expect(await spool.sweep()).toBe(0);
      expect(await spool.read(first.payloadRef!)).not.toBeNull();
    });

    it('does not drive the refcount negative on a repeated release', async () => {
      const spool = make();
      const { payloadRef } = await spool.spool(body('double released'));

      await spool.retain(payloadRef!);
      await spool.release(payloadRef!);
      await spool.release(payloadRef!); // a retried settle path
      await spool.retain(payloadRef!); // a fresh receipt takes it

      // If the double release had gone to -1, this retain would leave it at 0 and a
      // sweep would collect a payload a live receipt is about to execute.
      expect(await spool.sweep()).toBe(0);
      expect(await spool.read(payloadRef!)).not.toBeNull();
    });
  });
}

safetyContract('memory double', () => memoryGatewayPayloadSpool());
safetyContract('Postgres adapter, real DB', () =>
  // A short but nonzero TTL: these assertions never depend on expiry elapsing (they
  // only ever check that a REFERENCED payload survives), so any positive TTL is fine.
  createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS }),
);

// ── (2) the Postgres adapter's actual sweep/GC contract, against a real table. ──

describe('PgGatewayPayloadStore.sweep — real Postgres', () => {
  const insertRow = async (opts: {
    refCount?: number;
    expiresAt?: Date | null;
    createdAt?: Date;
    lastAccessedAt?: Date;
    byteLength?: number;
  }) => {
    const key = await sha256Hex(Buffer.from(`row-${Math.random()}`));
    const createdAt = opts.createdAt ?? new Date();
    const bytes = Buffer.alloc(opts.byteLength ?? 1, 0x78);
    await db.sql`
      INSERT INTO harness_shared.gateway_payload_blobs
        (workspace_id, blob_key, bytes, byte_length, ref_count, expires_at, created_at, last_accessed_at)
      VALUES
        (${WS}, ${key}, ${bytes}, ${bytes.byteLength}, ${opts.refCount ?? 0},
         ${opts.expiresAt ?? null}, ${createdAt}, ${opts.lastAccessedAt ?? createdAt})`;
    return key;
  };

  // A pure read, deliberately NOT head(): head() is the dedupe path and renews the row's
  // expiry (WI-10003469), so probing through it between two sweeps would re-protect the
  // very rows the second sweep is meant to collect.
  const exists = async (key: string) =>
    (await db.sql`
      SELECT 1 FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS} AND blob_key = ${key}`).length > 0;

  it('THE INCIDENT: reclaims a pre-policy row (expires_at NULL) old enough to backfill into the past', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    // A "legacy" row: written before the finite-TTL policy existed, so it has no
    // explicit expiry. created_at far enough in the past that created_at + ttlMs
    // (the backfilled expiry) already lies in the past.
    const key = await insertRow({ refCount: 0, expiresAt: null, createdAt: new Date(Date.now() - 40 * 3600_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('does not reclaim a recent expires_at-NULL row until its backfilled expiry actually passes', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    // created_at + ttlMs (2 min) is still ~90s in the future.
    const key = await insertRow({ refCount: 0, expiresAt: null, createdAt: new Date(Date.now() - 30_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('legacy-grace path: reclaims an expires_at-NULL row once idle past legacyGraceMs, with the TTL policy off', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: 0, legacyGraceMs: DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: null,
      createdAt: new Date(Date.now() - 40 * 3600_000),
      lastAccessedAt: new Date(Date.now() - (DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS + 60_000)),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('legacy-grace path: does NOT reclaim an expires_at-NULL row still inside the grace window', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, ttlMs: 0, legacyGraceMs: DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: null,
      lastAccessedAt: new Date(Date.now() - 60_000), // well inside the (2h default) grace window
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('reclaims an unreferenced row once its explicit expiry has passed', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() - 1_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('WI-10003469: a dedupe HEAD hit renews an expired unreferenced row, so the sweep spares it for the caller’s retain()', async () => {
    // The race the two-minute TTL makes common: a retry dedupes onto a row that has already
    // expired, and the sweep would delete it before the retry's retain() lands.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() - 1_000) });

    await expect(store.head(key)).resolves.toEqual({ size: 1 });
    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('does NOT reclaim an unreferenced row before its explicit expiry', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 0, expiresAt: new Date(Date.now() + 3600_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  // ⚠ The floor is REFERENCED-AND-IN-USE, not referenced alone. Before WI-2141342 this
  // case's title read "never reclaims a still-referenced row even once its expiry has
  // passed", which is no longer true in general: a pin abandoned past pinnedGraceMs IS
  // reclaimed (the two cases below). This one still passes unchanged — and still means
  // something — because insertRow defaults last_accessed_at to now(), so its row is
  // expired but ACTIVE. That distinction is the whole safety property, so keep these
  // three cases adjacent: alone, any one of them reads as the complete contract.
  it('THE FLOOR: never reclaims a still-referenced row that is still in use, even once its expiry has passed', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({ refCount: 1, expiresAt: new Date(Date.now() - 1_000) });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('WI-2141342: reclaims a still-referenced row abandoned past the pinned grace', async () => {
    // The leak: release() runs in a request-scoped `finally`, so a SIGKILLed gateway
    // leaves ref_count > 0 forever. Without an age floor this row is immortal.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 1,
      expiresAt: new Date(Date.now() - 3 * 3600_000),
      lastAccessedAt: new Date(Date.now() - 3 * 3600_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('THE BOUNDARY: does NOT reclaim a still-referenced row inside the pinned grace, even when expired', async () => {
    // 1h idle against the 2h default. This is the case the production dry-run could not
    // prove — no live row happened to sit between the two windows — so it is the one that
    // would catch an interval-unit slip or an inverted comparison in the new branch.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 1,
      expiresAt: new Date(Date.now() - 1_000),
      lastAccessedAt: new Date(Date.now() - 3600_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('honours an explicit pinnedGraceMs rather than only the 2h default', async () => {
    // Guards the option wiring: a row 90m idle is INSIDE the default grace but past a
    // 1h override, so this fails if pinnedGraceMs is dropped anywhere between the
    // constructor and the SQL and the default silently applies instead.
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS, pinnedGraceMs: 3600_000 });
    const key = await insertRow({
      refCount: 2,
      expiresAt: new Date(Date.now() - 1_000),
      lastAccessedAt: new Date(Date.now() - 90 * 60_000),
    });

    const removed = await store.sweep(100);

    expect(removed).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('bounds a single pass to `limit`, leaving the remainder for the next sweep', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const expired = new Date(Date.now() - 1_000);
    const keys = await Promise.all([
      insertRow({ refCount: 0, expiresAt: expired }),
      insertRow({ refCount: 0, expiresAt: expired }),
      insertRow({ refCount: 0, expiresAt: expired }),
    ]);

    const firstPass = await store.sweep(2);
    expect(firstPass).toBe(2);
    const remainingAfterFirst = await Promise.all(keys.map(exists));
    expect(remainingAfterFirst.filter(Boolean)).toHaveLength(1);

    const secondPass = await store.sweep(2);
    expect(secondPass).toBe(1);
    const remainingAfterSecond = await Promise.all(keys.map(exists));
    expect(remainingAfterSecond.every((present) => !present)).toBe(true);
  });

  it('bounds a single pass by cumulative payload bytes as well as row count', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const expired = new Date(Date.now() - 1_000);
    const base = Date.now() - 10_000;
    const keys = await Promise.all([
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base), byteLength: 5 }),
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base + 1), byteLength: 4 }),
      insertRow({ refCount: 0, expiresAt: expired, lastAccessedAt: new Date(base + 2), byteLength: 3 }),
    ]);

    // 5 fits; 5 + 4 crosses the 8-byte budget, so the oldest row is the whole
    // first pass even though the row limit would allow all three.
    const firstPass = await store.sweep(100, 8);
    expect(firstPass).toBe(1);
    expect(await Promise.all(keys.map(exists))).toEqual([false, true, true]);

    // The remaining 4 + 3 bytes fit together on the next pass.
    const secondPass = await store.sweep(100, 8);
    expect(secondPass).toBe(2);
    expect((await Promise.all(keys.map(exists))).every((present) => !present)).toBe(true);
  });

  it('still makes progress when the oldest payload alone exceeds an explicit byte budget', async () => {
    const store = new PgGatewayPayloadStore({ sql: db.sql, workspaceId: WS });
    const key = await insertRow({
      refCount: 0,
      expiresAt: new Date(Date.now() - 1_000),
      byteLength: 5,
    });

    expect(await store.sweep(100, 2)).toBe(1);
    expect(await exists(key)).toBe(false);
  });
});

// ── round trip against the real adapter — the basic path had zero real-PG coverage. ──

describe('createGatewayPayloadSpool — real Postgres round trip', () => {
  it('writes, reads back exact bytes, and dedupes a retried body onto one row', async () => {
    const spool = createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS, ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS });
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xfe]);

    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes));
    const readBack = await spool.read(first.payloadRef!);

    expect(second.payloadRef).toBe(first.payloadRef);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack!, bytes)).toBe(0);

    const rows = await db.sql`SELECT count(*)::int AS n FROM harness_shared.gateway_payload_blobs WHERE workspace_id = ${WS}`;
    expect(rows[0]!.n).toBe(1);
  });

  it('returns null for a ref that does not resolve', async () => {
    const spool = createGatewayPayloadSpool({ sql: db.sql, workspaceId: WS });

    expect(await spool.read('a'.repeat(64))).toBeNull();
  });
});
