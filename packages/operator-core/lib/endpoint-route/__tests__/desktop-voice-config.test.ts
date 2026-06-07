/**
 * /api/desktop/voice-config (holepunch-voice-channels P-015, D-014 item 3) —
 * the webview's deterministic discovery of the desktop voice bridge port.
 * Drives the DB-free handler directly; the bridge's chosen-port state is
 * simulated through its globalThis pin (the same state a started bridge sets).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RouteDefinition } from '../define-route';
import desktopVoiceConfig from '../routes/desktop/voice-config';

type DvGlobals = typeof globalThis & {
  __papercuspDesktopVoiceWs?: { started: boolean; chosenPort: number | null; wss: unknown };
};

function routeByMethod(method: string): RouteDefinition<never> {
  const def = (desktopVoiceConfig as RouteDefinition<never>[]).find(
    (r) => r.method === method && r.path === '/desktop/voice-config',
  );
  if (!def) throw new Error(`no ${method} /desktop/voice-config`);
  return def;
}

// The bridge module pins its state object on globalThis at import time and
// reads through that SAME object — so simulate a bound bridge by MUTATING it
// (replacing the global would leave the module reading its captured copy).
const g = globalThis as DvGlobals;
function bridgeState() {
  const s = g.__papercuspDesktopVoiceWs;
  if (!s) throw new Error('desktop-voice-ws state not pinned — module import order changed?');
  return s;
}

afterEach(() => {
  bridgeState().chosenPort = null;
});

describe('GET /desktop/voice-config', () => {
  it('returns the bridge port + path + the channel audio constants', async () => {
    bridgeState().chosenPort = 3079;
    const res = await routeByMethod('GET').handler(
      new Request('http://x.test/api/desktop/voice-config'),
      undefined as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      port: number | null;
      path: string;
      sampleRate: number;
      frameSamples: number;
    };
    expect(body.port).toBe(3079);
    expect(body.path).toBe('/api/desktop/voice');
    expect(body.sampleRate).toBe(48_000);
    expect(body.frameSamples).toBe(960);
  });

  it('returns port:null before the bridge has bound (client falls back to default)', async () => {
    bridgeState().chosenPort = null;
    const res = await routeByMethod('GET').handler(
      new Request('http://x.test/api/desktop/voice-config'),
      undefined as never,
    );
    const body = (await res.json()) as { port: number | null };
    expect(body.port).toBeNull();
  });

  it('answers OPTIONS preflight with CORS headers', async () => {
    const res = await routeByMethod('OPTIONS').handler(
      new Request('http://x.test/api/desktop/voice-config', { method: 'OPTIONS' }),
      undefined as never,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
