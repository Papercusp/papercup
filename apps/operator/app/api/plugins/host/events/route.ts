/**
 * GET /api/plugins/host/events?plugin=&install=&name= — SSE event
 * stream for iframe plugin surfaces (Batch H4).
 *
 * Subscribes to one event name on the host's HookBus and re-fires
 * each occurrence as an SSE `data:` line. The PluginIframe bridge
 * wraps each line in an `event` envelope and posts it back into the
 * iframe.
 *
 * v1: payload is either the raw string OR JSON.stringify of an object —
 * preserved exactly for backward compatibility with PluginIframe's
 * consumer-side parser (which has the same conditional).
 */
import { sseResponse, SYNC_MAX_DURATION_SEC } from '@restart/sse';
import { getPluginHost } from '@/lib/plugin-host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = SYNC_MAX_DURATION_SEC;

export async function GET(req: Request): Promise<Response> {
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
    // Heartbeats every 30s; matches the prior 30s : keepalive comment.
    heartbeatMs: 30_000,
    // The initial heartbeat replaces the old ': ok\n\n' liveness ping.
    initialHeartbeat: true,
    setup: (sink) => {
      // HookBus.registerAction tags the registration so we can unregister
      // exactly this stream's subscription on close.
      const subKey = `__iframe_sse_${pluginName}_${installSlug}_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let active = true;
      state.bus.registerAction(name, subKey, (arg: unknown) => {
        if (!active || sink.closed) return;
        // Preserve the prior behavior: raw string passthrough, otherwise JSON.
        const payload = typeof arg === 'string' ? arg : JSON.stringify(arg);
        sink.eventRaw('message', payload);
      });
      sink.onClose(() => {
        active = false;
        state.bus.unregisterPlugin(subKey);
      });
    },
  });
}
