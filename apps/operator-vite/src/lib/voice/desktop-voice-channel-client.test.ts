import { describe, expect, it } from 'vitest';
import { FrameDecoder, decodeCtrl, encodeFrame } from '@papercusp/p2p-voice';
import { connectDesktopVoiceChannel } from './desktop-voice-channel-client';
import type { WsLike, VoiceSessionStatus } from '../video/desktop-video-client';
import { CTRL, MIC, MIX } from '../video/desktop-video-protocol';
import type { VoiceChannelRow } from './desktop-voice-channel-client';

const te = new TextEncoder();

class FakeWs implements WsLike {
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
  addEventListener(type: 'open' | 'close' | 'error' | 'message', cb: (ev: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  private emit(type: string, ev: { data?: unknown } = {}) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  message(bytes: Uint8Array) {
    this.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  decodeSent() {
    const d = new FrameDecoder();
    const out: { type: number; payload: Uint8Array }[] = [];
    for (const b of this.sent) out.push(...d.push(b));
    return out;
  }
}

function ctrlFrame(msg: unknown): Uint8Array {
  return encodeFrame(CTRL, te.encode(JSON.stringify(msg)));
}

function connect() {
  const ws = new FakeWs();
  const statuses: VoiceSessionStatus[] = [];
  const channelLists: VoiceChannelRow[][] = [];
  const mixes: Uint8Array[] = [];
  const errors: unknown[] = [];
  const events: string[] = [];
  const session = connectDesktopVoiceChannel({
    wsFactory: () => ws,
    onStatus: (s) => statuses.push(s),
    onChannels: (c) => channelLists.push(c),
    onMix: (m) => mixes.push(m),
    onError: (e) => errors.push(e),
    onOpen: () => events.push('open'),
    onClose: () => events.push('close'),
  });
  return { ws, statuses, channelLists, mixes, errors, events, session };
}

describe('connectDesktopVoiceChannel', () => {
  it('on open, primes status + the channel list', () => {
    const { ws, events } = connect();
    ws.open();
    const frames = ws.decodeSent();
    expect(frames).toHaveLength(2);
    expect(decodeCtrl(frames[0].payload)).toEqual({ op: 'status' });
    expect(decodeCtrl(frames[1].payload)).toEqual({ op: 'channels' });
    expect(events).toEqual(['open']);
  });

  it('join / leave / mute / refresh / create send the right CTRL ops', () => {
    const { ws, session } = connect();
    ws.open();
    ws.sent.length = 0;
    session.join('dev-standup');
    session.setMuted(true);
    session.refreshChannels();
    session.createChannel('war-room');
    session.leave();
    const ops = ws.decodeSent().map((f) => decodeCtrl(f.payload));
    expect(ops).toEqual([
      { op: 'join', channel: 'dev-standup' },
      { op: 'mute', muted: true },
      { op: 'channels' },
      { op: 'create', name: 'war-room' },
      { op: 'leave' },
    ]);
  });

  it('sendMic writes MIC frames carrying the capture bytes verbatim', () => {
    const { ws, session } = connect();
    ws.open();
    ws.sent.length = 0;
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    session.sendMic(pcm);
    const frames = ws.decodeSent();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(MIC);
    expect([...frames[0].payload]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('routes inbound status / channels / MIX / error frames', () => {
    const { ws, statuses, channelLists, mixes, errors } = connect();
    ws.open();
    const status: VoiceSessionStatus = {
      channel: { id: 'vc-1', name: 'dev' },
      muted: false,
      peers: [{ id: 'A', label: 'A', muted: false, speaking: true, cameraOn: false }],
      agentSpeaking: true,
    };
    ws.message(ctrlFrame({ ev: 'status', status }));
    ws.message(ctrlFrame({ ev: 'channels', channels: [{ id: 'vc-1', name: 'dev' }] }));
    ws.message(encodeFrame(MIX, new Uint8Array([7, 7])));
    ws.message(ctrlFrame({ ev: 'error', message: 'boom' }));
    expect(statuses).toHaveLength(1);
    expect(statuses[0].agentSpeaking).toBe(true);
    expect(channelLists).toEqual([[{ id: 'vc-1', name: 'dev' }]]);
    expect(mixes).toHaveLength(1);
    expect([...mixes[0]]).toEqual([7, 7]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('handles MIX frames split across WS messages (FrameDecoder reassembly)', () => {
    const { ws, mixes } = connect();
    ws.open();
    const whole = encodeFrame(MIX, new Uint8Array([9, 8, 7, 6]));
    ws.message(whole.subarray(0, 3));
    ws.message(whole.subarray(3));
    expect(mixes).toHaveLength(1);
    expect([...mixes[0]]).toEqual([9, 8, 7, 6]);
  });

  it('drops sends before the socket is open', () => {
    const { ws, session } = connect();
    session.join('x');
    session.sendMic(new Uint8Array([1]));
    expect(ws.sent).toHaveLength(0);
  });

  it('close leaves the channel, closes the socket, and reports onClose', () => {
    const { ws, session, events } = connect();
    ws.open();
    ws.sent.length = 0;
    session.close();
    const frames = ws.decodeSent();
    expect(decodeCtrl(frames[0].payload)).toEqual({ op: 'leave' });
    expect(ws.closed).toBe(true);
    expect(events).toContain('close');
  });

  it('does not throw on a malformed inbound frame', () => {
    const { ws } = connect();
    ws.open();
    expect(() => ws.message(encodeFrame(CTRL, te.encode('not json')))).not.toThrow();
  });
});
