/**
 * GET /api/operator/state-snapshot → text/event-stream
 *
 * SSE stream of state-channel snapshots for the active workspace
 * (chat:ask_choice card rendering).
 *
 * Ported from app/api/operator/state-snapshot/route.ts. `auth: 'public'` —
 * session-cookie check inline (preserves the 401 response shape).
 */
import { sseResponse } from '@papercusp/sse';
import {
  snapshotWorkspace,
  subscribeWorkspace,
  type VersionedSnapshot,
} from '@papercusp/agent-mcp';
import { getSessionUser } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

type StateSnapshotVocabulary = {
  snapshot: VersionedSnapshot;
}

export default defineTool({
  method: 'GET',
  path: '/operator/state-snapshot',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
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
