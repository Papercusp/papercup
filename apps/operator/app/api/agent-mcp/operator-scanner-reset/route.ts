/**
 * POST /api/agent-mcp/operator-scanner-reset
 *
 * Wipes the workspace's persistent scanner session so the next scan
 * starts a fresh Claude conversation. Useful after major workspace
 * shifts (new harness scaffolded, big directive batch dispatched,
 * scanner started looping on stale context).
 *
 * Phase 3 only matters when OPERATOR_SCANNER_RESUME=1 is set; this
 * endpoint stays available either way so the user can pre-emptively
 * clear a session that might exist from a prior Phase 3 run.
 */
import { resetScannerSession, isScannerResumeEnabled } from '@/lib/operator-scanner-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  await resetScannerSession();
  return Response.json({
    ok: true,
    enabled: isScannerResumeEnabled(),
    note: isScannerResumeEnabled()
      ? 'Scanner session cleared. Next scan starts fresh.'
      : 'Scanner-resume is disabled (set OPERATOR_SCANNER_RESUME=1 to enable). Reset is a no-op until then.',
  });
}
