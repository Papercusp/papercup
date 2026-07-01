/**
 * session-presence-store integration (real PG) — mig 434 + the full-set-replace
 * writer + TTL reader (cross-machine-coord-parity-and-trust-2026-07-01 P-005).
 *
 * Pins the store semantics the gossip reader depends on:
 *   1. a device's frame REPLACES its whole session set (upsert + drop absentees);
 *   2. a STALE (out-of-order) frame never regresses or deletes newer rows;
 *   3. an EMPTY set clears the device's (older) rows — "all my agents ended";
 *   4. devices never interfere with each other's rows;
 *   5. listLiveSessionPresence TTL-filters and hive-scopes.
 *
 * Owns its schema (applies mig 434 verbatim); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  applySessionPresenceSet,
  listLiveSessionPresence,
} from '../session-presence-store';
import type { SessionPresenceEntry } from '../presence-gossip';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG_434 = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql/434-shared-session-presence.sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_sess';
const T0 = 1_700_000_000_000;

const entry = (ownerId: string, over?: Partial<SessionPresenceEntry>): SessionPresenceEntry => ({
  owner_id: ownerId,
  kind: 'su',
  intent: 'working',
  plan_slug: null,
  harness_slug: 'hive-home',
  last_active_ms: T0,
  ...over,
});

describe('shared_session_presence (real PG, mig 434)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('session_presence');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    await db.sql.unsafe(stripMeta(readFileSync(MIG_434, 'utf8')));
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function rowsFor(devicePubkey: string) {
    return db.sql<{ owner_id: string; intent: string | null; hive_slug: string | null }[]>`
      SELECT owner_id, intent, hive_slug FROM harness_shared.shared_session_presence
      WHERE workspace_id = ${WS} AND device_pubkey = ${devicePubkey} ORDER BY owner_id`;
  }

  it('a frame upserts the device\'s whole set (hive scope stamped)', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        hiveSlug: 'hive-home',
        sessions: [entry('su-a1'), entry('s-bee-1', { kind: 'bee', plan_slug: 'p1' })],
        frameTs: T0,
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    expect(rows.map((r) => r.owner_id)).toEqual(['s-bee-1', 'su-a1']);
    expect(rows[0].hive_slug).toBe('hive-home');
  });

  it('the next frame REPLACES the set: absentees dropped, arrivals upserted, survivors updated', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        hiveSlug: 'hive-home',
        sessions: [entry('su-a1', { intent: 'now reviewing' }), entry('su-a2')],
        frameTs: T0 + 10_000,
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    expect(rows.map((r) => r.owner_id)).toEqual(['su-a1', 'su-a2']); // s-bee-1 dropped
    expect(rows[0].intent).toBe('now reviewing');
  });

  it('a STALE out-of-order frame neither regresses nor deletes newer rows', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-A',
        githubUserId: 42,
        machineLabel: 'laptop',
        hiveSlug: 'hive-home',
        sessions: [entry('su-a1', { intent: 'ancient state' }), entry('su-ghost')],
        frameTs: T0 - 60_000, // older than everything applied above
      },
      db.sql,
    );
    const rows = await rowsFor('dev-A');
    // su-a2 (newer than the stale frame) survives the not-in-set delete;
    // su-a1 keeps the newer intent; su-ghost still INSERTS (it's new — no
    // newer row to protect) which is harmless: the next fresh frame drops it.
    const a1 = rows.find((r) => r.owner_id === 'su-a1');
    expect(a1?.intent).toBe('now reviewing');
    expect(rows.some((r) => r.owner_id === 'su-a2')).toBe(true);
  });

  it('devices never interfere: dev-B\'s replace leaves dev-A rows intact', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-B',
        githubUserId: 77,
        machineLabel: 'desktop',
        hiveSlug: 'hive-home',
        sessions: [entry('su-b1')],
        frameTs: T0 + 20_000,
      },
      db.sql,
    );
    expect((await rowsFor('dev-A')).length).toBeGreaterThan(0);
    expect((await rowsFor('dev-B')).map((r) => r.owner_id)).toEqual(['su-b1']);
  });

  it('an EMPTY set clears the device\'s older rows ("all my agents ended")', async () => {
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-B',
        githubUserId: 77,
        machineLabel: 'desktop',
        hiveSlug: 'hive-home',
        sessions: [],
        frameTs: T0 + 30_000,
      },
      db.sql,
    );
    expect(await rowsFor('dev-B')).toEqual([]);
  });

  it('listLiveSessionPresence TTL-filters and hive-scopes', async () => {
    // dev-C in a DIFFERENT hive, fresh beat; dev-A rows are old by now.
    const nowMs = T0 + 100_000;
    await applySessionPresenceSet(
      {
        workspaceId: WS,
        devicePubkey: 'dev-C',
        githubUserId: 9,
        machineLabel: 'vm',
        hiveSlug: 'other-hive',
        sessions: [entry('su-c1', { harness_slug: 'other-hive' })],
        frameTs: nowMs,
      },
      db.sql,
    );
    // TTL: only dev-C's beat is within 30s of `nowMs`.
    const live = await listLiveSessionPresence(
      { workspaceId: WS, staleMs: 30_000, nowMs },
      db.sql,
    );
    expect(live.map((r) => r.owner_id)).toEqual(['su-c1']);
    expect(live[0].last_seen_ms).toBe(nowMs);
    // Hive scope: hive-home has no LIVE rows at this point.
    const hiveScoped = await listLiveSessionPresence(
      { workspaceId: WS, hiveSlug: 'hive-home', staleMs: 30_000, nowMs },
      db.sql,
    );
    expect(hiveScoped).toEqual([]);
    // …but a wide-enough window sees the older hive-home rows, hive-scoped.
    const wide = await listLiveSessionPresence(
      { workspaceId: WS, hiveSlug: 'hive-home', staleMs: 24 * 60 * 60 * 1000, nowMs },
      db.sql,
    );
    expect(wide.every((r) => r.hive_slug === 'hive-home')).toBe(true);
    expect(wide.length).toBeGreaterThan(0);
  });
});
