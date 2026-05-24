/**
 * /api/adv/sessions/* — read + control routes for the /adv/sessions
 * UI. Backed by harness_shared.adv_sessions (migration 079).
 *
 *   GET /api/adv/sessions                 → list rows
 *   POST /api/adv/sessions/focus           → bring a window to front
 *   GET /api/adv/sessions/alive?pid=N      → is the pid still alive?
 *
 * Public endpoints — operator binds loopback-only. Mirrors the
 * /api/admin/* pattern (no extra principal gate at the route layer).
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  focusWindowId,
  listAdvSessions,
  resolveWindowIdForPid,
} from '@/lib/adv-sessions';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const list = defineTool({
  method: 'GET',
  path: '/adv/sessions',
  auth: 'public',
  async handler() {
    const rows = await listAdvSessions(200);
    return new Response(JSON.stringify({ rows }), { status: 200, headers: JSON_HEADERS });
  },
});

const focus = defineTool({
  method: 'POST',
  path: '/adv/sessions/focus',
  auth: 'public',
  async handler(req) {
    let body: { pid?: number; windowId?: string | null } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore */ }

    let wid = body.windowId ?? null;
    if (!wid && typeof body.pid === 'number') {
      wid = await resolveWindowIdForPid(body.pid);
    }
    if (!wid) {
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'could not resolve a window id (wmctrl missing, no DISPLAY, or pid has no window)',
        }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    const ok = await focusWindowId(wid);
    return new Response(
      JSON.stringify({ status: ok ? 'ok' : 'error', windowId: wid }),
      { status: ok ? 200 : 500, headers: JSON_HEADERS },
    );
  },
});

const alive = defineTool({
  method: 'GET',
  path: '/adv/sessions/alive',
  auth: 'public',
  async handler(req) {
    const pidStr = new URL(req.url).searchParams.get('pid');
    const pid = pidStr ? Number(pidStr) : NaN;
    if (!Number.isFinite(pid) || pid <= 0) {
      return new Response(JSON.stringify({ alive: false }), { status: 200, headers: JSON_HEADERS });
    }
    let live = false;
    try {
      // process.kill(pid, 0) throws if the pid is gone; succeeds (and
      // sends no signal) if alive + we have permission.
      process.kill(pid, 0);
      live = true;
    } catch { live = false; }
    return new Response(JSON.stringify({ alive: live }), { status: 200, headers: JSON_HEADERS });
  },
});

export default [list, focus, alive];
