/**
 * GET /api/flags/stream → text/event-stream
 *
 * Wire format:
 *
 *   event: heartbeat
 *   data: {"tsMs": <Date.now()>}
 *
 *   event: flag_changed
 *   id: <monotonic>
 *   data: {"type":"flag_changed","key":"papercusp.snapshots","ts":1234567890}
 *
 *   event: flags_payload
 *   data: <full FlagPayload JSON>
 *
 * Clients should treat `flag_changed` as an invalidation: refetch
 * /api/flags/bootstrap. `flags_payload` is reserved for future use where
 * we push the full resolved payload server-side; clients should setPayload
 * when they see it.
 */
import { bridgeChannel, parseLastEventId, sseResponse } from '@restart/sse';

import { getFlagBus, type FlagChangeEnvelope } from '../../../../lib/flag-bus';

type FlagStreamVocabulary = {
  flag_changed: FlagChangeEnvelope;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 86_400;

export function GET(req: Request) {
  const lastEventId = parseLastEventId(req);
  const bus = getFlagBus();
  return sseResponse<FlagStreamVocabulary>({
    signal: req.signal,
    lastEventId,
    replay: () =>
      bus.recentSince(lastEventId ?? null).map(({ id, event }) => ({
        name: 'flag_changed',
        data: event,
        id,
      })),
    setup: async (sink) => {
      await bridgeChannel(bus.subscribe(), sink, ({ id, event }) => ({
        name: 'flag_changed',
        data: event,
        opts: { id },
      }));
    },
  });
}
