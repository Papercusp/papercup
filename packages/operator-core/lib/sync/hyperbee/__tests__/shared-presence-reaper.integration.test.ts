/**
 * shared-presence-reaper integration (real PG) — the FEDERATED presence retention
 * floor (cross-machine-coord-parity-and-trust-2026-07-01 P-057 / M8, audit D-013).
 *
 * Proves, against real Postgres:
 *   1. TTL pass — a row whose last_seen_at is older than ttlMs is deleted; a fresh
 *      row is kept — on BOTH shared_presence and shared_session_presence.
 *   2. Per-device cap — for a device with > maxRowsPerDevice rows (the
 *      machine_label / owner_id rotation growth amplifier), only the N most-recent
 *      survive; a different device is untouched.
 *
 * Owns its schema: shared_presence faithful to the baseline (4-col PK, mig-187
 * hive_slug, fed_ts/fed_hlc), shared_session_presence via mig 434 verbatim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { reapStaleSharedPresence } from '../shared-presence-reaper';

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

const WS = 'ws_reap';
const NOW = 1_800_000_000_000; // fixed clock for deterministic TTL math
const HOUR = 60 * 60 * 1000;

describe('shared-presence-reaper (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('shared_presence_reaper');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    // shared_presence — faithful to the baseline (4-col PK + mig-187 hive_slug + fed cols).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.shared_presence (
        workspace_id text DEFAULT '' NOT NULL,
        harness_slug text NOT NULL,
        github_user_id bigint NOT NULL,
        machine_label text NOT NULL,
        device_pubkey text NOT NULL,
        intent text, current_view text,
        last_seen_at timestamptz DEFAULT now() NOT NULL,
        schema_version bigint DEFAULT 1 NOT NULL,
        hive_slug text, fed_ts bigint, fed_hlc text,
        CONSTRAINT shared_presence_pkey PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
      )`);
    // shared_session_presence — mig 434 verbatim.
    await db.sql.unsafe(stripMeta(readFileSync(MIG_434, 'utf8')));
  }, 90_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.shared_presence`;
    await db.sql`TRUNCATE harness_shared.shared_session_presence`;
  });

  // last_seen_at at NOW - `ageMs`.
  const at = (ageMs: number) => new Date(NOW - ageMs);

  async function insP(opts: { device: string; user: number; machine: string; ageMs: number; harness?: string }) {
    await db.sql`
      INSERT INTO harness_shared.shared_presence
        (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey, last_seen_at)
      VALUES (${WS}, ${opts.harness ?? 'web'}, ${opts.user}, ${opts.machine}, ${opts.device}, ${at(opts.ageMs)})`;
  }
  async function insS(opts: { device: string; owner: string; machine: string; ageMs: number }) {
    await db.sql`
      INSERT INTO harness_shared.shared_session_presence
        (workspace_id, harness_slug, owner_id, github_user_id, machine_label, device_pubkey, last_seen_at)
      VALUES (${WS}, 'hive-home', ${opts.owner}, 7, ${opts.machine}, ${opts.device}, ${at(opts.ageMs)})`;
  }
  const pMachines = async () =>
    (await db.sql<{ machine_label: string }[]>`SELECT machine_label FROM harness_shared.shared_presence ORDER BY machine_label`).map((r) => r.machine_label);
  const sOwners = async () =>
    (await db.sql<{ owner_id: string }[]>`SELECT owner_id FROM harness_shared.shared_session_presence ORDER BY owner_id`).map((r) => r.owner_id);

  it('TTL pass: rows older than ttlMs are deleted; fresh rows survive (both tables)', async () => {
    // A big cap so ONLY the TTL pass acts here.
    await insP({ device: 'D1', user: 1, machine: 'fresh', ageMs: 1 * HOUR });
    await insP({ device: 'D1', user: 1, machine: 'stale', ageMs: 5 * HOUR });
    await insS({ device: 'D1', owner: 'su-fresh', machine: 'fresh', ageMs: 1 * HOUR });
    await insS({ device: 'D1', owner: 'su-stale', machine: 'stale', ageMs: 5 * HOUR });

    const r = await reapStaleSharedPresence({ ttlMs: 4 * HOUR, maxRowsPerDevice: 1000, nowMs: NOW, sql: db.sql });

    expect(r.presenceTtlReaped).toBe(1);
    expect(r.sessionTtlReaped).toBe(1);
    expect(await pMachines()).toEqual(['fresh']); // stale removed
    expect(await sOwners()).toEqual(['su-fresh']);
  });

  it('per-device cap: keeps the N most-recent rows per (workspace, device); other devices untouched', async () => {
    // Device D1 rotates machine_label — 5 FRESH rows (TTL can never catch them).
    for (let i = 1; i <= 5; i++) await insP({ device: 'D1', user: 1, machine: `m${i}`, ageMs: (6 - i) * 60_000 }); // m5 newest
    // A different device D2 has 2 rows — under the cap, must be left alone.
    await insP({ device: 'D2', user: 2, machine: 'a', ageMs: 60_000 });
    await insP({ device: 'D2', user: 2, machine: 'b', ageMs: 30_000 });
    // Same rotation on the session table.
    for (let i = 1; i <= 5; i++) await insS({ device: 'D1', owner: `su-${i}`, machine: `m${i}`, ageMs: (6 - i) * 60_000 });

    const r = await reapStaleSharedPresence({ ttlMs: 24 * HOUR, maxRowsPerDevice: 3, nowMs: NOW, sql: db.sql });

    expect(r.presenceCapReaped).toBe(2); // D1: 5 → 3 (m1,m2 dropped); D2 (2) untouched
    expect(r.sessionCapReaped).toBe(2); // D1 sessions: 5 → 3
    // D1 keeps its 3 most-recent labels; D2's two survive.
    expect(await pMachines()).toEqual(['a', 'b', 'm3', 'm4', 'm5']);
    expect(await sOwners()).toEqual(['su-3', 'su-4', 'su-5']);
  });

  it('no-op on empty / all-fresh-under-cap tables (returns all zeroes)', async () => {
    await insP({ device: 'D1', user: 1, machine: 'only', ageMs: 60_000 });
    const r = await reapStaleSharedPresence({ ttlMs: 4 * HOUR, maxRowsPerDevice: 128, nowMs: NOW, sql: db.sql });
    expect(r).toEqual({ presenceTtlReaped: 0, sessionTtlReaped: 0, presenceCapReaped: 0, sessionCapReaped: 0 });
    expect(await pMachines()).toEqual(['only']);
  });
});
