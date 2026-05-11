/**
 * GET /api/plugins/host/events?plugin=&install=&name= — SSE event
 * stream for iframe plugin surfaces (Batch H4).
 *
 * Subscribes to one event name on the host's HookBus and re-fires
 * each occurrence as an SSE `data:` line. The PluginIframe bridge
 * wraps each line in an `event` envelope and posts it back into the
 * iframe.
 *
 * v1: payload is the JSON.stringified event arg. Audit row is emitted
 * server-side for each subscribe + each delivery (low cardinality —
 * iframe consumers are user-scoped).
 */
import { getPluginHost } from '@/lib/plugin-host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pluginName = url.searchParams.get('plugin');
  const installSlug = url.searchParams.get('install');
  const name = url.searchParams.get('name');
  if (!pluginName || !installSlug || !name) {
    return new Response('plugin, install, name query params required', { status: 400 });
  }

  const state = await getPluginHost();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown): void => {
        try {
          const line = `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(line));
        } catch { /* stream closed */ }
      };
      // Send a comment so the client sees the connection is open.
      controller.enqueue(encoder.encode(': ok\n\n'));
      // HookBus.registerAction(event, pluginName, handler) — pluginName
      // tags the registration so HookBus.unregisterPlugin can remove
      // it on disconnect. We use a stable per-stream pseudo-plugin
      // name so cancel() can drop just this stream's subscription.
      const subKey = `__iframe_sse_${pluginName}_${installSlug}_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      let active = true;
      state.bus.registerAction(name, subKey, (arg: unknown) => {
        if (!active) return;
        send(arg);
      });
      unsubscribe = () => {
        active = false;
        state.bus.unregisterPlugin(subKey);
      };
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
