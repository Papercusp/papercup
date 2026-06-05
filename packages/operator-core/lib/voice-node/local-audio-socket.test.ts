/**
 * Local voice socket protocol test — manager mocked, real unix socket:
 * CTRL ops dispatch, MIC bytes reframe to exact 20ms PCM frames regardless of
 * client chunking, MIX frames fan out to clients.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeFrame } from '@papercusp/p2p-voice';
import { VOICE_FRAME_SAMPLES } from './codec';

const mixedCbs: Array<(f: Int16Array) => void> = [];
const pushMicFrame = vi.fn();
const joinVoiceChannel = vi.fn(async (ch: string) => ({ channel: { id: ch }, muted: false, peers: [], identity: { id: 't', label: 't' } }));
const leaveVoiceChannel = vi.fn(async () => ({ channel: null, muted: false, peers: [], identity: { id: 't', label: 't' } }));
const setVoiceMuted = vi.fn();

vi.mock('./manager', () => ({
  joinVoiceChannel: (ch: string) => joinVoiceChannel(ch),
  leaveVoiceChannel: () => leaveVoiceChannel(),
  setVoiceMuted: (m: boolean) => setVoiceMuted(m),
  pushMicFrame: (f: Int16Array) => pushMicFrame(f),
  voiceStatus: () => ({ channel: null, muted: false, peers: [], identity: { id: 't', label: 't' } }),
  onMixedFrame: (cb: (f: Int16Array) => void) => {
    mixedCbs.push(cb);
    return () => {};
  },
  onVoiceStatusChanged: () => () => {},
}));

import { startLocalVoiceSocket, stopLocalVoiceSocket } from './local-audio-socket';

const CTRL = 0x01;
const MIC = 0x02;
const MIX = 0x03;
const te = new TextEncoder();
const td = new TextDecoder();

afterEach(() => {
  stopLocalVoiceSocket();
  vi.clearAllMocks();
  mixedCbs.length = 0;
});

function client(path: string) {
  const sock = connect(path);
  const decoder = new FrameDecoder();
  const ctrl: unknown[] = [];
  const mixes: Uint8Array[] = [];
  sock.on('data', (chunk) => {
    for (const f of decoder.push(new Uint8Array(chunk))) {
      if (f.type === CTRL) ctrl.push(JSON.parse(td.decode(f.payload)));
      if (f.type === MIX) mixes.push(f.payload);
    }
  });
  return { sock, ctrl, mixes };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('local voice socket', () => {
  it('greets with status, dispatches join/mute/leave ctrl ops', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle();
    expect(c.ctrl).toHaveLength(1); // greeting status

    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'join', channel: 'standup' }))));
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'mute', muted: true }))));
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'leave' }))));
    await settle();

    expect(joinVoiceChannel).toHaveBeenCalledWith('standup');
    expect(setVoiceMuted).toHaveBeenCalledWith(true);
    expect(leaveVoiceChannel).toHaveBeenCalled();
    c.sock.destroy();
  });

  it('reframes arbitrarily-chunked MIC bytes into exact 20ms frames', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);

    // 2.5 frames of ramp samples, sent as one MIC frame payload → expect exactly 2 pushes,
    // remainder held; then the missing half-frame completes frame 3.
    const total = Math.floor(VOICE_FRAME_SAMPLES * 2.5);
    const pcm = new Int16Array(total);
    for (let i = 0; i < total; i++) pcm[i] = i % 32768;
    const bytes = new Uint8Array(pcm.buffer);
    c.sock.write(encodeFrame(MIC, bytes));
    await settle();
    expect(pushMicFrame).toHaveBeenCalledTimes(2);
    expect((pushMicFrame.mock.calls[0][0] as Int16Array).length).toBe(VOICE_FRAME_SAMPLES);
    expect((pushMicFrame.mock.calls[0][0] as Int16Array)[5]).toBe(5);

    const rest = new Int16Array(Math.ceil(VOICE_FRAME_SAMPLES * 0.5));
    c.sock.write(encodeFrame(MIC, new Uint8Array(rest.buffer)));
    await settle();
    expect(pushMicFrame).toHaveBeenCalledTimes(3);
    c.sock.destroy();
  });

  it('fans MIX frames out to connected clients', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c1 = client(socketPath);
    const c2 = client(socketPath);
    await settle(40);

    const frame = new Int16Array(VOICE_FRAME_SAMPLES).fill(1234);
    for (const cb of mixedCbs) cb(frame);
    await settle();

    for (const c of [c1, c2]) {
      expect(c.mixes).toHaveLength(1);
      expect(c.mixes[0].length).toBe(VOICE_FRAME_SAMPLES * 2);
      expect(new Int16Array(c.mixes[0].buffer.slice(c.mixes[0].byteOffset))[0]).toBe(1234);
    }
    c1.sock.destroy();
    c2.sock.destroy();
  });
});
