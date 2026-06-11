/**
 * /api/user/preferences — load/save/clear-key for the session user's
 * preference blob.
 *
 * Ported from app/api/user/preferences/route.ts. `auth: 'public'` —
 * session-cookie auth with the seeded-`default`-user fallback
 * (getSessionUserOrDefault — the per-user-data semantics its docstring
 * names for "memory, preferences"; single-user desktop webviews carry
 * no session cookie).
 */
import { getSessionUserOrDefault } from '../../../auth';
import { loadUserPreferences, saveUserPreferences, clearUserPreferenceKey } from '../../../user-preferences';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/user/preferences',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
    const payload = await loadUserPreferences(user.id);
    return Response.json({ payload });
  },
});

const patch = defineTool({
  method: 'PATCH',
  path: '/user/preferences',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUserOrDefault(req.headers);
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
    const user = await getSessionUserOrDefault(req.headers);
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (!key) return Response.json({ error: 'key_required' }, { status: 400 });
    await clearUserPreferenceKey(user.id, key);
    return Response.json({ ok: true });
  },
});

export default [get, patch, del];
