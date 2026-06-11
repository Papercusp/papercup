/**
 * /api/user/preferences — load/save/clear-key for the session user's
 * preference blob.
 *
 * Ported from app/api/user/preferences/route.ts. `auth: 'public'` —
 * the route uses session-cookie auth via getSessionUser(req.headers)
 * and returns 401 if absent (faithful port; could move to a cookie
 * principal in a separate auth-tightening pass).
 */
import { getSessionUser } from '../../../auth';
import { loadUserPreferences, saveUserPreferences, clearUserPreferenceKey } from '../../../user-preferences';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/user/preferences',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const payload = await loadUserPreferences(user.id);
    return Response.json({ payload });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/user/preferences',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    const payload = await saveUserPreferences(user.id, body as Record<string, unknown>);
    return Response.json({ payload });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/user/preferences',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (!key) return Response.json({ error: 'key_required' }, { status: 400 });
    await clearUserPreferenceKey(user.id, key);
    return Response.json({ ok: true });
  },
});

export default [get, patch, del];
