/**
 * GET /api/agent-mcp/events
 *
 * SSE stream of pending_events_inserted notifications, filtered to the
 * active workspace. Used by the Operator panel to drive auto-rescan
 * triggers and icon-state transitions.
 */

import { NextRequest } from 'next/server';
import { onPendingEventInserted } from '@/lib/pending-events-listener';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const ws = activeWorkspaceId();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client disconnected */
        }
      };

      send('hello', { workspaceId: ws });

      const unsub = onPendingEventInserted((evt) => {
        if (evt.workspace_id !== ws) return;
        send('pending_event', evt as unknown as Record<string, unknown>);
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`));
        } catch {
          /* ignore */
        }
      }, 30000);

      // The route returns when the controller closes; we tear down on the
      // request signal but Next 15 doesn't reliably surface it for
      // ReadableStream-based SSE. The interval + handler tear down on next
      // GC; on hot reload they're cleaned up by module reload.
      void Promise.resolve().then(() => {
        // no-op; placeholder for future signal-based teardown
      });
      // store cleanup for the signal-based path:
      (controller as any)._cleanup = () => {
        clearInterval(heartbeat);
        unsub();
      };
    },
    cancel() {
      const c = (this as any)._cleanup as (() => void) | undefined;
      c?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}
