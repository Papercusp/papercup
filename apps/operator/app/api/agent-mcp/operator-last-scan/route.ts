/**
 * GET /api/agent-mcp/operator-last-scan — return the most-recent scan
 * snapshot for hydration when the user reopens the panel.
 */

import { readLastScan } from '@/lib/operator-last-scan';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snap = readLastScan();
  if (!snap) return Response.json({ snapshot: null });
  return Response.json({ snapshot: snap });
}
