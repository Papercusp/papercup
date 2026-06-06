import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder, decodeCtrl, decodeVideo, encodeFrame, encodeVideoPayload } from '@papercusp/p2p-voice';
import { connectDesktopVideo, type WsLike, type VoiceSessionStatus } from './desktop-video-client';
import { CAM, CTRL } from './desktop-video-protocol';
import type { PeerDecoder, VideoFrameLike } from './video-codec';

const te = new TextEncoder();

class FakeWs implements WsLike {
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  private emit(type: string, ev?: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  message(bytes: Uint8Array) {
    this.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  /** Decode everything sent as discrete frames (across the connection). */
  decodeSent() {
    const d = new FrameDecoder();
    const out: { type: number; payload: Uint8Array }[] = [];
    for (const b of this.sent) out.push(...d.push(b));
    return out;
  }
}

function statusFrame(status: VoiceSessionStatus): Uint8Array {
  return encodeFrame(CTRL, te.encode(JSON.stringify({ ev: 'status', status })));
}
function vidFrame(peerId: string, key: boolean, ts: number, data: number[]): Uint8Array {
  const vp = encodeVideoPayload({ key, timestamp: ts }, new Uint8Array(data));
  const id = te.encode(peerId);
  const payload = new Uint8Array(1 + id.length + vp.length);
  payload[0] = id.length;
  payload.set(id, 1);
  payload.set(vp, 1 + id.length);
  return encodeFrame(0x05 /* VID */, payload);
}

/** A fake PeerDecoder that renders each decoded frame as a stub VideoFrame. */
function fakeDecoderFactory() {
  const closed: boolean[] = [];
  const factory = (onFrame: (f: VideoFrameLike) => void): PeerDecoder => {
    const idx = closed.length;
    closed.push(false);
    return {
      decode: (frame) => onFrame({ timestamp: frame.timestamp, close: () => {} }),
      reset: () => {},
      close: () => {
        closed[idx] = true;
      },
    };
  };
  return { factory, closed };
}

function connect(extra?: Partial<Parameters<typeof connectDesktopVideo>[0]>) {
  const ws = new FakeWs();
  const dec = fakeDecoderFactory();
  const peerFrames: Array<{ peerId: string; ts: number }> = [];
  const statuses: VoiceSessionStatus[] = [];
  const session = connectDesktopVideo({
    channel: 'vc-1',
    wsFactory: () => ws,
    decoderFactory: dec.factory,
    onPeerFrame: (peerId, f) => peerFrames.push({ peerId, ts: f.timestamp }),
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { ws, dec, peerFrames, statuses, session };
}

describe('connectDesktopVideo', () => {
  it('on open, joins the channel and opts into receiving video', () => {
    const { ws } = connect();
    ws.open();
    const frames = ws.decodeSent();
    expect(frames).toHaveLength(2);
    expect(decodeCtrl(frames[0].payload)).toEqual({ op: 'join', channel: 'vc-1' });
    expect(decodeCtrl(frames[1].payload)).toEqual({ op: 'video', recv: true });
  });

  it('routes inbound VID frames to onPeerFrame, tagged by peer', () => {
    const { ws, peerFrames } = connect();
    ws.open();
    ws.message(vidFrame('A', true, 10, [1, 2]));
    ws.message(vidFrame('B', true, 20, [3]));
    ws.message(vidFrame('A', false, 11, [4]));
    expect(peerFrames).toEqual([
      { peerId: 'A', ts: 10 },
      { peerId: 'B', ts: 20 },
      { peerId: 'A', ts: 11 },
    ]);
  });

  it('forwards status pushes and prunes decoders for departed peers', () => {
    const { ws, statuses, dec } = connect();
    ws.open();
    ws.message(vidFrame('A', true, 1, [1])); // decoder 0 for A
    ws.message(vidFrame('B', true, 1, [1])); // decoder 1 for B
    ws.message(statusFrame({ channel: { id: 'vc-1' }, muted: false, peers: [peer('A')] })); // B left
    expect(statuses).toHaveLength(1);
    expect(statuses[0].peers.map((p) => p.id)).toEqual(['A']);
    expect(dec.closed).toEqual([false, true]); // B's decoder closed, A's kept
  });

  it('sendCamFrame writes a CAM frame carrying the encoded payload', () => {
    const { ws, session } = connect();
    ws.open();
    ws.sent.length = 0; // ignore join/recv
    session.sendCamFrame({ key: true, timestamp: 500, data: new Uint8Array([9, 9, 9]) });
    const frames = ws.decodeSent();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(CAM);
    const v = decodeVideo(frames[0].payload);
    expect(v.key).toBe(true);
    expect(v.timestamp).toBe(500);
    expect([...v.data]).toEqual([9, 9, 9]);
  });

  it('setCameraOn / setMuted send the right CTRL ops', () => {
    const { ws, session } = connect();
    ws.open();
    ws.sent.length = 0;
    session.setCameraOn(true);
    session.setMuted(true);
    const frames = ws.decodeSent();
    expect(decodeCtrl(frames[0].payload)).toEqual({ op: 'camera', on: true });
    expect(decodeCtrl(frames[1].payload)).toEqual({ op: 'mute', muted: true });
  });

  it('drops sends before the socket is open', () => {
    const { ws, session } = connect();
    session.setMuted(true); // before open
    expect(ws.sent).toHaveLength(0);
  });

  it('close leaves the channel, closes the socket and all decoders', () => {
    const { ws, session, dec } = connect();
    ws.open();
    ws.message(vidFrame('A', true, 1, [1]));
    ws.sent.length = 0;
    session.close();
    const frames = ws.decodeSent();
    expect(decodeCtrl(frames[0].payload)).toEqual({ op: 'leave' });
    expect(ws.closed).toBe(true);
    expect(dec.closed[0]).toBe(true);
  });

  it('does not throw on a malformed inbound frame', () => {
    const { ws } = connect();
    ws.open();
    expect(() => ws.message(encodeFrame(CTRL, te.encode('not json')))).not.toThrow();
  });
});

function peer(id: string) {
  return { id, label: id, muted: false, speaking: false, cameraOn: true };
}
