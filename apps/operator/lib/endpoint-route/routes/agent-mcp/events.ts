/**
 * GET /api/agent-mcp/events — SSE stream of pending_events for active workspace.
 * Ported from app/api/agent-mcp/events/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@restart/sse';
import { onPendingEventInserted } from '@/lib/pending-events-listener';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { defineRoute } from '../../define-route';

interface Events {
  hello: { workspaceId: string };
  pending_event: Record<string, unknown>;
}

export default defineRoute({
  method: 'GET',
  path: '/agent-mcp/events',
  auth: 'public',
  handler(req) {
    const ws = activeWorkspaceId();
    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 30_000,
      setup: (sink) => {
        sink.event('hello', { workspaceId: ws });
        const unsub = onPendingEventInserted((evt) => {
          if (evt.workspace_id !== ws) return;
          sink.event('pending_event', evt as unknown as Record<string, unknown>);
        });
        sink.onClose(unsub);
      },
    });
  },
});
