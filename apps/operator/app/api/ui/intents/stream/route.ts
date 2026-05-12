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
import { sseResponse } from '@restart/sse';
import { getOrgPg } from '@restart/db-org';
import { isLoopbackRequest } from '@/lib/superuser-token';
import { ensureUiIntentsTable } from '@/lib/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// maxDuration must be a literal — Next's segment-config parser can't
// resolve imported constants (SYNC_MAX_DURATION_SEC = 86_400 in @restart/sse).
export const maxDuration = 86_400;

const POLL_MS = 250;

interface Events {
  message: { id: number; intent: string; args: Record<string, unknown> };
}

export async function GET(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }
  const url = new URL(req.url);
  const clientId = (url.searchParams.get('client_id') ?? '').trim();
  if (!clientId) return NextResponse.json({ error: 'client_id_required' }, { status: 400 });

  await ensureUiIntentsTable();
  const { sql } = getOrgPg();

  return sseResponse<Events>({
    signal: req.signal,
    // 15s heartbeat matches the prior HEARTBEAT_MS.
    heartbeatMs: 15_000,
    initialHeartbeat: true,
    setup: (sink) => {
      let lastId = 0;
      let pollTimer: NodeJS.Timeout | null = null;

      const tick = async () => {
        if (sink.closed) return;
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
            const rid = Number(row.id);
            sink.event('message', { id: rid, intent: row.intent, args: row.args });
            lastId = Math.max(lastId, rid);
          }
        } catch (e) {
          // Don't kill the stream on a single PG hiccup — log + retry.
          // eslint-disable-next-line no-console
          console.warn('[ui-intents] poll error', e);
        }
        if (!sink.closed) pollTimer = setTimeout(tick, POLL_MS);
      };

      pollTimer = setTimeout(tick, 0);
      sink.onClose(() => {
        if (pollTimer) clearTimeout(pollTimer);
      });
    },
  });
}
