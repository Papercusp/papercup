/**
 * /api/operator/sentinel-output — Phase D voice-OUT relay for the
 * Sentinel-as-Claude-TUI (sentinel-as-claude-tui-2026-06-22).
 *
 *   POST { text }  — alt voice-out emitter (e.g. a launch hook) posts a spoken
 *                    line. The PRIMARY path is the `voice:say` MCP tool, which
 *                    the Sentinel calls to push straight into the buffer.
 *   GET            — the webview voice runtime drains buffered spoken lines and
 *                    calls speak()/TTS (it polls while voice is active).
 *
 * LOCAL APP USER ONLY (owner constraint): the local STT/TTS pipeline ↔ the
 * Claude-TUI pane, NOT the P2P voice-channel system. `auth: 'loopback'`.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { pushSentinelSay, drainSentinelSays } from '../../../sentinel-output-buffer';

const post = defineTool({
  method: 'POST',
  path: '/operator/sentinel-output',
  auth: 'loopback',
  async handler(req) {
    // CSRF guard (matches sentinel-input): loopback admits the cookie-less
    // webview + the local Stop hook (no Origin → allowed), but a foreign
    // cross-origin browser page is refused so it can't inject spoken lines.
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) return Response.json({ error: 'text required' }, { status: 400 });
    pushSentinelSay(text);
    return Response.json({ ok: true });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/operator/sentinel-output',
  auth: 'loopback',
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    return Response.json({ says: drainSentinelSays() });
  },
});

export default [post, get];
