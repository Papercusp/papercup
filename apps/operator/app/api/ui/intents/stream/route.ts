/**
 * GET /api/ui/intents/stream?client_id=X
 *
 * SSE stream of pending intents for a specific browser tab. Each
 * message is a JSON object `{ id, intent, args }` — the dispatcher
 * runs the named handler and POSTs to /result.
 *
 * The implementation polls harness_shared.ui_intents every 250ms for
 * pending rows. We considered LISTEN/NOTIFY for push semantics, but
 * 250ms-poll keeps the route stateless across reloads, doesn't pin a
 * PG connection per tab, and is bounded by the partial index on
 * (client_id, id) WHERE status='pending' — vanishingly cheap.
 *
 * Loopback-only.
 */

import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { isLoopbackRequest } from '@/lib/superuser-token';
import { ensureUiIntentsTable } from '@/lib/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }
  const url = new URL(req.url);
  const clientId = (url.searchParams.get('client_id') ?? '').trim();
  if (!clientId) return NextResponse.json({ error: 'client_id_required' }, { status: 400 });

  await ensureUiIntentsTable();
  const { sql } = getOrgPg();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastId = 0;
      let pollTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const send = (data: object) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };
      const sendComment = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ${text}\n\n`)); } catch { closed = true; }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const rows = await sql<Array<{ id: number; intent: string; args: Record<string, unknown> }>>`
            SELECT id, intent, args
            FROM harness_shared.ui_intents
            WHERE client_id = ${clientId}
              AND status = 'pending'
              AND id > ${lastId}
            ORDER BY id ASC
            LIMIT 50
          `;
          for (const row of rows) {
            send({ id: Number(row.id), intent: row.intent, args: row.args });
            lastId = Math.max(lastId, Number(row.id));
          }
        } catch (e) {
          // Don't kill the stream on a single PG hiccup — log + retry.
          // eslint-disable-next-line no-console
          console.warn('[ui-intents] poll error', e);
        }
        if (!closed) pollTimer = setTimeout(tick, POLL_MS);
      };

      sendComment('connected');
      pollTimer = setTimeout(tick, 0);
      heartbeatTimer = setInterval(() => sendComment('ping'), HEARTBEAT_MS);

      const abort = () => {
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* ignore */ }
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
