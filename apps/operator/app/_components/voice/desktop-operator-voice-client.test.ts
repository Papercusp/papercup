/**
 * Desktop operator-voice client routing + election (universal-voice-interface
 * -2026-06-05, P-008). Drives the client with an injected fake WebSocket and the
 * shared bus encoders: asserts the attach handshake, fan-out → callbacks, the
 * single-player election (audio/mic gated to the elected client), and controls.
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  decodeOpVoiceFrame,
  encodeSessionState,
  encodeInputTranscript,
  encodeResponseAudio,
  encodeResponseTranscript,
  encodeResponseTag,
  type OpVoiceMessage,
} from '@papercusp/operator-core/lib/voice-node/operator-voice-bus';
import { connectDesktopOperatorVoice, type WsLike } from './desktop-operator-voice-client';

class FakeWs implements WsLike {
  readyState = 1;
  binaryType = '';
  sent: Uint8Array[] = [];
  private handlers: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  emit(type: string, ev: { data?: unknown }): void {
    (this.handlers[type] ?? []).forEach((h) => h(ev));
  }
  /** Deliver one framed inbound bus message. */
  deliver(frame: Uint8Array): void {
    this.emit('message', { data: frame });
  }
}

/** Decode every operator-voice message the client sent on the socket. */
function decodeSent(ws: FakeWs): OpVoiceMessage[] {
  const dec = new FrameDecoder();
  const out: OpVoiceMessage[] = [];
  for (const buf of ws.sent) {
    for (const f of dec.push(buf)) {
      const m = decodeOpVoiceFrame(f);
      if (m) out.push(m);
    }
  }
  return out;
}

async function setup(
  clientId = 'tab-1',
  extra: Partial<Parameters<typeof connectDesktopOperatorVoice>[0]> = {},
) {
  const ws = new FakeWs();
  const events: { input: Array<[string, boolean]>; resp: string[]; tags: Array<[string, string]>; audio: Array<{ len: number; elected: boolean }>; states: Array<{ playerId: string | null; elected: boolean }> } = {
    input: [],
    resp: [],
    tags: [],
    audio: [],
    states: [],
  };
  const session = await connectDesktopOperatorVoice({
    clientId,
    wsFactory: () => ws,
    onInputTranscript: (t, f) => events.input.push([t, f]),
    onResponseTranscript: (t) => events.resp.push(t),
    onResponseTag: (tag, value) => events.tags.push([tag, value]),
    onResponseAudio: (audio, _fmt, _rate, elected) => events.audio.push({ len: audio.length, elected }),
    onState: (s, elected) => events.states.push({ playerId: s.playerId, elected }),
    ...extra,
  });
  return { ws, session, events };
}

describe('desktop operator-voice client', () => {
  it('resolves the walked port before opening the socket', async () => {
    const wsFactory = vi.fn(() => new FakeWs());
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ port: 3079, path: '/api/desktop/voice' }),
    }));

    await connectDesktopOperatorVoice({
      clientId: 'tab-1',
      fetchImpl,
      wsFactory,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/desktop/voice-config');
    expect(wsFactory).toHaveBeenCalledWith('ws://127.0.0.1:3079/api/desktop/voice');
  });

  it('on open attaches (HELLO desktop) and requests start', async () => {
    const { ws } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    ws.emit('open', {});
    const sent = decodeSent(ws);
    expect(sent[0]).toEqual({ kind: 'hello', clientId: 'tab-1', clientKind: 'desktop', label: undefined });
    expect(sent[1]).toEqual({ kind: 'control', control: { op: 'start' } });
  });

  it('fans input/response transcript + tags out to callbacks', async () => {
    const { ws, events } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    ws.deliver(encodeInputTranscript({ text: 'what is the status', final: true }));
    ws.deliver(encodeResponseTranscript({ text: '<say>on it</say>' }));
    ws.deliver(encodeResponseTag({ tag: 'set_mode', value: 'passive' }));
    expect(events.input).toEqual([['what is the status', true]]);
    expect(events.resp).toEqual(['<say>on it</say>']);
    expect(events.tags).toEqual([['set_mode', 'passive']]);
  });

  it('elects this client when session_state.playerId matches, and reflects it', async () => {
    const { ws, session, events } = await setup('tab-1', {
      url: 'ws://127.0.0.1:3076/api/desktop/voice',
    });
    ws.deliver(encodeSessionState({ status: 'idle', muted: false, mode: 'always-on', playerId: 'tab-1', conversationId: 'c' }));
    expect(session.isElected()).toBe(true);
    expect(session.playerId()).toBe('tab-1');
    expect(events.states.at(-1)).toEqual({ playerId: 'tab-1', elected: true });

    // Another client takes over → we become display-only.
    ws.deliver(encodeSessionState({ status: 'speaking', muted: false, mode: 'always-on', playerId: 'pui-2', conversationId: 'c' }));
    expect(session.isElected()).toBe(false);
    expect(events.states.at(-1)).toEqual({ playerId: 'pui-2', elected: false });
  });

  it('tags response audio with the elected flag (single playout, Model A)', async () => {
    const { ws, events } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    const audio = new Uint8Array([1, 2, 3, 4]);
    // not elected yet → audio still delivered, but flagged not-elected
    ws.deliver(encodeResponseAudio({ format: 'pcm_s16le', sampleRate: 16000, audio }));
    expect(events.audio.at(-1)).toEqual({ len: 4, elected: false });
    // become the player → subsequent audio is flagged elected
    ws.deliver(encodeSessionState({ status: 'speaking', muted: false, mode: 'always-on', playerId: 'tab-1', conversationId: 'c' }));
    ws.deliver(encodeResponseAudio({ format: 'pcm_s16le', sampleRate: 16000, audio }));
    expect(events.audio.at(-1)).toEqual({ len: 4, elected: true });
  });

  it('streams mic ONLY while elected (single mic capture, P-007)', async () => {
    const { ws, session } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    const before = ws.sent.length;
    session.sendMic(new Uint8Array([5, 6])); // not elected → dropped
    expect(ws.sent.length).toBe(before);

    ws.deliver(encodeSessionState({ status: 'idle', muted: false, mode: 'always-on', playerId: 'tab-1', conversationId: 'c' }));
    session.sendMic(new Uint8Array([5, 6, 7, 8]));
    const mic = decodeSent(ws).find((m) => m.kind === 'mic');
    expect(mic).toBeTruthy();
    if (mic?.kind === 'mic') expect(Array.from(mic.pcm16le)).toEqual([5, 6, 7, 8]);
  });

  it('sends controls to the host', async () => {
    const { ws, session } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    session.control({ op: 'mute', muted: true });
    session.control({ op: 'force-host' });
    const sent = decodeSent(ws);
    expect(sent).toContainEqual({ kind: 'control', control: { op: 'mute', muted: true } });
    expect(sent).toContainEqual({ kind: 'control', control: { op: 'force-host' } });
  });

  it('does not send before the socket is open', async () => {
    const { ws, session } = await setup('tab-1', { url: 'ws://127.0.0.1:3076/api/desktop/voice' });
    ws.readyState = 0; // CONNECTING
    session.control({ op: 'stop' });
    expect(ws.sent.length).toBe(0);
  });
});
