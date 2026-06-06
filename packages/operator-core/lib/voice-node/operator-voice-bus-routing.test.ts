/**
 * Operator-voice bus routing over a REAL local unix socket
 * (universal-voice-interface-2026-06-05, P-003/P-004). Asserts that inbound
 * HELLO/MIC/CONTROL frames (0x10–0x1F) route to the host-owned session with the
 * right client id, that the host's outbound frames fan out to attached clients,
 * and that a disconnect notifies the host. The manager/registry are mocked so no
 * hyperswarm spins up; HOME is redirected to a tmp dir so the discovery file +
 * socket never touch the live operator's `~/.papercusp`.
 */
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  encodeHello,
  encodeMic,
  encodeControl,
  encodeSessionState,
  decodeOpVoiceFrame,
  isOpVoiceFrameType,
  type OpVoiceMessage,
} from './operator-voice-bus';

// Keep the P2P channel infra (hyperswarm) out — we only exercise OPV routing.
import { vi } from 'vitest';
vi.mock('./registry', () => ({
  listVoiceChannels: async () => [],
  createVoiceChannel: async (n: string) => ({ id: 'vc', name: n, topicHex: 'a'.repeat(64), createdAt: 1 }),
}));
const noStatus = { channel: null, muted: false, peers: [], identity: { id: 't', label: 't' }, agentSpeaking: false };
vi.mock('./manager', () => ({
  joinVoiceChannel: async () => noStatus,
  joinHarnessVideoChannel: async () => noStatus,
  leaveVoiceChannel: async () => noStatus,
  setVoiceMuted: () => {},
  pushMicFrame: () => {},
  pushVideoFrame: () => {},
  setVideoCameraOn: () => {},
  voiceStatus: () => noStatus,
  onMixedFrame: () => () => {},
  onPeerVideoFrame: () => () => {},
  onVoiceStatusChanged: () => () => {},
}));

import {
  startLocalVoiceSocket,
  stopLocalVoiceSocket,
  setOperatorVoiceSession,
  broadcastOpVoice,
} from './local-audio-socket';
import type { OperatorVoiceSession } from './operator-voice-session';

type Call =
  | ['hello', string, string]
  | ['mic', string, number[]]
  | ['control', string, unknown]
  | ['gone', string];

function makeSpy(): { spy: OperatorVoiceSession; calls: Call[] } {
  const calls: Call[] = [];
  const spy = {
    handleHello: (id: string, kind: string) => calls.push(['hello', id, kind]),
    handleMic: (id: string, pcm: Uint8Array) => calls.push(['mic', id, Array.from(pcm)]),
    handleControl: (id: string, control: unknown) => calls.push(['control', id, control]),
    handleClientGone: (id: string) => calls.push(['gone', id]),
  } as unknown as OperatorVoiceSession;
  return { spy, calls };
}

const waitFor = async (pred: () => boolean, ms = 1500): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
};

const ORIG_HOME = process.env.HOME;
beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'opv-routing-'));
});
afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});
afterEach(() => {
  stopLocalVoiceSocket();
  setOperatorVoiceSession(null);
});

describe('operator-voice bus routing (P-003/P-004)', () => {
  it('routes HELLO → MIC → CONTROL to the host with the client id', async () => {
    const { spy, calls } = makeSpy();
    setOperatorVoiceSession(spy);
    const { socketPath } = startLocalVoiceSocket();
    const client = connect(socketPath);
    await new Promise<void>((r) => client.once('connect', () => r()));

    client.write(encodeHello({ clientId: 'tab-1', clientKind: 'desktop' }));
    await waitFor(() => calls.some((c) => c[0] === 'hello'));
    expect(calls.find((c) => c[0] === 'hello')).toEqual(['hello', 'tab-1', 'desktop']);

    client.write(encodeMic(new Uint8Array([1, 2, 3, 4])));
    await waitFor(() => calls.some((c) => c[0] === 'mic'));
    expect(calls.find((c) => c[0] === 'mic')).toEqual(['mic', 'tab-1', [1, 2, 3, 4]]);

    client.write(encodeControl({ op: 'mute', muted: true }));
    await waitFor(() => calls.some((c) => c[0] === 'control'));
    expect(calls.find((c) => c[0] === 'control')).toEqual(['control', 'tab-1', { op: 'mute', muted: true }]);

    client.destroy();
  });

  it('fans broadcastOpVoice frames out to every attached client', async () => {
    const { spy, calls } = makeSpy();
    setOperatorVoiceSession(spy);
    const { socketPath } = startLocalVoiceSocket();
    const client = connect(socketPath);
    await new Promise<void>((r) => client.once('connect', () => r()));

    const received: OpVoiceMessage[] = [];
    const dec = new FrameDecoder();
    client.on('data', (buf: Buffer) => {
      for (const f of dec.push(new Uint8Array(buf))) {
        if (isOpVoiceFrameType(f.type)) {
          const m = decodeOpVoiceFrame(f);
          if (m) received.push(m);
        }
      }
    });

    // Attach (so the socket joins the opvoice client set) before broadcasting.
    client.write(encodeHello({ clientId: 'tab-1', clientKind: 'desktop' }));
    await waitFor(() => calls.some((c) => c[0] === 'hello'));

    broadcastOpVoice(
      encodeSessionState({ status: 'idle', muted: false, mode: 'always-on', playerId: 'tab-1', conversationId: null }),
    );
    await waitFor(() => received.some((m) => m.kind === 'session_state'));
    expect(received.find((m) => m.kind === 'session_state')).toMatchObject({
      kind: 'session_state',
      status: 'idle',
      playerId: 'tab-1',
    });

    client.destroy();
  });

  it('notifies the host when an attached client disconnects', async () => {
    const { spy, calls } = makeSpy();
    setOperatorVoiceSession(spy);
    const { socketPath } = startLocalVoiceSocket();
    const client = connect(socketPath);
    await new Promise<void>((r) => client.once('connect', () => r()));

    client.write(encodeHello({ clientId: 'tab-9', clientKind: 'tui' }));
    await waitFor(() => calls.some((c) => c[0] === 'hello'));

    client.destroy();
    await waitFor(() => calls.some((c) => c[0] === 'gone'));
    expect(calls.find((c) => c[0] === 'gone')).toEqual(['gone', 'tab-9']);
  });

  it('ignores opvoice frames when no host is attached (no throw)', async () => {
    setOperatorVoiceSession(null);
    const { socketPath } = startLocalVoiceSocket();
    const client = connect(socketPath);
    await new Promise<void>((r) => client.once('connect', () => r()));
    client.write(encodeHello({ clientId: 'x', clientKind: 'desktop' }));
    // Give it a beat; the server must not crash on an unrouted frame.
    await new Promise((r) => setTimeout(r, 30));
    expect(client.destroyed).toBe(false);
    client.destroy();
  });
});
