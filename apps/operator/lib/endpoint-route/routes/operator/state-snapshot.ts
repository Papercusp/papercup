/**
 * GET /api/operator/state-snapshot → text/event-stream
 *
 * SSE stream of state-channel snapshots for the active workspace
 * (chat:ask_choice card rendering).
 *
 * Ported from app/api/operator/state-snapshot/route.ts. `auth: 'public'` —
 * session-cookie check inline (preserves the 401 response shape).
 */
import { sseResponse } from '@restart/sse';
import {
  snapshotWorkspace,
  subscribeWorkspace,
  type VersionedSnapshot,
} from '@papercusp/agent-mcp';
import { getSessionUser } from '@/lib/auth';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { defineRoute } from '../../define-route';

interface StateSnapshotVocabulary {
  snapshot: VersionedSnapshot;
}

export default defineRoute({
  method: 'GET',
  path: '/operator/state-snapshot',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return new Response('unauthorized', { status: 401 });
    }
    const workspaceId = activeWorkspaceId();

    return sseResponse<StateSnapshotVocabulary>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        for (const vs of snapshotWorkspace(workspaceId)) {
          if (sink.closed) return;
          sink.event('snapshot', vs);
        }
        const off = subscribeWorkspace(workspaceId, (vs) => {
          if (sink.closed) return;
          sink.event('snapshot', vs);
        });
        sink.onClose(off);
      },
    });
  },
});
