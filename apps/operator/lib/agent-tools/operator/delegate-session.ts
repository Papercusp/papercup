/**
 * Shared session-resolution for operator:delegate. Both the Hono route
 * (so it can set ctx.runId/spawnId = agentSessionId, preserving the
 * /dev → Sessions audit-grouping behavior from the pre-migration shape)
 * and the tool handler (so IPC dispatches that bypass the route still
 * resolve sessions correctly) call this helper.
 *
 * Why a shared helper: if the route generates UUID for new sessions
 * and passes it to the tool, but the tool also generates its own UUID
 * internally, the audit-log run_id/spawn_id will diverge from the
 * agentSessionId emitted in the `session` event. Both must agree.
 */

import { randomUUID } from 'node:crypto';
import { getDelegate } from '@/lib/delegates';

export interface ResolvedDelegateSession {
  agentSessionId: string;
  sessionCreated: boolean;
}

export async function resolveDelegateSession(
  workspaceId: string,
  requestedSessionId: string | undefined,
  forceNew: boolean,
): Promise<ResolvedDelegateSession> {
  if (forceNew || !requestedSessionId) {
    return { agentSessionId: randomUUID(), sessionCreated: true };
  }
  const existing = await getDelegate(workspaceId, requestedSessionId).catch(() => null);
  if (existing && existing.status === 'open') {
    return { agentSessionId: existing.agentSessionId, sessionCreated: false };
  }
  return { agentSessionId: randomUUID(), sessionCreated: true };
}
