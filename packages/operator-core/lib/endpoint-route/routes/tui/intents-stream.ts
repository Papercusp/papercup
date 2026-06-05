/**
 * GET /api/tui/intents/stream?client_id=X — SSE stream of pending intents for a
 * pui instance. The TUI analogue of /api/ui/intents/stream.
 *
 * Server-side 250ms poll of harness_shared.tui_intents (pui itself never polls —
 * it holds this one SSE connection and reacts to pushes, so the D-003 "no
 * polling in pui" invariant holds). `auth: 'public'` — loopback-gated inline.
 */
import { sseResponse } from '@papercusp/sse';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { defineTool } from '@papercusp/agent-mcp';

const POLL_MS = 250;

type Events = {
  message: { id: number; intent: string; args: Record<string, unknown> };
};

export default defineTool({
  method: 'GET',
  path: '/tui/intents/stream',
  auth: 'public',
  sampleRate: 0,
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const url = new URL(req.url);
    const clientId = (url.searchParams.get('client_id') ?? '').trim();
    if (!clientId) return Response.json({ error: 'client_id_required' }, { status: 400 });

    const { sql } = getOrgPg();

    return sseResponse<Events>({
      signal: req.signal,
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
              FROM harness_shared.tui_intents
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
            // eslint-disable-next-line no-console
            console.warn('[tui-intents] poll error', e);
          }
          if (!sink.closed) pollTimer = setTimeout(tick, POLL_MS);
        };

        pollTimer = setTimeout(tick, 0);
        sink.onClose(() => {
          if (pollTimer) clearTimeout(pollTimer);
        });
      },
    });
  },
});
