/**
 * SSE push endpoint for the harness sync layer (Level 1 + Phase 1).
 *
 * GET /api/zero-harness/sse  →  text/event-stream
 *
 * Wire format (STABILITY CONTRACT — see libs/sse/README.md):
 *
 *   event: heartbeat       (every 15s; resets the client zombie watchdog)
 *   data: {"tsMs": <Date.now()>}
 *
 *   event: update          (push with full payload; client setQueryData)
 *   id: <monotonic>
 *   data: {"name":"...","args":{...},"data":[...rows...]}
 *
 *   event: invalidate      (push without payload; client refetches via REST)
 *   id: <monotonic>
 *   data: {"name":"...","args":{...}}
 *
 * Reconnects send `Last-Event-ID` header; we replay events with id >
 * Last-Event-ID from the 60s ring buffer in lib/sync-sse.
 *
 * Migrated to @restart/sse 2026-05-11 — boilerplate (ReadableStream + heartbeat
 * + cancel + headers) now comes from sseResponse(). The PG bridge layer in
 * lib/sync-sse stays unchanged (60s time-based history + payload-size limit +
 * source-side dedup are not yet generic enough to live in @restart/sse).
 *
 * The wire-format snapshot test in libs/sse/src/wire-format-snapshot.test.ts
 * pins the byte-exact output against the desktop client's expectations.
 */
import { sseResponse, parseLastEventId, SYNC_MAX_DURATION_SEC, type SyncSseEventVocabulary } from '@restart/sse';
import { subscribe, backfillSince, type SyncEvent } from '../../../../lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = SYNC_MAX_DURATION_SEC;

function payloadFor(ev: SyncEvent): { name: string; args?: unknown; data?: unknown[] } {
  const out: { name: string; args?: unknown; data?: unknown[] } = { name: ev.name };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

export async function GET(req: Request): Promise<Response> {
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
}
