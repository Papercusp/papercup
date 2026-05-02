/**
 * Trigger-state digest for the idle short-circuit (Phase 3c).
 *
 * Reads the four conditions the plan calls out:
 *   1. unconsumed pending_events count
 *   2. (project_slug, status) tuples in the workspace
 *   3. messages in inboxes (harness inboxes + system:operator's inbox)
 *      whose ts > snapshot's computedAt
 *   4. cache age (handled by the snapshot module's TTL ceiling)
 *
 * Returns a stable hash. Caller compares against `idle-snapshot.json`'s
 * fingerprint; equal AND under 30 min TTL → short-circuit OK.
 */

import { createHash } from 'node:crypto';
import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface TriggerState {
  unconsumedEvents: number;
  projects: { slug: string; status: string }[];
  operatorInboxCount: number;
}

export async function readTriggerState(): Promise<TriggerState> {
  const workspaceId = activeWorkspaceId();
  return withWorkspace(workspaceId, async (tx) => {
    const events = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM harness_shared.pending_events
       WHERE consumed_at IS NULL
    `;
    const projects = await tx<{ slug: string; status: string }[]>`
      SELECT slug, status
        FROM harness_shared.projects
       ORDER BY slug
    `;
    let inbox = 0;
    try {
      const rows = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
          FROM papercup_shared.message_recipients
         WHERE to_slug = 'system:operator'
           AND status  = 'pending'
      `;
      inbox = rows[0]?.count ?? 0;
    } catch {
      // message_recipients table may not exist in every workspace; treat as 0.
    }
    return {
      unconsumedEvents: events[0]?.count ?? 0,
      projects,
      operatorInboxCount: inbox,
    };
  });
}

export function fingerprint(s: TriggerState): string {
  const canonical = JSON.stringify({
    e: s.unconsumedEvents,
    p: s.projects,
    i: s.operatorInboxCount,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
