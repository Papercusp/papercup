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

function payloadFor(ev: SyncEvent): {
  name: string;
  args?: unknown;
  data?: unknown[];
  tsMs: number;
} {
  const out: { name: string; args?: unknown; data?: unknown[]; tsMs: number } = {
    name: ev.name,
    tsMs: ev.ts,
  };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

/**
 * Query param carrying the client's declared interest set: the query names it
 * is currently observing, comma-separated (`?queries=plans.items,work.items`).
 */
export const INTEREST_PARAM = 'queries';

/**
 * Refuse to build a filter from an implausibly large declaration rather than
 * truncating one. Truncating would silently starve whichever names fell off
 * the end — the exact failure D-002 exists to prevent — so an over-cap
 * declaration falls back to no filter, which is merely today's behaviour.
 */
export const MAX_DECLARED_QUERY_NAMES = 500;

/**
 * Parse a client interest declaration into a name-membership predicate.
 *
 * Returns `undefined` — meaning NO filtering, i.e. exactly today's full
 * fan-out — for every ambiguous input, per D-002. The cases that matter:
 *
 *   - param absent          -> undefined. An un-upgraded client, or one
 *                              mid-handshake, is never degraded.
 *   - param present but the
 *     parsed set is EMPTY   -> undefined, NOT "send nothing". This is the
 *                              single most dangerous misreading available
 *                              here: read as an empty allow-list it would
 *                              silently starve the client completely, and the
 *                              symptom (a UI that never updates) looks like a
 *                              dead connection rather than a filter bug.
 *   - more than the cap     -> undefined (see MAX_DECLARED_QUERY_NAMES).
 *   - malformed URL / throw -> undefined.
 *
 * A client that genuinely wants nothing simply does not open the stream.
 */
export function interestFilterFor(url: string): ((e: SyncEvent) => boolean) | undefined {
  let raw: string | null;
  try {
    raw = new URL(url).searchParams.get(INTEREST_PARAM);
  } catch {
    return undefined; // unparseable URL -> unfiltered, never starved
  }
  if (raw === null) return undefined;

  const names = new Set(
    raw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0),
  );
  if (names.size === 0 || names.size > MAX_DECLARED_QUERY_NAMES) return undefined;

  return (ev: SyncEvent) => names.has(ev.name);
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
    const filter = interestFilterFor(req.url);

    return sseResponse<SyncSseEventVocabulary>({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      // NOTE: replay is deliberately NOT filtered. Sending a reconnecting
      // client more than it asked for is safe; sending it less is the silent
      // staleness this whole change is built to avoid, and the reconnect path
      // is exactly where a stale interest set is most likely (the client
      // reconnects precisely because its view just changed). Narrowing replay
      // is a separate, later decision with its own evidence.
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return backfillSince(lastEventId).map((ev) => ({
          name: ev.data !== undefined ? ('update' as const) : ('invalidate' as const),
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await subscribe(
          (ev) => {
            if (sink.closed) return;
            const name = ev.data !== undefined ? 'update' : 'invalidate';
            sink.event(name, payloadFor(ev), { id: ev.id });
          },
          filter ? { filter } : undefined,
        );
        sink.onClose(handle.close);
      },
    });
  },
});
