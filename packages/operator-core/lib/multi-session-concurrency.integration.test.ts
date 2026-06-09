// @vitest-environment node
/**
 * multi-session-concurrency.integration.test.ts — the C3 CAPSTONE
 * (coordination-test-suite-2026-06-08 P-011).
 *
 * N genuinely-isolated sessions (the keystone `MultiSessionTestbed`) drive every
 * coordination channel CONCURRENTLY against real Postgres + real sockets, and we
 * assert the one property the whole plan exists for: under N-session concurrency,
 * **zero loss, zero duplication, zero misroute** across wakes, sends, claims, and
 * locks. This is the topology where EI-152 + EI-153 actually manifested (dozens of
 * sessions on one box sharing a cwd) and which nothing previously tested.
 *
 * Channels and DBs:
 *   - wake   — real `event_awaits`/`event_wake_deliveries` store + the real pump +
 *              each session's OWN live control socket (testbed). Each wake lands on
 *              its own socket; no wake reaches a peer.
 *   - send   — real `PgCoordLog` (coord_event_log) via the production `sendMessage`/
 *              `readInbox` adapter. Each directed message reaches exactly its addressee.
 *   - claim  — real `work_item_claims` (`acquireClaimLocal`). Concurrent racers per
 *              item ⇒ exactly one winner; no double-claim.
 *   - locks  — real `papercusp_su` file locks. Concurrent racers per path ⇒ one
 *              grant; distinct paths ⇒ all granted. (skips if the side-DB is down.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';
import { MultiSessionTestbed, type TestSession } from '../test/_multi-session-testbed';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-concurrency-e2e' }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.ws, backgroundWorkspaceIds: () => [h.ws] };
});

const store = await import('./events/await/store');
const engine = await import('./events/await/engine');
const { armInboxWake } = await import('./events/await/inbox-wake-arm');
const { inboxWakeKey } = await import('./agent-tools/coordination/inbox-wake');
const { configureCoordLog, resetCoordLog } = await import('./agent-tools/coordination/log');
const { sendMessage, readInbox } = await import('./agent-tools/coordination/messages');
const { PgCoordLog } = await import('@papercusp/coordination/event-log');
const { acquireClaimLocal, getClaim } = await import('./work-item-claims');
const { createOrgTestDb } = await import('../test/_org-test-db');
const lockStore = await import('./agent-tools/locks/su-lock-store');
const { inWorkspaceTxn } = await import('./agent-tools/locks/in-workspace-txn');

const N = 5;

describe('C3 capstone — N-session concurrency: zero loss / dup / misroute', () => {
  let db: OrgTestDb;
  let tb: MultiSessionTestbed;
  let sessions: TestSession[];

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
    resetCoordLog();
  });

  beforeEach(() => {
    // The pump narrates deliveries via console.warn — expected operational noise.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tb = MultiSessionTestbed.create();
    sessions = tb.sessions_(N);
  });

  afterEach(async () => {
    await tb.destroy();
  });

  it('WAKE: N concurrent wakes each land on their OWN live socket — none on a peer', async () => {
    const hosts = await Promise.all(sessions.map((s) => tb.spawnSocketHost(s.ownerId)));

    // Arm every session, then concurrently fire each one's inbox-wake + queue a delivery.
    await Promise.all(sessions.map((s) => armInboxWake({ ownerId: s.ownerId, minSleepSec: 0, workspaceId: h.ws })));
    await Promise.all(
      sessions.map(async (s) => {
        const fired = await store.fireAwaitsForKey({ eventKey: inboxWakeKey(s.ownerId), workspaceId: h.ws });
        await store.insertDeliveries({ awaits: fired });
      }),
    );

    // ONE pump tick drains all due deliveries, routing each via the executor's REAL
    // discovery pointed at the testbed's isolated socket dir.
    const stats = await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });
    // A second tick mops up anything the per-tick resume cap deferred (there are none
    // here — socket-inject isn't resume — but keep it robust).
    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: tb.findPsuHostDep() });

    // Zero loss: every session got exactly one delivered wake on its OWN socket.
    for (let i = 0; i < N; i++) {
      expect(hosts[i].received).toHaveLength(1); // not 0 (loss), not 2 (dup)
      // Zero misroute: the turn that landed on socket i references session i's key.
      expect(hosts[i].received[0].data).toContain(inboxWakeKey(sessions[i].ownerId));
      // And references NO peer's key.
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        expect(hosts[i].received[0].data).not.toContain(sessions[j].ownerId);
      }
      const recent = await store.listRecentDeliveries(sessions[i].ownerId);
      expect(recent.filter((d) => d.status === 'delivered')).toHaveLength(1);
    }
    expect(stats).toBeDefined();
  });

  it('SEND: N concurrent directed messages each reach exactly their addressee', async () => {
    const WS = `ws-send-${randomBytes(3).toString('hex')}`;
    configureCoordLog(new PgCoordLog({ getSql: () => db.adminSql as never, ensureSchema: async () => {}, workspaceId: WS }));
    try {
      // Ring: session i sends a uniquely-tagged note to session (i+1)%N, all at once.
      const tag = (i: number) => `note-from-${i}-${randomBytes(2).toString('hex')}`;
      const tags = sessions.map((_, i) => tag(i));
      await Promise.all(
        sessions.map((s, i) =>
          sendMessage(
            { ownerId: s.ownerId, ownerLabel: s.ownerId, source: 'omp-hook-session', workspaceId: WS, userId: null },
            { to: [sessions[(i + 1) % N].ownerId], summary: tags[i] },
          ),
        ),
      );

      // Each addressee (i+1) sees EXACTLY the one message from its sender i — no loss,
      // no duplication, no cross-talk from any other sender.
      for (let i = 0; i < N; i++) {
        const addressee = sessions[(i + 1) % N].ownerId;
        const inbox = (await readInbox(addressee)).map((m) => m.summary);
        expect(inbox).toEqual([tags[i]]);
      }
    } finally {
      resetCoordLog();
      await db.adminSql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${WS}`;
    }
  });

  it('CLAIM: concurrent racers per item ⇒ exactly one winner, no double-claim', async () => {
    const harness = 'papercup';
    const items = ['F-c1', 'F-c2', 'F-c3'];
    // Every session races for EVERY item, all concurrently.
    const attempts = items.flatMap((item) =>
      sessions.map((s) => acquireClaimLocal({ workspaceId: h.ws, harnessSlug: harness, workItemId: item, owner: s.ownerId })),
    );
    const results = await Promise.all(attempts);

    const winners = results.filter((r) => r.ok);
    // Exactly one winner per item — no more (no double-claim), no fewer (no loss).
    expect(winners).toHaveLength(items.length);
    for (const item of items) {
      const held = await getClaim(h.ws, harness, item);
      expect(held).not.toBeNull();
      const rows = await db.adminSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.work_item_claims
         WHERE workspace_id = ${h.ws} AND harness_slug = ${harness} AND work_item_id = ${item}`;
      expect(rows[0].n).toBe(1); // exactly one holder row
    }
    await db.adminSql`DELETE FROM harness_shared.work_item_claims WHERE harness_slug = ${harness}`;
  });

  it('LOCKS: concurrent racers per path ⇒ one grant; distinct paths ⇒ all granted', async () => {
    let live = false;
    try {
      await lockStore.ensureBootstrap(); // init the side-DB schema + pool (idempotent)
      await lockStore.getTxPool()`SELECT 1`;
      live = true;
    } catch {
      live = false;
    }
    if (!live) {
      // eslint-disable-next-line no-console
      console.info('[capstone] papercusp_su not reachable — skipping the locks channel');
      return;
    }
    const ws = `cap-${randomBytes(4).toString('hex')}`;
    const acquire = (owner: string, paths: string[]) =>
      inWorkspaceTxn(ws, owner, (tx) =>
        lockStore.tryAcquire(tx, { coordinationDomain: ws, owner, ownerLabel: `cap:${owner}`, paths, intent: 'capstone', ttlSec: 30 }),
      );

    // Same path, N racers → exactly one grant.
    const samePath = `src/contended-${randomBytes(3).toString('hex')}.ts`;
    const sameResults = await Promise.all(sessions.map((s) => acquire(s.ownerId, [samePath])));
    expect(sameResults.filter((r) => r.ok)).toHaveLength(1);

    // Distinct paths, N racers → all granted (no false contention / misroute).
    const distinctResults = await Promise.all(
      sessions.map((s, i) => acquire(s.ownerId, [`src/distinct-${i}-${randomBytes(2).toString('hex')}.ts`])),
    );
    expect(distinctResults.every((r) => r.ok)).toBe(true);

    // Cleanup: release everything in this throwaway domain. tryRelease takes a
    // PARAMS OBJECT ({coordinationDomain, owner, lockId}), not positional args.
    const release = (owner: string, lockId: string) =>
      inWorkspaceTxn(ws, owner, (tx) => lockStore.tryRelease(tx, { coordinationDomain: ws, owner, lockId }));
    for (let i = 0; i < sameResults.length; i++) {
      const r = sameResults[i];
      if (r.ok) await release(sessions[i].ownerId, r.lock_id);
    }
    for (let i = 0; i < distinctResults.length; i++) {
      const r = distinctResults[i];
      if (r.ok) await release(sessions[i].ownerId, r.lock_id);
    }
  });
});
