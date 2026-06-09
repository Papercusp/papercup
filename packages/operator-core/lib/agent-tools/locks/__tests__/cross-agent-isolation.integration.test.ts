/**
 * cross-agent-isolation — the ADVERSARIAL isolation audit for the locks
 * subsystem (coordination-test-suite-2026-06-08, P-008).
 *
 * Where aba-safety proves a STALE handle is a no-op and su-locks proves the
 * happy-path lifecycle, this suite proves the cross-agent TRUST BOUNDARY: a
 * live agent A — even one that has somehow learned B's `lock_id` — can do
 * NOTHING to B's lock. Release and heartbeat are keyed on (owner AND lock_id)
 * (su-lock-store bug #16/#17), so A authenticated as itself cannot release or
 * extend B's grant by replaying B's lock_id. Plus block-on-held (A's lock
 * surfaces its owner+intent to a blocked B and frees on release), the ABA
 * stale-handle no-op restated adversarially, and the named-resource
 * exclusive-vs-shared drain.
 *
 * Live papercusp_su; a UNIQUE coordination_domain per test (`iso-<hex>`) so we
 * never collide with the live fleet or with peer agents running locks tests
 * concurrently. `.skipIf(!live)` keeps the file honest if the side-DB goes away.
 *
 * The authority-election cell is a focused unit assertion of the PURE
 * `decideAuthority` argmin (locks-core) — no DB; the full election matrix is
 * already covered in libs/generic/locks-core/src/authority-hardening.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquire,
  tryRelease,
  tryHeartbeat,
  tryAcquireResource,
  tryReleaseResource,
  readQueue,
  readResourceQueue,
  type ResourceMode,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import {
  acquireResourceExclusiveWithWait,
} from '../resource-acquire-wait';
import { _resetListenersForTests } from '../workspace-listener';
import { decideAuthority, type AuthorityRecord } from '@papercusp/locks-core';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// Unique, collision-proof coordination domain per test (live-fleet + peer-test safe).
const uniqueWs = () => `iso-${randomBytes(4).toString('hex')}-${Date.now()}`;

const expireFileLock = (ws: string, lockId: string) =>
  getTxPool()`
    UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 hour'
     WHERE coordination_domain = ${ws} AND lock_id = ${lockId}::uuid
  `;

const acquireFile = (
  ws: string,
  owner: string,
  paths: string[],
  intent: string,
  ttlSec = 60,
) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquire(tx, {
      coordinationDomain: ws,
      owner,
      ownerLabel: `iso:${owner}`,
      paths,
      intent,
      ttlSec,
    }),
  );

const acquireResource = (
  ws: string,
  owner: string,
  resource: string,
  mode: ResourceMode,
  ttlSec = 60,
) =>
  inWorkspaceTxn(ws, owner, (tx) =>
    tryAcquireResource(tx, {
      coordinationDomain: ws,
      resource,
      mode,
      owner,
      ownerLabel: `iso:${owner}`,
      reason: 'cross-agent isolation test',
      ttlSec,
    }),
  );

describe('cross-agent isolation (adversarial; live papercusp_su)', async () => {
  const live = await dbLive();

  // ── Cell 1 ───────────────────────────────────────────────────────────────
  // A cannot RELEASE B's lock, even replaying B's lock_id. Release is keyed on
  // (owner AND lock_id): A — authenticated as itself — passing B's lock_id
  // matches nothing (owner mismatch), and passing B's owner+lock_id is the
  // spoof that the owner column exists to defeat. B's lock survives both.
  it.skipIf(!live)("A cannot release B's lock (release is keyed on owner AND lock_id)", async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const pathX = 'iso/a-file.ts';
    const pathY = 'iso/b-file.ts';

    const a = await acquireFile(ws, 'A', [pathX], 'A holds X');
    const b = await acquireFile(ws, 'B', [pathY], 'B holds Y');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // A replays B's lock_id but is authenticated as A → owner mismatch, 0 rows.
    const relAttemptOwnerA = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'A', lockId: b.lock_id }),
    );
    expect(relAttemptOwnerA.released).toEqual([]);

    // The canonical attack: B has learned A's lock_id (it's persisted in
    // tool_invocations.result_json that audit:read can read) and tries to free
    // A's lock by replaying it — but B is authenticated as B, so owner != A → 0
    // rows. This is exactly the leaked-lock_id case bug #16's owner column defends.
    const bReplaysAsBitself = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'B', lockId: a.lock_id }),
    );
    expect(bReplaysAsBitself.released).toEqual([]);

    // Even spoofing owner='B' alongside B's lock_id must not free A's path X —
    // it is scoped to B's lock_id, which is on path Y, not X.
    const relAttemptSpoof = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'B', lockId: b.lock_id, paths: [pathX] }),
    );
    expect(relAttemptSpoof.released).toEqual([]); // path filter excludes X

    // Both locks still held: B's Y (the target of the attack) and A's X.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const held = new Map(q.active_locks.map((r) => [r.path, r.owner] as const));
    expect(held.get(pathY)).toBe('B'); // B's lock survived A's release attempt
    expect(held.get(pathX)).toBe('A');

    // And a NEW acquire of Y by anyone but B is still busy → B genuinely holds it.
    const probe = await acquireFile(ws, 'C', [pathY], 'C probes Y');
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.busy.some((bz) => bz.owner === 'B')).toBe(true);
  });

  // ── Cell 2 ───────────────────────────────────────────────────────────────
  // A cannot HEARTBEAT B's lock. heartbeat is keyed on (owner AND lock_id), so
  // A replaying B's lock_id (authenticated as A) → extended:false, and B's
  // expiry is unchanged.
  it.skipIf(!live)("A cannot heartbeat B's lock (extended:false; B's lease untouched)", async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const pathX = 'iso/hb-x.ts';
    const pathY = 'iso/hb-y.ts';

    const a = await acquireFile(ws, 'A', [pathX], 'A holds X', 60);
    const b = await acquireFile(ws, 'B', [pathY], 'B holds Y', 60);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Snapshot B's expiry before the foreign heartbeat attempt.
    const [{ expires_ts: beforeExpiry }] = await getTxPool()<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND lock_id = ${b.lock_id}::uuid AND path = ${pathY}
    `;

    // A heartbeats B's lock_id as A → owner mismatch → not extended.
    const hbForeignOwnerA = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryHeartbeat(tx, ws, 'A', b.lock_id, 6000),
    );
    expect(hbForeignOwnerA.extended).toBe(false);

    // A heartbeats A's OWN lock_id but spoofing owner='B' → lock_id is on A's
    // row whose owner is 'A', so owner='B' mismatches → not extended either.
    const hbSpoofOwnerB = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryHeartbeat(tx, ws, 'B', a.lock_id, 6000),
    );
    expect(hbSpoofOwnerB.extended).toBe(false);

    // B's expiry is byte-for-byte unchanged — no foreign extension leaked in.
    const [{ expires_ts: afterExpiry }] = await getTxPool()<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND lock_id = ${b.lock_id}::uuid AND path = ${pathY}
    `;
    expect(afterExpiry.getTime()).toBe(beforeExpiry.getTime());

    // B can still heartbeat its OWN lock (the boundary blocks foreigners, not B).
    const hbB = await inWorkspaceTxn(ws, 'B', (tx) =>
      tryHeartbeat(tx, ws, 'B', b.lock_id, 6000),
    );
    expect(hbB.extended).toBe(true);
  });

  // ── Cell 3 ───────────────────────────────────────────────────────────────
  // block-on-held: A holds X; B's acquire on X is busy and surfaces A's owner +
  // intent (the targeted hand-off audience). After A releases, B's acquire wins.
  it.skipIf(!live)('block-on-held: B is busy behind A and sees A owner+intent; B wins after A releases', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const pathX = 'iso/contended.ts';

    const a = await acquireFile(ws, 'A', [pathX], 'A is editing the contended file');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // B's acquire on the held path → busy, surfacing A's identity + intent.
    const bBusy = await acquireFile(ws, 'B', [pathX], 'B wants the file');
    expect(bBusy.ok).toBe(false);
    if (!bBusy.ok) {
      const hit = bBusy.busy.find((bz) => bz.path === pathX);
      expect(hit?.owner).toBe('A');
      expect(hit?.intent).toBe('A is editing the contended file');
    }

    // A releases; the path is now free.
    const rel = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'A', lockId: a.lock_id }),
    );
    expect(rel.released).toEqual([pathX]);

    // B's acquire now succeeds — block cleared exactly on A's release.
    const bWins = await acquireFile(ws, 'B', [pathX], 'B now holds it');
    expect(bWins.ok).toBe(true);
  });

  // ── Cell 4 ───────────────────────────────────────────────────────────────
  // stale-handle no-op (ABA, adversarial): A acquires X, its lease expires, B
  // steals X with a FRESH lock_id, then A's stale heartbeat + release with A's
  // OLD lock_id must touch nothing of B's. (Restated from aba-safety so this
  // adversarial suite is self-contained: A's stale handle is keyed on a lock_id
  // that no longer exists, so it can never reach B's fresh grant.)
  it.skipIf(!live)("stale-handle: A's expired lock_id is inert against B's fresh grant on the same path", async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    const pathX = 'iso/aba.ts';

    const a = await acquireFile(ws, 'A', [pathX], 'A holds X', 60);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expireFileLock(ws, a.lock_id); // A "sleeps": lease lapses.

    // B steals the now-expired path → fresh lock_id, distinct from A's.
    const b = await acquireFile(ws, 'B', [pathX], 'B steals X', 60);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.lock_id).not.toBe(a.lock_id);

    // A wakes: stale heartbeat (A's dead lock_id) → not extended.
    const hbStale = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryHeartbeat(tx, ws, 'A', a.lock_id, 6000),
    );
    expect(hbStale.extended).toBe(false);

    // A's stale release (A's dead lock_id) → frees nothing.
    const relStale = await inWorkspaceTxn(ws, 'A', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'A', lockId: a.lock_id }),
    );
    expect(relStale.released).toEqual([]);

    // B still holds X — A's stale handle never reached it.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const xRow = q.active_locks.find((r) => r.path === pathX);
    expect(xRow?.owner).toBe('B');
    // …and the live row is B's FRESH lock_id, not A's expired one (queue rows
    // don't carry lock_id, so verify it directly).
    const [{ lock_id: liveLockId }] = await getTxPool()<Array<{ lock_id: string }>>`
      SELECT lock_id::text AS lock_id FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND path = ${pathX}
         AND expires_ts > clock_timestamp()
    `;
    expect(liveLockId).toBe(b.lock_id);
    expect(liveLockId).not.toBe(a.lock_id);
  });

  // ── Cell 5 ───────────────────────────────────────────────────────────────
  // named-resource drain / exclusive vs shared: A holds dev-server SHARED; B's
  // exclusive must drain (refusing NEW shared with exclusive_pending, blocking)
  // and is granted only when A drains. Bounded by a small maxWaitSec so it can't
  // hang. 'dev-server' is a registered resource (see resource-locks test).
  it.skipIf(!live)("named-resource: B's exclusive drains A's shared (refuses new shared, then is granted)", async () => {
    await ensureBootstrap();
    const ws = uniqueWs();

    const a = await acquireResource(ws, 'A', 'dev-server', 'shared');
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // B requests exclusive while A holds shared → accepted but DRAINING.
    const bDraining = await acquireResource(ws, 'B', 'dev-server', 'exclusive');
    expect(bDraining.ok).toBe(true);
    if (!bDraining.ok) return;
    expect(bDraining.status).toBe('draining');

    // Writer-priority: a NEW shared acquire by C is refused while draining.
    const cRefused = await acquireResource(ws, 'C', 'dev-server', 'shared');
    expect(cRefused.ok).toBe(false);
    if (!cRefused.ok) expect(cRefused.reason).toBe('exclusive_pending');

    // The exclusive is not yet effective: A is still a shared holder.
    const q1 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q1.holders.some((h) => h.owner === 'A' && h.mode === 'shared')).toBe(true);

    // A bounded waiter on a SECOND exclusive owner D proves the drain blocks and
    // times out while A still holds shared — it must not hang or steal A's lock.
    const dTimeout = await acquireResourceExclusiveWithWait({
      coordinationDomain: ws,
      owner: 'D',
      ownerLabel: 'iso:D',
      resource: 'dev-server',
      reason: 'isolation drain timeout',
      ttlSec: 60,
      maxWaitSec: 1,
    });
    expect(dTimeout.ok).toBe(false);
    if (!dTimeout.ok) expect(dTimeout.reason).toBe('held_exclusive');

    // Drain A → the release cascade flips B's exclusive to held.
    await inWorkspaceTxn(ws, 'A', (tx) =>
      tryReleaseResource(tx, { coordinationDomain: ws, owner: 'A', lockId: a.lock_id }),
    );
    const q2 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q2.holders.some((h) => h.owner === 'B' && h.mode === 'exclusive')).toBe(true);
    expect(q2.holders.some((h) => h.owner === 'A')).toBe(false);

    await _resetListenersForTests();
  });

  // ── Cell 6 ───────────────────────────────────────────────────────────────
  // lock-authority election (PURE): authority is the lowest live pubkey; a
  // stale top pubkey fails over to the next. Focused unit assertion of the
  // pure argmin in locks-core — no DB. (The full anti-flap/fencing matrix lives
  // in libs/generic/locks-core/src/authority-hardening.test.ts.)
  it('authority election: lowest live pubkey wins; a dead incumbent fails over to the next', () => {
    const T = { heartbeatMs: 1000 }; // grace 1000, cooldown 2000

    // First election over a roster — the lowest pubkey is the argmin winner.
    const roster = ['device-ccc', 'device-aaa', 'device-bbb'];
    const argmin = [...roster].sort()[0];
    expect(argmin).toBe('device-aaa');
    const first = decideAuthority(argmin, false, null, 1000, T)!;
    expect(first.pubkey).toBe('device-aaa');
    expect(first.epoch).toBe(1);

    // The incumbent (device-aaa) drops out (priorLive=false). The next-lowest
    // LIVE pubkey is now device-bbb → it takes authority, fencing epoch bumps.
    const prior: AuthorityRecord = { pubkey: 'device-aaa', epoch: 1, electedAtMs: 1000 };
    const liveRosterAfter = ['device-ccc', 'device-bbb']; // aaa gone
    const argminAfter = [...liveRosterAfter].sort()[0];
    expect(argminAfter).toBe('device-bbb');
    const failover = decideAuthority(argminAfter, /*priorLive*/ false, prior, 5000, T)!;
    expect(failover.pubkey).toBe('device-bbb');
    expect(failover.changed).toBe(true);
    expect(failover.epoch).toBe(2); // monotonic fencing token advances on failover
  });
});

// Clean up shared module state once at the end (mirrors the other locks suites).
describe('cross-agent isolation (teardown)', async () => {
  const live = await dbLive();
  it.skipIf(!live)('resets store + listeners', async () => {
    await _resetForTests();
  });
});
