/**
 * GET /api/agent-mcp/operator-last-scan — last scan + audit-merged card status.
 * Ported from app/api/agent-mcp/operator-last-scan/route.ts. `auth: 'public'`.
 */
import { reconstructCards } from '../../../operator-card-reconstruction';
import { readLastScan } from '../../../operator-last-scan';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-last-scan',
  auth: 'public',
  async handler() {
    const last = await readLastScan();
    const reconstructed = await reconstructCards();
    if (!reconstructed.length) {
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
  },
});
