/**
 * resource-broadcast — named-resource drain coord broadcasts (P-009 / P-010).
 *
 * Drain-start sends a targeted coord MESSAGE to each shared holder ("release
 * please"); back-up broadcasts a "resource is free again" MESSAGE to all. Locks
 * are control-plane (coordination-substrate D-007): the old path-glob
 * `fireNotifications(resource:<name>)` watcher-notify was retired with coord:watch
 * (Phase 3), so these are plain messages now. Live PG coord log; unique owner ids
 * per test isolate assertions from the shared coord stream.
 *
 * Also covers gcOldNotifies (relocated to coordination/notify-gc): it prunes the
 * subscribe→inject fan-out's `notify` rows from coord_event_log past retention.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getTxPool } from '../su-lock-store';
import { readInbox } from '../../coordination/messages';
import { coordLog } from '../../coordination/log';
import { gcOldNotifies } from '../../coordination/notify-gc';
import { newMsgId, type CoordEnvelope } from '@papercusp/coordination/core';
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
  fence_seq: 0,
});

describe('resource broadcasts (named-resource drain)', async () => {
  const live = await dbLive();

  // Prime the org PG handle (see note: first getOrgPg() can race drizzle load).
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

  it.skipIf(!live)('back-up targets the waiters, not the whole fleet (A4)', async () => {
    const u = uniq();
    const waiter = `up-waiter-${u}`;
    const bystander = `up-bystander-${u}`;
    const src = mkIdentity(`up-R-${u}`);
    await broadcastResourceBackUp({ source: src, resource: 'dev-server', waiters: [waiter] });

    // The waiter who was refused while it was held gets the back-up.
    const waiterInbox = await readInbox(waiter);
    expect(waiterInbox.some((m) => m.from === src.ownerId && /back up/i.test(m.summary ?? ''))).toBe(true);
    // A bystander who never waited is NOT spammed (the old ['*'] firehose is gone).
    const bystanderInbox = await readInbox(bystander);
    expect(bystanderInbox.some((m) => m.from === src.ownerId && /back up/i.test(m.summary ?? ''))).toBe(false);

    // No waiters → no broadcast at all.
    const src2 = mkIdentity(`up-R2-${u}`);
    await broadcastResourceBackUp({ source: src2, resource: 'dev-server', waiters: [] });
    const nobody = await readInbox(`up-nobody-${u}`);
    expect(nobody.some((m) => m.from === src2.ownerId)).toBe(false);
  });

  it.skipIf(!live)('gcOldNotifies prunes notify rows past the retention window', async () => {
    const u = uniq();
    const recipient = `gc-rcpt-${u}`;
    const env: CoordEnvelope = {
      ts: new Date().toISOString(),
      msg_id: newMsgId(),
      from: `gc-src-${u}`,
      to: [recipient],
      kind: 'notify',
      notify_kind: 'feature_updated',
      summary: 'fan-out notice',
    };
    await coordLog.appendLine('messages', recipient, env);

    const before = await readInbox(recipient, { kinds: ['notify'] });
    expect(before.some((m) => m.msg_id === env.msg_id)).toBe(true);

    await gcOldNotifies(0); // retentionDays=0 → drop everything older than now
    const after = await readInbox(recipient, { kinds: ['notify'] });
    expect(after.some((m) => m.msg_id === env.msg_id)).toBe(false);
  });
});
