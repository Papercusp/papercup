/**
 * resource-broadcast — Phase 3 coord broadcasts for named-resource drain.
 *
 * The PG state machine + the resource_grant_cascade NOTIFY already make
 * drain *work* (the exclusive waiter wakes when shared holders release).
 * These broadcasts are the politeness layer that makes it *prompt*: they
 * tell peers to act.
 *
 *  - drain-start (P-009): a targeted coord message to each current shared
 *    holder — "release when your current use is done; don't start new".
 *  - back-up (P-010): a broadcast that the resource is free again.
 *
 * Both also fireNotifications on the synthetic `resource:<name>` path, so
 * any agent that coord:watch'd the resource is told too (P-011). All
 * best-effort: a broadcast failure must never break the acquire / release.
 */

import { sendMessage } from '../coordination/messages';
import { fireNotifications } from '../coordination/subscriptions';
import type { AgentIdentity } from '../coordination/identity';
import type { ResourceHolder } from './su-lock-store';

/** Synthetic watch path for a named resource (P-011 — coord:watch this). */
export const resourceWatchPath = (resource: string) => `resource:${resource}`;

export async function broadcastResourceDrainStart(params: {
  source: AgentIdentity;
  resource: string;
  holders: ResourceHolder[];
  reason: string;
}): Promise<void> {
  const owners = [
    ...new Set(params.holders.filter((h) => h.mode === 'shared').map((h) => h.owner)),
  ];
  try {
    if (owners.length > 0) {
      await sendMessage(params.source, {
        to: owners,
        summary: `🔒 "${params.resource}" is draining for an exclusive hold by ${params.source.ownerLabel} — release when your current use is done`,
        body: `${params.source.ownerLabel} needs exclusive access to "${params.resource}"${
          params.reason ? ` (${params.reason})` : ''
        }. Finish your current use and call locks:release_resource — do NOT start new work needing it. You'll be notified when it's back up.`,
      });
    }
    await fireNotifications(params.source, [resourceWatchPath(params.resource)], 'any');
  } catch {
    // best-effort — a broadcast failure must never break the acquire/drain.
  }
}

export async function broadcastResourceBackUp(params: {
  source: AgentIdentity;
  resource: string;
}): Promise<void> {
  try {
    await sendMessage(params.source, {
      to: ['*'],
      summary: `✅ "${params.resource}" is back up (released by ${params.source.ownerLabel})`,
      body: `${params.source.ownerLabel} finished its exclusive hold on "${params.resource}". You can acquire it again with locks:acquire_resource.`,
    });
    await fireNotifications(params.source, [resourceWatchPath(params.resource)], 'any');
  } catch {
    // best-effort
  }
}
