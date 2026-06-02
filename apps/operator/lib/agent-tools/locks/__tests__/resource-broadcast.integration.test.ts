/**
 * resource-broadcast — Phase 3 coord broadcasts (P-009 / P-010 / P-011).
 *
 * Drain-start sends a targeted coord message to each shared holder ("release
 * please"); back-up broadcasts + fires a watcher notify. Both also fire
 * fireNotifications on the synthetic `resource:<name>` path so agents that
 * coord:watch a resource are told (P-011). Live PG coord log; unique owner
 * ids per test isolate assertions from the shared coord stream.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getTxPool } from '../su-lock-store';
import { readInbox } from '../../coordination/messages';
import { addWatch } from '../../coordination/subscriptions';
import type { AgentIdentity } from '../../coordination/identity';
import type { ResourceHolder } from '../su-lock-store';
import {
  broadcastResourceDrainStart,
  broadcastResourceBackUp,
} from '../resource-broadcast';

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

const mkIdentity = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `res:${ownerId}`,
  source: 'static-client',
  workspaceId: null,
  userId: null,
});

const sharedHolder = (owner: string): ResourceHolder => ({
  owner,
  owner_label: `res:${owner}`,
  mode: 'shared',
  status: 'held',
  lock_id: '00000000-0000-0000-0000-000000000000',
  reason: '',
  acquired_ts: new Date(),
  expires_ts: new Date(Date.now() + 60_000),
});

describe('resource broadcasts (Phase 3)', async () => {
  const live = await dbLive();

  // Prime the org PG handle. The very first getOrgPg() in a test process can
  // race drizzle schema-module load — it caches a usable .sql client but
  // throws building the (here-unused) drizzle handle, so the first coord
  // write fails while later ones succeed. Coord writes need only .sql; prime
  // it here and tolerate that first-call throw so test order can't flake us.
  beforeAll(async () => {
    if (live) await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  it.skipIf(!live)('drain-start sends a targeted "release" message to each shared holder', async () => {
    const u = uniq();
    const src = mkIdentity(`drain-X-${u}`);
    const holderA = `drain-A-${u}`;
    const holderB = `drain-B-${u}`;

    await broadcastResourceDrainStart({
      source: src,
      resource: 'dev-server',
      holders: [sharedHolder(holderA), sharedHolder(holderB)],
      reason: 'restart test',
    });

    const inboxA = await readInbox(holderA);
    const inboxB = await readInbox(holderB);
    expect(inboxA.some((m) => m.from === src.ownerId && /draining/i.test(m.summary ?? ''))).toBe(true);
    expect(inboxB.some((m) => m.from === src.ownerId && /draining/i.test(m.summary ?? ''))).toBe(true);
  });

  it.skipIf(!live)('back-up fires a notify to a resource watcher (P-011)', async () => {
    const u = uniq();
    const watcher = mkIdentity(`watch-W-${u}`);
    await addWatch(watcher, { pattern: 'resource:**', trigger: 'any', ttl_sec: 120 });

    const src = mkIdentity(`up-R-${u}`);
    await broadcastResourceBackUp({ source: src, resource: 'dev-server' });

    const inbox = await readInbox(watcher.ownerId);
    expect(
      inbox.some(
        (m) =>
          m.from === src.ownerId &&
          m.kind === 'notify' &&
          m.matched_path === 'resource:dev-server',
      ),
    ).toBe(true);
  });
});
