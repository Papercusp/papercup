/**
 * GET  /api/plugins/host/refresh — read-only host status.
 * POST /api/plugins/host/refresh — reset cached host state + re-discover.
 * Ported from app/api/plugins/host/refresh/route.ts. `auth: 'public'`.
 */
import {
  _resetPluginHostForTests,
  captureReloadStates,
  getPluginHost,
  pluginHostStatus,
} from '@/lib/plugin-host-runtime';
import { defineRoute } from '../../define-route';

const get = defineRoute({
  method: 'GET',
  path: '/plugins/host/refresh',
  auth: 'public',
  async handler() {
    await getPluginHost();
    return Response.json({ ok: true, status: await pluginHostStatus() });
  },
});

const post = defineRoute({
  method: 'POST',
  path: '/plugins/host/refresh',
  auth: 'public',
  async handler() {
    try {
      await captureReloadStates();
      _resetPluginHostForTests();
      await getPluginHost();
      return Response.json({ ok: true, status: await pluginHostStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[plugins/host/refresh] POST failed:', err);
      return Response.json({ ok: false, error: message, stack }, { status: 500 });
    }
  },
});

export default [get, post];
