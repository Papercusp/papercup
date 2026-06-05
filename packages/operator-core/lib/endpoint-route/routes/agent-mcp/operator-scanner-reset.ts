/**
 * POST /api/agent-mcp/operator-scanner-reset — wipe persistent scanner session.
 * Ported from app/api/agent-mcp/operator-scanner-reset/route.ts. `auth: 'public'`.
 */
import { resetScannerSession, isScannerResumeEnabled } from '../../../operator-scanner-session';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-scanner-reset',
  auth: 'public',
  async handler() {
    await resetScannerSession();
    return Response.json({
      ok: true,
      enabled: isScannerResumeEnabled(),
      note: isScannerResumeEnabled()
        ? 'Scanner session cleared. Next scan starts fresh.'
        : 'Scanner-resume is disabled (set OPERATOR_SCANNER_RESUME=1 to enable). Reset is a no-op until then.',
    });
  },
});
