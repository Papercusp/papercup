/**
 * Unit tests for the mobile voice WS server's per-connection protocol
 * (`device-voice-ws.ts` → `handleConnection`).
 *
 * device-voice-ws is a "pure pipe": it validates the device JWT, forwards
 * transcripts to `dispatchTranscript`, and writes back whatever frames the
 * dispatcher emits via a `send` callback. We exercise that contract directly
 * through the exported `handleConnection` with a fake WebSocket +
 * IncomingMessage — no real socket, no PG, no HTTP. `dispatchTranscript` is
 * mocked (its routing logic is covered in device-voice-dispatch.test.ts). The
 * real listen + EADDRINUSE-fallback paths are covered in
 * device-voice-ws.integration.test.ts.
 *
 * P-001 of plan voice-production-test-coverage-2026-06-01.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stable HS256 secret so signDeviceToken (test) and verifyDeviceToken (SUT)
// share a key. device-jwt's getSecret() is lazy, so setting it before the
// first sign/verify is sufficient; top-level keeps it unambiguous.
process.env.MOBILE_JWT_SECRET = 'unit-test-mobile-secret-0123456789abcd';

// Mock typed to dispatchTranscript's real 4-arg signature (claims, text, wakeWord, send), so
// `.mock.calls[N]` is the proper tuple and a 4-arg mockImplementation type-checks. (Defined with
// loose param types to avoid depending on imports declared below — vi.mock hoists above them.)
type DispatchArgs = [claims: unknown, text: string, wake: string, send: (f: Record<string, unknown>) => void];
const dispatchTranscript = vi.fn<(...a: DispatchArgs) => Promise<void>>(async () => {});
vi.mock('./device-voice-dispatch', () => ({
  dispatchTranscript: (...args: unknown[]) => dispatchTranscript(...(args as DispatchArgs)),
}));

import { signDeviceToken, type DeviceClaims } from './device-jwt';
import { handleConnection } from './device-voice-ws';

type Frame = Record<string, unknown>;

/** Minimal stand-in for a `ws` WebSocket — records sent frames + lifecycle. */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Frame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.terminated = true;
  }
}

function req(opts: { token?: string; subproto?: string } = {}): IncomingMessage {
  const qs = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
  return {
    url: `/api/device/voice${qs}`,
    headers: opts.subproto ? { 'sec-websocket-protocol': opts.subproto } : {},
  } as unknown as IncomingMessage;
}

function validToken(over: Partial<Omit<DeviceClaims, 'iat' | 'exp'>> = {}): string {
  return signDeviceToken({
    sub: 'device-1',
    workspace_id: 'ws-1',
    device_kind: 'mobile',
    ...over,
  });
}

/** Flush microtasks so the async `message` handler resolves. */
const flush = () => new Promise<void>((r) => setImmediate(r));

// Track connections so we always close them — handleConnection arms a 20s
// setInterval that would otherwise leak as an open handle.
const live: FakeWs[] = [];
function connect(opts: { token?: string; subproto?: string } = {}): FakeWs {
  const ws = new FakeWs();
  live.push(ws);
  handleConnection(ws as never, req(opts));
  return ws;
}

beforeEach(() => {
  dispatchTranscript.mockClear();
  dispatchTranscript.mockImplementation(async () => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const ws of live) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  live.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handleConnection — auth gate', () => {
  it('closes with 1008 when no token is offered', () => {
    const ws = connect();
    expect(ws.closed).toEqual({ code: 1008, reason: 'unauthorized' });
    expect(ws.sent).toEqual([]);
  });

  it('closes with 1008 on a tampered token', () => {
    const bad = `${validToken()}x`;
    const ws = connect({ token: bad });
    expect(ws.closed).toEqual({ code: 1008, reason: 'unauthorized' });
  });

  it('accepts a valid ?token= and sends the initial idle status', () => {
    const ws = connect({ token: validToken() });
    expect(ws.closed).toBeNull();
    expect(ws.sent[0]).toEqual({ kind: 'status', status: 'idle' });
  });

  it('accepts the papercusp.bearer.<jwt> subprotocol header', () => {
    const ws = connect({ subproto: `papercusp.bearer.${validToken()}` });
    expect(ws.closed).toBeNull();
    expect(ws.sent[0]).toEqual({ kind: 'status', status: 'idle' });
  });

  it('parses the subprotocol token from a comma-separated offer list', () => {
    const ws = connect({ subproto: `papercusp.bearer.${validToken()}, permessage-deflate` });
    expect(ws.closed).toBeNull();
    expect(ws.sent[0]).toEqual({ kind: 'status', status: 'idle' });
  });
});

describe('handleConnection — transcript forwarding', () => {
  it('forwards a transcript to dispatchTranscript with claims, text, default wake word, and a send fn', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'hello there' }));
    await flush();
    expect(dispatchTranscript).toHaveBeenCalledTimes(1);
    const [claims, text, wake, send] = dispatchTranscript.mock.calls[0] as [
      DeviceClaims,
      string,
      string,
      (f: Frame) => void,
    ];
    expect(claims.sub).toBe('device-1');
    expect(claims.workspace_id).toBe('ws-1');
    expect(text).toBe('hello there');
    expect(wake).toBe('hey operator'); // DEFAULT_WAKE_WORD
    expect(typeof send).toBe('function');
  });

  it('caches the wake word from a hello frame for later transcripts', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'hello', wakeWord: 'computer' }));
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'scan all' }));
    await flush();
    expect(dispatchTranscript.mock.calls[0][2]).toBe('computer');
  });

  it('honors a wake word carried on the transcript frame (legacy phones)', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'x', wakeWord: 'jarvis' }));
    await flush();
    expect(dispatchTranscript.mock.calls[0][2]).toBe('jarvis');
  });

  it('delivers dispatcher frames back to the socket via the send callback', async () => {
    dispatchTranscript.mockImplementation(async (_c, _t, _w, send: (f: Frame) => void) => {
      send({ kind: 'speak', text: 'hi', source: 'operator' });
    });
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'q' }));
    await flush();
    expect(ws.sent).toContainEqual({ kind: 'speak', text: 'hi', source: 'operator' });
  });

  it('the send callback is a no-op when the socket is not OPEN', async () => {
    dispatchTranscript.mockImplementation(async (_c, _t, _w, send: (f: Frame) => void) => {
      // simulate the client going away mid-dispatch
      live[live.length - 1]!.readyState = 3;
      send({ kind: 'speak', text: 'late', source: 'operator' });
    });
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'q' }));
    await flush();
    expect(ws.sent.some((f) => f.text === 'late')).toBe(false);
  });

  it('ignores malformed JSON without crashing or dispatching', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', 'not json {');
    await flush();
    expect(dispatchTranscript).not.toHaveBeenCalled();
  });

  it('ignores a transcript whose text is missing or non-string', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'transcript' }));
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 123 }));
    await flush();
    expect(dispatchTranscript).not.toHaveBeenCalled();
  });
});

describe('handleConnection — phone TTS gating', () => {
  it('drops transcripts while the phone reports it is speaking', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'status', status: 'speaking' }));
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'feedback bleed' }));
    await flush();
    expect(dispatchTranscript).not.toHaveBeenCalled();
  });

  it('resumes forwarding once the phone returns to idle', async () => {
    const ws = connect({ token: validToken() });
    ws.emit('message', JSON.stringify({ kind: 'status', status: 'speaking' }));
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'dropped' }));
    await flush();
    expect(dispatchTranscript).not.toHaveBeenCalled();

    ws.emit('message', JSON.stringify({ kind: 'status', status: 'idle' }));
    ws.emit('message', JSON.stringify({ kind: 'transcript', text: 'delivered' }));
    await flush();
    expect(dispatchTranscript).toHaveBeenCalledTimes(1);
    expect(dispatchTranscript.mock.calls[0][1]).toBe('delivered');
  });
});

describe('handleConnection — keepalive ping', () => {
  it('pings after the idle interval and terminates when no pong returns', () => {
    vi.useFakeTimers();
    const ws = connect({ token: validToken() });
    vi.advanceTimersByTime(20_000);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(ws.terminated).toBe(true);
  });

  it('a pong resets the liveness deadline', () => {
    vi.useFakeTimers();
    const ws = connect({ token: validToken() });
    vi.advanceTimersByTime(20_000);
    expect(ws.pings).toBe(1);
    ws.emit('pong'); // marks alive again
    vi.advanceTimersByTime(20_000);
    expect(ws.pings).toBe(2);
    expect(ws.terminated).toBe(false);
  });

  it('clears the ping interval on close', () => {
    vi.useFakeTimers();
    const ws = connect({ token: validToken() });
    ws.close();
    vi.advanceTimersByTime(60_000);
    expect(ws.pings).toBe(0);
    expect(ws.terminated).toBe(false);
  });
});
