/**
 * resource-broadcast-resume — the end-to-end broadcast→resume cycle (P-021).
 *
 * Exercises the WHOLE named-resource drain cycle through the real helpers, not
 * the broadcast/wait halves in isolation:
 *
 *   1. Two shared holders hold `dev-server`; a watcher coord:watches it.
 *   2. A requester takes the exclusive via acquireResourceExclusiveWithWait
 *      (wired exactly like locks:acquire_resource — onDrainStart fires
 *      broadcastResourceDrainStart). It parks in `draining`.
 *   3. The drain-start broadcast lands a `notify` in the watcher's inbox.
 *   4. The shared holders release → resource_grant_cascade NOTIFYs the parked
 *      waiter, which RE-ACQUIRES (flips to `held`). This is the "resume".
 *   5. The requester releases its exclusive → broadcastResourceBackUp lands a
 *      SECOND `notify` in the watcher's inbox.
 *
 * So both halves P-021 names — "a notify lands in the watcher inbox" and "a
 * parked waiter re-acquires after release" — are asserted in one real cycle.
 * Live PG + real NOTIFY; unique owner ids isolate assertions from the shared
 * coord stream.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  tryReleaseResource,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import { acquireResourceExclusiveWithWait } from '../resource-acquire-wait';
import {
  broadcastResourceDrainStart,
  broadcastResourceBackUp,
} from '../resource-broadcast';
import { readInbox } from '../../coordination/messages';
import { addWatch } from '../../coordination/subscriptions';
import type { AgentIdentity } from '../../coordination/identity';

const RESOURCE = 'dev-server';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mkIdentity = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `res:${ownerId}`,
  source: 'static-client',
  workspaceId: null,
  userId: null,
});

const acqShared = (ws: string, owner: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource: RESOURCE,
      mode: 'shared',
      owner,
      ownerLabel: `res:${owner}`,
      reason: 'test',
      ttlSec: 60,
    }),
  );

const rel = (ws: string, owner: string, lockId: string) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryReleaseResource(tx, { coordinationDomain: ws, owner, lockId }),
  );

/** Notifies for RESOURCE from a given source that landed in `watcher`'s inbox. */
async function resourceNotifies(watcher: string, from: string) {
  const inbox = await readInbox(watcher, { kinds: ['notify'] });
  return inbox.filter(
    (m) =>
      m.from === from &&
      m.kind === 'notify' &&
      m.matched_path === `resource:${RESOURCE}`,
  );
}

describe('resource broadcast→resume cycle (P-021)', async () => {
  const live = await dbLive();

  // Prime the org PG handle — the first getOrgPg() in a test process can race
  // drizzle schema-module load (caches a usable .sql client but throws building
  // the unused drizzle handle), so the first coord write fails while later ones
  // succeed. Coord writes need only .sql; tolerate that first-call throw.
  beforeAll(async () => {
    if (live) await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  afterAll(async () => {
    if (live) {
      await _resetListenersForTests();
      await _resetForTests();
    }
  });

  it.skipIf(!live)(
    'drain-start notifies a watcher, the parked waiter resumes on release, and back-up notifies again',
    async () => {
      await ensureBootstrap();
      const ws = `res-bcast-resume-ws-${uniq()}`;
      const u = uniq();

      const reqId = `bcr-R-${u}`;
      const srcR = mkIdentity(reqId);
      const watcher = `bcr-W-${u}`;
      const holderA = `bcr-A-${u}`;
      const holderB = `bcr-B-${u}`;

      // The watcher must opt into notifies (D-002 de-noise): coord:watch the resource.
      await addWatch(mkIdentity(watcher), {
        pattern: 'resource:**',
        trigger: 'any',
        ttl_sec: 120,
      });

      // Two shared holders occupy dev-server.
      const a = await acqShared(ws, holderA);
      const b = await acqShared(ws, holderB);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // Requester takes the exclusive — parks in `draining`, fires drain-start
      // (wired exactly like locks:acquire_resource).
      const pending = acquireResourceExclusiveWithWait({
        coordinationDomain: ws,
        owner: reqId,
        ownerLabel: srcR.ownerLabel,
        resource: RESOURCE,
        reason: 'restart',
        ttlSec: 60,
        maxWaitSec: 15,
        onDrainStart: (holders) =>
          broadcastResourceDrainStart({
            source: srcR,
            resource: RESOURCE,
            holders,
            reason: 'restart',
          }),
      });

      // Let it acquire (draining) + subscribe + fire the drain-start broadcast.
      await sleep(500);

      // BROADCAST HALF — the drain-start notify landed in the watcher's inbox.
      const afterDrainStart = await resourceNotifies(watcher, reqId);
      expect(afterDrainStart.length).toBeGreaterThanOrEqual(1);

      // Drain both shared holders → the grant cascade flips R to held + NOTIFYs it.
      await rel(ws, holderA, a.lock_id);
      await rel(ws, holderB, b.lock_id);

      // RESUME HALF — the parked waiter re-acquires after release.
      const r = await pending;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.status).toBe('held');
      if (r.status !== 'held') return;

      const exclusiveLockId = r.lock_id;

      // Release the exclusive → broadcastResourceBackUp (mirrors locks:release_resource).
      const released = await rel(ws, reqId, exclusiveLockId);
      expect(released.exclusiveResources).toContain(RESOURCE);
      await broadcastResourceBackUp({ source: srcR, resource: RESOURCE });

      // BACK-UP HALF — a SECOND notify (drain-start + back-up = 2) reached the watcher.
      const afterBackUp = await resourceNotifies(watcher, reqId);
      expect(afterBackUp.length).toBeGreaterThan(afterDrainStart.length);
    },
  );
});
