/**
 * POST /api/operator/papercup-input  { text: string }
 *
 * Voice-IN for the Sentinel-as-Claude-TUI (sentinel-as-claude-tui-2026-06-22,
 * Phase C). Writes a final STT transcript into the dock's 🛡 Sentinel pane's
 * stdin so the local user can talk to the Sentinel (a `psu --role=sentinel`
 * Claude-Code session) by voice.
 *
 * The pane-write mechanics (registration targeting, warm-up gate, exited-pane
 * guard) live in ../../../sentinel/sentinel-pane-input.ts, shared with the
 * in-process callers (the operator voice host's EL-utterance relay + the
 * deep-delegation answer injection — voice-unified-sentinel-pipeline-2026-07-01
 * D-001: the pane is the ONE brain, so every input path converges here).
 *
 * LOCAL APP USER ONLY (owner constraint, 2026-06-22): this is the local
 * STT→pane pipeline, NOT the P2P voice-channel system. `auth: 'loopback'` — only
 * the local webview reaches it.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { writeToSentinelPane, isExitedPaneScreen } from '../../../sentinel/sentinel-pane-input';

// Re-exported so existing consumers/tests of the route module keep working.
export { isExitedPaneScreen };

interface Body {
  text?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/operator/papercup-input',
  auth: 'loopback',
  async handler(req) {
    // CSRF guard: `auth: 'loopback'` admits the cookie-less webview, so it no
    // longer blocks a foreign browser page from POSTing to 127.0.0.1. This
    // endpoint types straight into the Sentinel's Claude-Code TUI stdin (an
    // RCE-adjacent sink), so a cross-origin write MUST be refused. Origin-based
    // (a browser always stamps it on a cross-origin request; JS can't forge it).
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    const body = (await req.json().catch(() => null)) as Body | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });

    const res = await writeToSentinelPane(text);
    if (res.ok) {
      return Response.json({ ok: true, session: res.session, paneId: res.paneId, targeted: res.targeted });
    }
    switch (res.reason) {
      case 'no-dock':
        return Response.json({ error: res.error }, { status: 503 });
      case 'pane-exited':
        return Response.json(
          { error: res.error, exited: true, session: res.session, paneId: res.paneId },
          { status: 409 },
        );
      default:
        return Response.json({ error: res.error }, { status: 500 });
    }
  },
});
