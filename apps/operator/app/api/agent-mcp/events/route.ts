/**
 * GET /api/agent-mcp/events
 *
 * SSE stream of pending_events_inserted notifications, filtered to the
 * active workspace. Used by the Operator panel to drive auto-rescan
 * triggers and icon-state transitions.
 */

import { NextRequest } from 'next/server';
import { sseResponse, SYNC_MAX_DURATION_SEC } from '@restart/sse';
import { onPendingEventInserted } from '@/lib/pending-events-listener';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = SYNC_MAX_DURATION_SEC;

interface Events {
  hello: { workspaceId: string };
  pending_event: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
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
}
