/**
 * POST /api/deploy/:slug/vnc-session → { ok, ticket, wsUrl, mode, display }
 *
 * Mint a single-use frame-VNC session ticket
 * (`hive-frame-desktops-live-view-2026-06-06` P-008/P-009/P-010, D-002).
 * Body: { display: number, mode?: 'watch' | 'takeover' } — `watch` (default)
 * is read-only (`x11vnc -viewonly`); `takeover` hands the viewer the mouse +
 * keyboard and is audited as such. The returned wsUrl points at the operator's
 * loopback VNC bridge; noVNC connects there and the ticket is consumed once.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUser } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  createVncSession,
  startFrameVncWs,
  VNC_WS_PATH,
} from '../../../deployment/frame-vnc';

export default defineTool({
  method: 'POST',
  path: '/deploy/:slug/vnc-session',
  auth: 'public',
  async handler(req, ctx) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return new Response('unauthorized', { status: 401 });
    }
    const slug = ctx.params.slug as string;
    let body: { display?: unknown; mode?: unknown };
    try {
      body = (await req.json()) as { display?: unknown; mode?: unknown };
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const display = Number(body.display);
    if (!Number.isInteger(display) || display < 0 || display > 9999) {
      return Response.json({ ok: false, error: 'display must be a display number (e.g. 99)' }, { status: 400 });
    }
    const mode = body.mode === 'takeover' ? 'takeover' : 'watch';

    const port = await startFrameVncWs();
    if (!port) {
      return Response.json({ ok: false, error: 'vnc bridge failed to bind' }, { status: 503 });
    }
    try {
      const ticket = await createVncSession({
        slug,
        workspaceId: activeWorkspaceId(),
        display,
        mode,
        actor: `user:${(user as { email?: string; id?: string }).email ?? (user as { id?: string }).id ?? 'session'}`,
      });
      return Response.json({
        ok: true,
        ticket: ticket.ticket,
        wsUrl: `ws://127.0.0.1:${port}${VNC_WS_PATH}?ticket=${ticket.ticket}`,
        mode,
        display,
        slug,
      });
    } catch (e) {
      return Response.json(
        { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) },
        { status: 409 },
      );
    }
  },
});
