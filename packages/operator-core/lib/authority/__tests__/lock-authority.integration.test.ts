/**
 * Integration test for the lock authority's REAL `shared_presence` query path
 * (Track B). Proves the canonical SQL in `queryPresenceRows` selects the right
 * live peers from a real Postgres `harness_shared.shared_presence` table, and
 * that `lockAuthorityFor` driven off that real query resolves the authority +
 * fails over correctly across the staleness window.
 *
 * Owns its schema (a column-faithful `shared_presence`); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { lockAuthorityFor, queryPresenceRows } from '../lock-authority';

const HARNESS = 'fed';
const OTHER = 'other';

describe('lock authority — real shared_presence query (integration)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('lock_authority');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.shared_presence (
        workspace_id   text   NOT NULL DEFAULT '',
        harness_slug   text   NOT NULL,
        github_user_id bigint NOT NULL,
        machine_label  text   NOT NULL,
        device_pubkey  text   NOT NULL,
        intent         text,
        current_view   text,
        last_seen_at   timestamptz NOT NULL DEFAULT now(),
        schema_version bigint NOT NULL DEFAULT 1,
        PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
      )
    `);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  async function seed(rows: Array<{ ws?: string; gh: number; ml: string; pubkey: string; secondsAgo: number; harness?: string }>) {
    await db.sql`DELETE FROM harness_shared.shared_presence`;
    for (const r of rows) {
      await db.sql`
        INSERT INTO harness_shared.shared_presence
          (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey, last_seen_at)
        VALUES
          (${r.ws ?? 'default'}, ${r.harness ?? HARNESS}, ${r.gh}, ${r.ml}, ${r.pubkey},
           now() - make_interval(secs => ${r.secondsAgo}))
      `;
    }
  }

  it('queryPresenceRows returns only this harness, with epoch-ms last_seen', async () => {
    await seed([
      { gh: 1, ml: 'm1', pubkey: 'aaa', secondsAgo: 2 },
      { gh: 2, ml: 'm2', pubkey: 'mmm', secondsAgo: 2 },
      { gh: 3, ml: 'm3', pubkey: 'zzz', secondsAgo: 2, harness: OTHER },
    ]);
    const rows = await queryPresenceRows(db.sql as never, HARNESS);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.device_pubkey).sort()).toEqual(['aaa', 'mmm']);
    expect(typeof rows[0].last_seen_ms).toBe('number');
    expect(rows[0].last_seen_ms).toBeGreaterThan(0);
  });

  it('selects argmin(device_pubkey) over live peers — self is min → isSelf', async () => {
    await seed([
      { gh: 1, ml: 'm1', pubkey: 'aaa', secondsAgo: 2 },
      { gh: 2, ml: 'm2', pubkey: 'mmm', secondsAgo: 2 },
    ]);
    const r = await lockAuthorityFor(HARNESS, {
      fetchPresenceRows: (h) => queryPresenceRows(db.sql as never, h),
      resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
    });
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(2);
  });

  it('self not min → remote authority is the live argmin peer', async () => {
    await seed([
      { gh: 1, ml: 'm1', pubkey: 'aaa', secondsAgo: 2 },
      { gh: 2, ml: 'm2', pubkey: 'mmm', secondsAgo: 2 },
    ]);
    const r = await lockAuthorityFor(HARNESS, {
      fetchPresenceRows: (h) => queryPresenceRows(db.sql as never, h),
      resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'mmm' }),
    });
    expect(r.isSelf).toBe(false);
    expect(r.peer?.devicePubkey).toBe('aaa');
    expect(r.peer?.machineLabel).toBe('m1');
  });

  it('failover: the authority peer aging past the staleness window promotes self', async () => {
    // 'aaa' last seen 120s ago (stale under a 90s window); self 'mmm' fresh.
    await seed([
      { gh: 1, ml: 'm1', pubkey: 'aaa', secondsAgo: 120 },
      { gh: 2, ml: 'm2', pubkey: 'mmm', secondsAgo: 2 },
    ]);
    const r = await lockAuthorityFor(HARNESS, {
      fetchPresenceRows: (h) => queryPresenceRows(db.sql as never, h),
      resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'mmm' }),
      staleMs: 90_000,
    });
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(1);
  });

  it('empty presence (single box) → isSelf with liveCount 0', async () => {
    await seed([]);
    const r = await lockAuthorityFor(HARNESS, {
      fetchPresenceRows: (h) => queryPresenceRows(db.sql as never, h),
      resolveSelf: async () => null,
    });
    expect(r).toEqual({ isSelf: true, liveCount: 0 });
  });
});
