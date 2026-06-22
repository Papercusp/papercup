/**
 * GET /api/zero-harness/sse → text/event-stream
 *
 * SSE push endpoint for the harness sync layer. Heartbeat + update +
 * invalidate events; Last-Event-ID replay from 60s ring buffer.
 *
 * ⚠ NOT RETIRED — despite the name, THIS ROUTE is the LIVE desktop sync transport
 * (apps/operator/providers/HarnessSyncProvider.tsx). The retired surface is the
 * defunct `libs/zero-harness` PACKAGE (the Zero ZQL schema), NOT this endpoint.
 * Don't conflate the two (agent-tool-delta-protocol-2026-06-22, Lane D / P-010).
 *
 * Ported from app/api/zero-harness/sse/route.ts. `auth: 'public'`.
 */
import { sseResponse, parseLastEventId, type SyncSseEventVocabulary } from '@papercusp/sse';
import { subscribe, backfillSince, type SyncEvent } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

function payloadFor(ev: SyncEvent): { name: string; args?: unknown; data?: unknown[] } {
  const out: { name: string; args?: unknown; data?: unknown[] } = { name: ev.name };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

export default defineTool({
  method: 'GET',
  path: '/zero-harness/sse',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // Pure sync-transport — exempt from route_invocations telemetry so the
  // table doesn't flood (plan Q7: sampleRate 0 for pure sync transports).
  sampleRate: 0,
  async handler(req) {
    const lastEventId = parseLastEventId(req);

    return sseResponse<SyncSseEventVocabulary>({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return backfillSince(lastEventId).map((ev) => ({
          name: ev.data !== undefined ? ('update' as const) : ('invalidate' as const),
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await subscribe((ev) => {
          if (sink.closed) return;
          const name = ev.data !== undefined ? 'update' : 'invalidate';
          sink.event(name, payloadFor(ev), { id: ev.id });
        });
        sink.onClose(handle.close);
      },
    });
  },
});
