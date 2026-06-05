/**
 * GET /api/plugins/host/events — SSE event stream for iframe plugin surfaces.
 * Ported from app/api/plugins/host/events/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@papercusp/sse';
import { getPluginHost } from '../../../plugin-host-runtime';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/host/events',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const pluginName = url.searchParams.get('plugin');
    const installSlug = url.searchParams.get('install');
    const name = url.searchParams.get('name');
    if (!pluginName || !installSlug || !name) {
      return new Response('plugin, install, name query params required', { status: 400 });
    }

    const state = await getPluginHost();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 30_000,
      initialHeartbeat: true,
      setup: (sink) => {
        const subKey = `__iframe_sse_${pluginName}_${installSlug}_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        let active = true;
        state.bus.registerAction(name, subKey, (arg: unknown) => {
          if (!active || sink.closed) return;
          const payload = typeof arg === 'string' ? arg : JSON.stringify(arg);
          sink.eventRaw('message', payload);
        });
        sink.onClose(() => {
          active = false;
          state.bus.unregisterPlugin(subKey);
        });
      },
    });
  },
});
