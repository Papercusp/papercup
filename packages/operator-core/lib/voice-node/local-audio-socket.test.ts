/**
 * Local voice socket protocol test — manager mocked, real unix socket:
 * CTRL ops dispatch, MIC bytes reframe to exact 20ms PCM frames regardless of
 * client chunking, MIX frames fan out to clients.
 */
import { connect } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder, encodeFrame } from '@papercusp/p2p-voice';
import { VOICE_FRAME_SAMPLES } from './codec';

const mixedCbs: Array<(f: Int16Array) => void> = [];
const peerVideoCbs: Array<(peerId: string, payload: Uint8Array) => void> = [];
const pushMicFrame = vi.fn();
const pushVideoFrame = vi.fn();
const setVideoCameraOn = vi.fn();
const joinVoiceChannel = vi.fn(async (ch: string) => ({ channel: { id: ch }, muted: false, peers: [], identity: { id: 't', label: 't' } }));
const joinHarnessVideoChannel = vi.fn(async (h: string) => ({ channel: { id: `vid-${h}` }, muted: false, peers: [], identity: { id: 't', label: 't' } }));
const leaveVoiceChannel = vi.fn(async () => ({ channel: null, muted: false, peers: [], identity: { id: 't', label: 't' } }));
const setVoiceMuted = vi.fn();

const listVoiceChannels = vi.fn(async () => [{ id: 'vc-1', name: 'standup', topicHex: 'a'.repeat(64), createdAt: 1 }]);
const createVoiceChannel = vi.fn(async (name: string) => ({ id: 'vc-2', name, topicHex: 'b'.repeat(64), createdAt: 2 }));
vi.mock('./registry', () => ({
  listVoiceChannels: () => listVoiceChannels(),
  createVoiceChannel: (n: string) => createVoiceChannel(n),
}));

vi.mock('./manager', () => ({
  joinVoiceChannel: (ch: string) => joinVoiceChannel(ch),
  joinHarnessVideoChannel: (h: string) => joinHarnessVideoChannel(h),
  leaveVoiceChannel: () => leaveVoiceChannel(),
  setVoiceMuted: (m: boolean) => setVoiceMuted(m),
  pushMicFrame: (f: Int16Array) => pushMicFrame(f),
  pushVideoFrame: (p: Uint8Array) => pushVideoFrame(p),
  setVideoCameraOn: (on: boolean) => setVideoCameraOn(on),
  voiceStatus: () => ({ channel: null, muted: false, peers: [], identity: { id: 't', label: 't' } }),
  onMixedFrame: (cb: (f: Int16Array) => void) => {
    mixedCbs.push(cb);
    return () => {};
  },
  onPeerVideoFrame: (cb: (peerId: string, payload: Uint8Array) => void) => {
    peerVideoCbs.push(cb);
    return () => {};
  },
  onVoiceStatusChanged: () => () => {},
}));

import { gcDeadVoiceSockets, startLocalVoiceSocket, stopLocalVoiceSocket } from './local-audio-socket';

// Hermetic IPC root: without this, startLocalVoiceSocket reaps the REAL
// ~/.papercusp/sockets (an orphaned socket on the host → a GC console.error →
// vitest-fail-on-console reds the gate) and overwrites the live voice-ipc.json.
process.env.PAPERCUSP_VOICE_IPC_DIR = mkdtempSync(join(tmpdir(), 'voice-ipc-test-'));

const CTRL = 0x01;
const MIC = 0x02;
const MIX = 0x03;
const CAM = 0x04;
const VID = 0x05;
const te = new TextEncoder();
const td = new TextDecoder();

afterEach(() => {
  stopLocalVoiceSocket();
  vi.clearAllMocks();
  mixedCbs.length = 0;
  peerVideoCbs.length = 0;
});

function client(path: string) {
  const sock = connect(path);
  const decoder = new FrameDecoder();
  const ctrl: unknown[] = [];
  const mixes: Uint8Array[] = [];
  const vids: Uint8Array[] = [];
  sock.on('data', (chunk) => {
    for (const f of decoder.push(new Uint8Array(chunk))) {
      if (f.type === CTRL) ctrl.push(JSON.parse(td.decode(f.payload)));
      if (f.type === MIX) mixes.push(f.payload);
      if (f.type === VID) vids.push(f.payload);
    }
  });
  return { sock, ctrl, mixes, vids };
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

  it('serves the channel registry over ctrl (channels + create)', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'channels' }))));
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'create', name: 'design-crit' }))));
    await settle();
    const chans = c.ctrl.filter((m) => (m as { ev?: string }).ev === 'channels') as Array<{ channels: unknown[] }>;
    expect(chans.length).toBe(2);
    expect(chans[0].channels).toHaveLength(1);
    expect(createVoiceChannel).toHaveBeenCalledWith('design-crit');
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

  it('relays CAM frames to the operator (pushVideoFrame) verbatim', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);

    const payload = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0xab, 0xcd]); // opaque video frame
    c.sock.write(encodeFrame(CAM, payload));
    await settle();

    expect(pushVideoFrame).toHaveBeenCalledTimes(1);
    expect([...(pushVideoFrame.mock.calls[0][0] as Uint8Array)]).toEqual([...payload]);
    c.sock.destroy();
  });

  it('fans peer VID frames ONLY to opted-in clients, peerId-tagged', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const optedIn = client(socketPath);
    const audioOnly = client(socketPath); // never sends {op:'video'}
    await settle(40);

    optedIn.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'video', recv: true }))));
    await settle();

    const payload = new Uint8Array([9, 9, 9, 9]);
    for (const cb of peerVideoCbs) cb('peerXY', payload);
    await settle();

    // opted-in client gets exactly one VID frame: [idLen][peerId][payload]
    expect(optedIn.vids).toHaveLength(1);
    const vid = optedIn.vids[0];
    const idLen = vid[0];
    expect(td.decode(vid.subarray(1, 1 + idLen))).toBe('peerXY');
    expect([...vid.subarray(1 + idLen)]).toEqual([...payload]);
    // audio-only client (pui-equivalent) receives NOTHING
    expect(audioOnly.vids).toHaveLength(0);

    optedIn.sock.destroy();
    audioOnly.sock.destroy();
  });

  it('stops fanning VID after a client opts out (recv:false)', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'video', recv: true }))));
    await settle();
    for (const cb of peerVideoCbs) cb('p1', new Uint8Array([1]));
    await settle();
    expect(c.vids).toHaveLength(1);

    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'video', recv: false }))));
    await settle();
    for (const cb of peerVideoCbs) cb('p1', new Uint8Array([2]));
    await settle();
    expect(c.vids).toHaveLength(1); // unchanged — no new frame after opt-out
    c.sock.destroy();
  });

  it('joins the deterministic harness video channel on {op:joinVideo}', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'joinVideo', harness: 'papercup' }))));
    await settle();
    expect(joinHarnessVideoChannel).toHaveBeenCalledWith('papercup');
    c.sock.destroy();
  });

  it('forwards {op:camera,on} to the operator (setVideoCameraOn)', async () => {
    const { socketPath } = startLocalVoiceSocket();
    const c = client(socketPath);
    await settle(40);
    c.sock.write(encodeFrame(CTRL, te.encode(JSON.stringify({ op: 'camera', on: true }))));
    await settle();
    expect(setVideoCameraOn).toHaveBeenCalledWith(true);
    c.sock.destroy();
  });
});

describe('gcDeadVoiceSockets (EI-3290)', () => {
  it('reaps only dead-pid voice-*.sock files; keeps live, own, and non-matching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-gc-'));
    try {
      writeFileSync(join(dir, 'voice-100.sock'), ''); // dead pid → reap
      writeFileSync(join(dir, 'voice-200.sock'), ''); // live pid → keep
      writeFileSync(join(dir, `voice-${process.pid}.sock`), ''); // our own → keep
      writeFileSync(join(dir, 'voice-abc.sock'), ''); // non-numeric → ignore
      writeFileSync(join(dir, 'other.txt'), ''); // unrelated → ignore

      const reaped = gcDeadVoiceSockets(dir, (pid) => pid === 200);

      expect(reaped).toBe(1);
      expect(existsSync(join(dir, 'voice-100.sock'))).toBe(false);
      expect(existsSync(join(dir, 'voice-200.sock'))).toBe(true);
      expect(existsSync(join(dir, `voice-${process.pid}.sock`))).toBe(true);
      expect(existsSync(join(dir, 'voice-abc.sock'))).toBe(true);
      expect(existsSync(join(dir, 'other.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 when the sockets dir is absent', () => {
    const missing = join(tmpdir(), `voice-gc-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    expect(gcDeadVoiceSockets(missing, () => false)).toBe(0);
  });
});
