/**
 * presence.integration.test.ts — the presence GC mutator against REAL Postgres
 * (the shared baseline-schema DB via inject('baselineSchemaDsn')).
 *
 * BRIEF-test-coverage-fu-coordination-federation-area target #3: only the
 * `deriveLiveness` boundary was tested; `sweepStalePresence` (the DELETE-by-age
 * mutator that keeps the roster from accumulating hundreds of long-ended rows)
 * was unguarded. This drives the `presence.ts` operator adapter export end-to-end
 * — through the module's OWN getOrgPg() handle — so the host-seam wiring + the
 * underlying PgPresenceStore.sweepStale query are exercised together.
 *
 * ⚠ presence-reconcile is su-584a8's federation surface; this touches NEITHER the
 * source nor the reconcile path — it only adds coverage for the existing GC
 * mutator. Seeds explicit heartbeat_at timestamps (admin/bypass) so the age
 * boundary is deterministic; TRUNCATEs coord_presence per test for isolation
 * (no other baseline-DSN suite uses it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { sweepStalePresence, sweepEndedPresence, listPresence } from './presence';
import { fetchWakeability } from './presence-wakeability';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

/** Seed a presence row with an explicit heartbeat age (seconds in the past). */
async function seed(ownerId: string, ageSeconds: number, workspaceId = 'default'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${workspaceId}, 'static-client',
            now() - ${`${ageSeconds} seconds`}::interval)
  `;
}

async function ownerIds(): Promise<string[]> {
  const rows = await admin<{ owner_id: string }[]>`
    SELECT owner_id FROM harness_shared.coord_presence ORDER BY owner_id`;
  return rows.map((r) => r.owner_id);
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`;
});

describe('sweepStalePresence (real PG)', () => {
  it('deletes only rows older than maxAgeMs and returns the count; fresh rows survive', async () => {
    await seed('stale-1hr', 3600);
    await seed('stale-30m', 1800);
    await seed('fresh-now', 0);
    await seed('fresh-2m', 120);

    // 10-minute threshold: the two >10m rows go, the two recent ones stay.
    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['fresh-2m', 'fresh-now']);
  });

  it('returns 0 and deletes nothing when every row is fresh', async () => {
    await seed('a', 1);
    await seed('b', 5);
    const removed = await sweepStalePresence(60 * 60 * 1000); // 1h threshold
    expect(removed).toBe(0);
    expect(await ownerIds()).toEqual(['a', 'b']);
  });

  it('returns 0 on an empty roster', async () => {
    expect(await sweepStalePresence(1000)).toBe(0);
  });

  it('sweeps across workspaces (the GC is not workspace-scoped)', async () => {
    await seed('ws-default-stale', 3600, 'default');
    await seed('ws-other-stale', 3600, 'harness:papercup');
    await seed('ws-other-fresh', 0, 'harness:papercup');

    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['ws-other-fresh']);
  });

  it('clamps a sub-second maxAgeMs to a 1s floor (still removes a clearly-old row)', async () => {
    await seed('ancient', 3600);
    await seed('just-now', 0);
    // maxAgeMs=0 → floor of 1s: the hour-old row goes, the just-now row stays.
    const removed = await sweepStalePresence(0);
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual(['just-now']);
  });

  it('the surviving rows are visible through the listPresence read path', async () => {
    await seed('gone', 3600);
    await seed('kept', 0);
    await sweepStalePresence(10 * 60 * 1000);
    const live = await listPresence();
    expect(live.map((r) => r.ownerId)).toContain('kept');
    expect(live.map((r) => r.ownerId)).not.toContain('gone');
  });
});

/**
 * sweepEndedPresence (the DEFECT-2 short-TTL reaper) against REAL Postgres. Unlike
 * the blunt heartbeat-only `sweepStalePresence`, this evicts a row ONLY when it is
 * BOTH stale-beyond-TTL AND not-wakeable (no live inbox-wake await = `ended`), so a
 * PARKED (stale + live await) session and protected (on-desktop/viewer) owners are
 * never touched. Seeds coord_presence heartbeat ages + event_awaits under a unique
 * prefix (cleaned per test) so it never clobbers a concurrent suite's await rows.
 */
describe('sweepEndedPresence (real PG) — short-TTL ended-row reaper', () => {
  const AW = 'endedreap-';
  const own = (id: string) => `${AW}${id}`;

  /** Seed a LIVE inbox-wake await for `ownerId` (makes the row `parked`, not `ended`). */
  async function seedLiveAwait(ownerId: string): Promise<void> {
    await admin`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
      VALUES (${ownerId}, ${`${COORD_INBOX_WAKE_PREFIX}${ownerId}`}, null, null, null)`;
  }
  async function cleanAwaits(): Promise<void> {
    await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE ${`${AW}%`}`;
  }
  beforeEach(cleanAwaits);
  afterAll(cleanAwaits);

  it('reaps a STALE + not-wakeable (ended) row on the short TTL; a fresh row survives', async () => {
    await seed('ended-old', 3600); // 1h stale, no await → ended
    await seed('fresh-now', 0);
    const removed = await sweepEndedPresence({ ttlMs: 10 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual(['fresh-now']);
  });

  it('SPARES a stale row that is still WAKEABLE (parked — a live inbox-wake await)', async () => {
    const parked = own('parked');
    await seed(parked, 3600); // stale heartbeat…
    await seedLiveAwait(parked); // …but a live await → parked, never reaped here
    await seed('ended', 3600); // stale + no await → ended
    const removed = await sweepEndedPresence({ ttlMs: 10 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual([parked]);
  });

  it('SPARES a protected owner (on-desktop/viewer) even when stale + not wakeable', async () => {
    await seed('on-desktop', 3600);
    await seed('other-dead', 3600);
    const removed = await sweepEndedPresence({
      ttlMs: 10 * 60 * 1000,
      protectedOwners: new Set(['on-desktop']),
    });
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual(['on-desktop']);
  });

  it('does not reap a row younger than the TTL, even if not wakeable', async () => {
    await seed('recent-dead', 120); // 2m stale, below the 10m TTL
    const removed = await sweepEndedPresence({ ttlMs: 10 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(await ownerIds()).toEqual(['recent-dead']);
  });

  it('an EXPIRED await does not protect — the row is still ended → reaped', async () => {
    const expired = own('expired');
    await seed(expired, 3600);
    await admin`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, expires_ts)
      VALUES (${expired}, ${`${COORD_INBOX_WAKE_PREFIX}${expired}`}, ${new Date(Date.now() - 60_000)})`;
    const removed = await sweepEndedPresence({ ttlMs: 10 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual([]);
  });

  it('workspace scope reaps only that workspace\'s ended rows', async () => {
    await seed('ws-a-dead', 3600, 'ws:a');
    await seed('ws-b-dead', 3600, 'ws:b');
    const removed = await sweepEndedPresence({ ttlMs: 10 * 60 * 1000, workspaceId: 'ws:a' });
    expect(removed).toBe(1);
    expect(await ownerIds()).toEqual(['ws-b-dead']);
  });
});

/**
 * fetchWakeability (the P-001 IO seam, fleet-dispatch-wake-clarity-2026-06-22)
 * against REAL Postgres. The `deriveSessionState` boundary is pure-unit-tested in
 * presence-wakeability.test.ts; here we pin the two batch SQL queries — the
 * column names + filter predicates that, if they ever drift, would SILENTLY
 * degrade the wakeable/sessionState fields to absent (the inert-feature failure
 * mode this plan exists to prevent). Reads through the module's own getOrgPg()
 * handle; seeds the shared event_awaits + agent_activity tables under a unique
 * owner prefix (cleaned per-test) so it never TRUNCATEs out a concurrent suite.
 */
describe('fetchWakeability (real PG)', () => {
  // Unique prefix → our seeds never collide with another baseline-DSN suite's
  // rows on these SHARED tables, and we DELETE only our own (no TRUNCATE).
  const P = 'wkt-';
  const own = (id: string) => `${P}${id}`;

  async function clean(): Promise<void> {
    await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE ${`${P}%`}`;
    await admin`DELETE FROM harness_shared.agent_activity WHERE owner_id LIKE ${`${P}%`}`;
  }
  beforeEach(clean);
  afterAll(clean);

  /** Seed one standing inbox-wake await (the `wakeable` signal). Defaults to a
   *  LIVE await (unfired, uncancelled, unexpired, correctly-keyed). */
  async function seedAwait(
    id: string,
    opts: { firedAt?: Date | null; cancelledAt?: Date | null; expiresTs?: Date | null; key?: string } = {},
  ): Promise<void> {
    const owner = own(id);
    await admin`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
      VALUES (${owner}, ${opts.key ?? `${COORD_INBOX_WAKE_PREFIX}${owner}`},
              ${opts.firedAt ?? null}, ${opts.cancelledAt ?? null}, ${opts.expiresTs ?? null})`;
  }

  /** Seed one agent_activity row at a chosen age (the `liveTurn` signal). */
  async function seedActivity(
    id: string,
    opts: { kind: string; summary?: string; agoSec?: number },
  ): Promise<void> {
    await admin`
      INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
      VALUES (${own(id)}, ${opts.kind}, ${opts.summary ?? null},
              ${new Date(Date.now() - (opts.agoSec ?? 0) * 1000)})`;
  }

  it('a live inbox-wake await + a running turn → { wakeable, liveTurn } (the dispatch-now signal)', async () => {
    await seedAwait('live');
    await seedActivity('live', { kind: 'tool', summary: '▶ npm test', agoSec: 3 });
    const m = await fetchWakeability([own('live')]);
    expect(m.get(own('live'))).toEqual({ wakeable: true, liveTurn: true });
  });

  it('a cancelled / fired / expired await is NOT wakeable (it would be the `ended` row)', async () => {
    await seedAwait('cancelled', { cancelledAt: new Date() });
    await seedAwait('fired', { firedAt: new Date() });
    await seedAwait('expired', { expiresTs: new Date(Date.now() - 60_000) });
    const ids = [own('cancelled'), own('fired'), own('expired')];
    const m = await fetchWakeability(ids);
    for (const id of ids) expect(m.get(id)?.wakeable).toBe(false);
  });

  it('a future-expiry await still counts as wakeable', async () => {
    await seedAwait('future', { expiresTs: new Date(Date.now() + 60_000) });
    const m = await fetchWakeability([own('future')]);
    expect(m.get(own('future'))?.wakeable).toBe(true);
  });

  it('an await on a DIFFERENT event_key does not count as inbox-wakeable', async () => {
    // A live await keyed on something other than coord:inbox-wake:<id> must NOT
    // make the agent look dispatchable — the event_key predicate is load-bearing.
    await seedAwait('otherkey', { key: 'lock:grant:abc' });
    const m = await fetchWakeability([own('otherkey')]);
    expect(m.get(own('otherkey'))?.wakeable).toBe(false);
  });

  it('only a trailing session-end marker → liveTurn=false (just-ended-but-still-warm; the heartbeat-lag fix)', async () => {
    await seedAwait('justended');
    await seedActivity('justended', { kind: 'lifecycle', summary: '■ session ended', agoSec: 5 });
    const m = await fetchWakeability([own('justended')]);
    expect(m.get(own('justended'))).toEqual({ wakeable: true, liveTurn: false });
  });

  it('activity AFTER the end-marker → liveTurn=true (a new turn resumed)', async () => {
    await seedAwait('resumed');
    await seedActivity('resumed', { kind: 'lifecycle', summary: 'session ended', agoSec: 30 });
    await seedActivity('resumed', { kind: 'tool', summary: '✎ x.ts', agoSec: 2 });
    const m = await fetchWakeability([own('resumed')]);
    expect(m.get(own('resumed'))).toEqual({ wakeable: true, liveTurn: true });
  });

  it('an owner with no rows is present in the map as { wakeable:false, liveTurn:false }', async () => {
    const m = await fetchWakeability([own('ghost')]);
    expect(m.get(own('ghost'))).toEqual({ wakeable: false, liveTurn: false });
  });

  it('returns an empty map for an empty ownerIds list (no query fired)', async () => {
    const m = await fetchWakeability([]);
    expect(m.size).toBe(0);
  });
});
