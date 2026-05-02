/**
 * GET /api/agent-mcp/operator-ack-latency
 *
 * Returns the per-harness adaptive "unconsumed" thresholds, plus the
 * fallback ms value for harnesses without enough samples. The panel
 * uses these to colour the unconsumed glyph more accurately than the
 * static 4-min default.
 */

import { computeAckLatencyTable } from '@/lib/operator-ack-latency';

export const dynamic = 'force-dynamic';

export async function GET() {
  const table = await computeAckLatencyTable();
  return Response.json(table);
}
