/**
 * SSE push endpoint for the harness sync layer (Level 1 + Phase 1).
 *
 * GET /api/zero-harness/sse  →  text/event-stream
 *
 *   event: heartbeat       (every 15s; resets the client zombie watchdog)
 *   data: {"tsMs": <Date.now()>}
 *
 *   event: update          (push with full payload; client setQueryData)
 *   id: <monotonic>
 *   data: {"name": "...", "args": {...}, "data": [...rows...]}
 *
 *   event: invalidate      (push without payload; client refetches via REST)
 *   id: <monotonic>
 *   data: {"name": "...", "args": {...}}
 *
 * Reconnects send `Last-Event-ID` header; we replay any events with id >
 * Last-Event-ID from the in-memory ring buffer (60s window).
 *
 * Backed by `lib/sync-sse.ts` which holds the dedicated PG LISTEN client +
 * ring buffer + subscriber set.
 */
import { subscribe, backfillSince, type SyncEvent } from '../../../../lib/sync-sse';

const HEARTBEAT_INTERVAL_MS = 15_000;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

  const encoder = new TextEncoder();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller closed; cleanup will handle */
        }
      };

      const sendEvent = (ev: SyncEvent) => {
        const eventName = ev.data !== undefined ? 'update' : 'invalidate';
        const payload: Record<string, unknown> = { name: ev.name };
        if (ev.args !== undefined) payload.args = ev.args;
        if (ev.data !== undefined) payload.data = ev.data;
        send(`id: ${ev.id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      // Backfill any events the client missed during disconnect.
      if (lastEventId > 0) {
        for (const ev of backfillSince(lastEventId)) {
          sendEvent(ev);
        }
      }

      // Open subscription.
      const handle = await subscribe(sendEvent);
      unsubscribe = handle.close;

      // Initial heartbeat to confirm the stream is live.
      send(`event: heartbeat\ndata: ${JSON.stringify({ tsMs: Date.now() })}\n\n`);

      heartbeatTimer = setInterval(() => {
        send(`event: heartbeat\ndata: ${JSON.stringify({ tsMs: Date.now() })}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cancelled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
