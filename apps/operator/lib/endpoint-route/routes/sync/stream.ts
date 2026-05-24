/**
 * GET /api/sync/stream → text/event-stream
 *
 * Dogfood reactivity SSE endpoint. Bridges the `papercusp_changes` PG
 * channel (producer: trigger function in migration 078, attached via
 * `wireDogfoodTriggers()` in ensure-schema-dogfood.ts) to the browser's
 * libs/sync SSEAdapter.
 *
 * Per papercusp-dogfood-v5 Phase 3 P-020.
 *
 * Contract (matches libs/sync SSEAdapter expectations):
 *   event: invalidate
 *   data: { name: "<table>", tsMs: <number> }
 *
 *   event: heartbeat
 *   data: { tsMs: <number> }
 *
 * Query params:
 *   ?workspace=<id>  Restrict to events from this workspace. If absent,
 *                    the connection receives all events (admin / cross-
 *                    workspace views).
 *
 * Reconnect-replay: honors `Last-Event-ID` header; replays from the
 * per-process ring buffer (60s window, max 10k events) for events with
 * id > Last-Event-ID, respecting the workspace filter.
 *
 * Auth: public (sync transport; per-event filtering already happens
 * via workspace param + table-name; no row content in the payload).
 * Sibling pattern to /api/zero-harness/sse — same `sampleRate: 0` to
 * keep route_invocations clean.
 */
import { sseResponse, parseLastEventId, type SyncSseEventVocabulary } from '@restart/sse';
import { defineTool } from '@papercusp/agent-mcp';
import {
  subscribe,
  backfillSince,
  type ChangeEvent,
} from '@/lib/papercusp-changes-listener';

/**
 * Map a PG `papercusp_changes` payload into the SSE invalidate payload
 * the browser expects. The `name` is the unqualified table name (we
 * strip the `harness_shared.` prefix) — that's what useSyncQuery keys
 * its queries against on the client side. The PG `op` (INSERT/UPDATE/
 * DELETE) rides in `args.op` per the SyncSseEventVocabulary's
 * `invalidate: { name, args?, tsMs? }` shape.
 */
function unqualified(table: string): string {
  const dot = table.indexOf('.');
  return dot >= 0 ? table.slice(dot + 1) : table;
}

function payloadFor(ev: ChangeEvent): { name: string; args: { op: string }; tsMs: number } {
  return { name: unqualified(ev.table), args: { op: ev.op }, tsMs: ev.ts };
}

export default defineTool({
  method: 'GET',
  path: '/sync/stream',
  auth: 'public',
  // Pure sync-transport — exempt from route_invocations telemetry (v5
  // matches zero-harness/sse pattern).
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspace');
    const lastEventId = parseLastEventId(req);

    return sseResponse<SyncSseEventVocabulary>({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return backfillSince(lastEventId, workspaceId).map((ev) => ({
          name: 'invalidate' as const,
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await subscribe(workspaceId, (ev) => {
          if (sink.closed) return;
          sink.event('invalidate', payloadFor(ev), { id: ev.id });
        });
        sink.onClose(handle.close);
      },
    });
  },
});
