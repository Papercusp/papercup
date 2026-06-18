// @vitest-environment node
/**
 * Integration tests for the mobile voice WS server (`device-voice-ws.ts`):
 * the real `ws` WebSocketServer binding a real port, a real `ws` client doing
 * the handshake, and the EADDRINUSE port-fallback walk. The per-connection
 * protocol is unit-tested in device-voice-ws.test.ts; here we prove the
 * transport actually listens, authenticates, round-trips, and survives a busy
 * base port. `dispatchTranscript` is mocked so no PG/HTTP is touched.
 *
 * device-voice-ws reads BASE_PORT from MOBILE_VOICE_WS_PORT at import time, so
 * the module is imported dynamically AFTER the env is set (a static import is
 * hoisted above the env assignment and would bind the wrong port).
 *
 * P-001 of plan voice-production-test-coverage-2026-06-01.
 */
import { once } from 'node:events';
import net from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Typed to dispatchTranscript's real 4-arg signature so `.mock.calls` is the proper tuple and a
// 4-arg mockImplementation type-checks (loose param types — vi.mock hoists above the imports).
type DispatchArgs = [claims: unknown, text: string, wake: string, send: (f: Record<string, unknown>) => void];
const dispatchTranscript = vi.fn<(...a: DispatchArgs) => Promise<void>>(async () => {});
vi.mock('./device-voice-dispatch', () => ({
  dispatchTranscript: (...args: unknown[]) => dispatchTranscript(...(args as DispatchArgs)),
}));

const TEST_BASE = 39187; // an unusual high port unlikely to collide on a dev/CI box

let mod: typeof import('./device-voice-ws');
let signDeviceToken: typeof import('./device-jwt').signDeviceToken;
// The server logs via console.log ('listening'), console.warn (EADDRINUSE walk)
// and console.error (fatal / per-socket errors). The repo's vitest-fail-on-console
// fails a test on any warn/error, so we silence them and assert explicitly.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  process.env.MOBILE_JWT_SECRET = 'integration-test-mobile-secret-0123456789';
  process.env.MOBILE_VOICE_WS_PORT = String(TEST_BASE);
  ({ signDeviceToken } = await import('./device-jwt'));
  mod = await import('./device-voice-ws');
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await mod._stopMobileVoiceWsForTests();
  dispatchTranscript.mockClear();
  dispatchTranscript.mockImplementation(async () => {});
  vi.restoreAllMocks();
});

async function waitForPort(timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = mod.getMobileVoicePort();
    if (p != null) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('voice WS did not start in time');
}

function token(sub = 'device-1') {
  return signDeviceToken({ sub, workspace_id: 'ws-1', device_kind: 'mobile' });
}

describe('device voice WS — real server', () => {
  it('listens on the base port, authenticates a client, and round-trips a dispatcher frame', async () => {
    dispatchTranscript.mockImplementation(
      async (_c: unknown, _t: unknown, _w: unknown, send: (f: Record<string, unknown>) => void) => {
        send({ kind: 'speak', text: 'pong', source: 'operator' });
      },
    );
    mod.startMobileVoiceWs();
    const port = await waitForPort();
    expect(port).toBe(TEST_BASE);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device/voice?token=${token()}`);
    ws.on('error', () => {/* tolerate races on teardown */});
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');

    await vi.waitFor(() =>
      expect(frames.find((f) => f.kind === 'status' && f.status === 'idle')).toBeTruthy(),
    );

    ws.send(JSON.stringify({ kind: 'transcript', text: 'hello' }));
    await vi.waitFor(() =>
      expect(frames.find((f) => f.kind === 'speak' && f.text === 'pong')).toBeTruthy(),
    );
    expect(dispatchTranscript).toHaveBeenCalledTimes(1);
    expect(dispatchTranscript.mock.calls[0][1]).toBe('hello');

    ws.close();
    await once(ws, 'close');
  });

  it('authenticates a client via the papercusp.bearer.<jwt> subprotocol', async () => {
    mod.startMobileVoiceWs();
    const port = await waitForPort();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device/voice`, [
      `papercusp.bearer.${token()}`,
    ]);
    ws.on('error', () => {});
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    await vi.waitFor(() =>
      expect(frames.find((f) => f.kind === 'status' && f.status === 'idle')).toBeTruthy(),
    );
    ws.close();
    await once(ws, 'close');
  });

  it('rejects an unauthorized client with close code 1008', async () => {
    mod.startMobileVoiceWs();
    const port = await waitForPort();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device/voice?token=bogus`);
    ws.on('error', () => {});
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    expect(code).toBe(1008);
    expect(dispatchTranscript).not.toHaveBeenCalled();
  });

  it('walks to the next port when the base port is already in use (EADDRINUSE fallback)', async () => {
    const blocker = net.createServer();
    blocker.listen(TEST_BASE);
    await once(blocker, 'listening');

    mod.startMobileVoiceWs();
    const port = await waitForPort();
    // It must abandon the blocked base and land on a higher free port in range.
    // (Not asserting exactly +1: a neighbour port can be transiently busy; the
    // contract is "walk off the busy base to the next working port".)
    expect(port).toBeGreaterThan(TEST_BASE);
    expect(port).toBeLessThanOrEqual(TEST_BASE + 8);
    expect(warnSpy).toHaveBeenCalled(); // logged the in-use walk

    // the chosen port really accepts a client
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device/voice?token=${token()}`);
    ws.on('error', () => {});
    await once(ws, 'open');
    ws.close();
    await once(ws, 'close');

    blocker.close();
    await once(blocker, 'close');
  });
});
