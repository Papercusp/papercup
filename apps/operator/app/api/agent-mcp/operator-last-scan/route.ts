/**
 * GET /api/agent-mcp/operator-last-scan
 *
 * Returns the most-recent scan snapshot, MERGED with audit_log lifecycle
 * events + dismissed-cooldown so the panel reconstructs cards in their
 * actual current state (dispatched / dismissed / consumed / …) rather
 * than always 'pending'.
 *
 * Response shape:
 *   { snapshot: { cards: [{ ...payload, _status, _dispatchedAt, _ackedAt }] } }
 *
 * The `_`-prefixed fields are post-merge metadata; the panel reads them
 * to set initial card state on hydration.
 */

import { reconstructCards } from '@/lib/operator-card-reconstruction';
import { readLastScan } from '@/lib/operator-last-scan';

export const dynamic = 'force-dynamic';

export async function GET() {
  const last = await readLastScan();
  const reconstructed = await reconstructCards();
  if (!reconstructed.length) {
    // No reconstruction possible (no scan + no audit) — return an empty
    // snapshot so the panel renders cleanly.
    return Response.json({ snapshot: last ? { cards: last.cards, scanCompletedAt: last.scanCompletedAt } : null });
  }
  return Response.json({
    snapshot: {
      cards: reconstructed.map((c) => ({
        ...c.payload,
        _status: c.status,
        _dispatchedAt: c.dispatchedAt,
        _ackedAt: c.ackedAt,
        _undoCancelled: c.undoCancelled,
      })),
      scanCompletedAt: last?.scanCompletedAt ?? null,
    },
  });
}
