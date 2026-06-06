/**
 * Synthetic-voice E2E (universal-voice-interface-2026-06-05, P-011 — the
 * autonomous audio half). The supervised P-011 step needs a human + real mic +
 * real EL; this drives the SAME live path with **synthetic voice audio** and a
 * deterministic fake EL, so the actual audio BYTE path is exercised end-to-end
 * with no hardware, no EL credits, and no flakiness.
 *
 * It covers what the bus/event tests don't — the real audio bytes both ways
 * over the real socket + real `OperatorVoiceSession`:
 *   • a player streams synthetic mic PCM → the host forwards the EXACT bytes to
 *     EL as `user_audio_chunk` (base64), preserving arbitrary chunking;
 *   • EL's synthetic response audio fans out to BOTH surfaces verbatim;
 *   • a NON-player's mic is dropped at the host (single mic capture, P-007).
 *
 * HOME is redirected so the discovery file + socket never touch the live
 * operator's ~/.papercusp.
 */
import { connect, type Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  encodeHello,
  encodeControl,
  encodeMic,
  decodeOpVoiceFrame,
  isOpVoiceFrameType,
  type OpVoiceMessage,
  type SessionStateMsg,
} from './operator-voice-bus';
import type { OperatorVoiceSessionDeps, ElConnectHandlers, ElSocket } from './operator-voice-session';

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

import { startLocalVoiceSocket, stopLocalVoiceSocket, setOperatorVoiceSession, broadcastOpVoice } from './local-audio-socket';
import { OperatorVoiceSession } from './operator-voice-session';

// ── synthetic voice: a deterministic, speech-shaped PCM16 LE @16 kHz signal ──
// (~4 Hz syllable envelope × a ~140 Hz voiced fundamental + a formant). Not real
// words — EL is faked — but a non-trivial waveform that must round-trip exactly.
function synthVoicePcm16(nSamples: number): Uint8Array {
  const buf = new Uint8Array(nSamples * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < nSamples; i++) {
    const t = i / 16000;
    const env = 0.5 * (1 - Math.cos(2 * Math.PI * 4 * t)); // syllable envelope 0..1
    const voiced = Math.sin(2 * Math.PI * 140 * t) + 0.4 * Math.sin(2 * Math.PI * 700 * t);
    const s = Math.max(-1, Math.min(1, 0.4 * env * voiced));
    view.setInt16(i * 2, Math.round(s * 32767), true);
  }
  return buf;
}
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ── fake EL endpoint ───────────────────────────────────────────────────────
interface FakeEl {
  handlers: ElConnectHandlers | null;
  sent: string[];
}
const el: FakeEl = { handlers: null, sent: [] };

/** Concatenated bytes of every `user_audio_chunk` the host forwarded to EL. */
function elReceivedMicBytes(): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const s of el.sent) {
    try {
      const m = JSON.parse(s) as { user_audio_chunk?: string };
      if (typeof m.user_audio_chunk === 'string') chunks.push(new Uint8Array(Buffer.from(m.user_audio_chunk, 'base64')));
    } catch {
      /* non-audio EL message */
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function makeDeps(): OperatorVoiceSessionDeps {
  return {
    resolveConfig: async () => ({ ok: true, config: { signedUrl: 'wss://fake', overrides: null, dynamicVariables: {} } }),
    connect: async (_url: string, handlers: ElConnectHandlers): Promise<ElSocket> => {
      el.handlers = handlers;
      return { send: (t: string) => el.sent.push(t), close: () => {} };
    },
    askOperator: async () => 'ack',
    loadConversationId: async () => 'conv_1',
    persistTurn: async () => {},
    parseUtterance: (raw) => ({ say: raw.replace(/<[^>]+>/g, '').trim() || null, setMode: null }),
    claimLease: async () => true,
    releaseLease: async () => {},
    broadcast: (frame) => broadcastOpVoice(frame),
  };
}

// ── decoding test client ─────────────────────────────────────────────────
interface Client {
  sock: Socket;
  recv: OpVoiceMessage[];
  state(): SessionStateMsg | undefined;
}
function client(path: string): Promise<Client> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const recv: OpVoiceMessage[] = [];
    const dec = new FrameDecoder();
    sock.on('data', (buf: Buffer) => {
      for (const f of dec.push(new Uint8Array(buf))) {
        if (isOpVoiceFrameType(f.type)) {
          const m = decodeOpVoiceFrame(f);
          if (m) recv.push(m);
        }
      }
    });
    sock.once('connect', () =>
      resolve({
        sock,
        recv,
        state: () => [...recv].reverse().find((m): m is SessionStateMsg => m.kind === 'session_state'),
      }),
    );
  });
}
const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
};
const elInit = () =>
  JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: { conversation_id: 'el_conv_1', agent_output_audio_format: 'pcm_16000' },
  });
const elAudio = (bytes: Uint8Array) => JSON.stringify({ type: 'audio', audio_event: { audio_base_64: b64(bytes) } });
const elTranscript = (t: string) => JSON.stringify({ type: 'user_transcript', user_transcription_event: { user_transcript: t } });

const ORIG_HOME = process.env.HOME;
beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'opv-synth-'));
});
afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});
afterEach(() => {
  stopLocalVoiceSocket();
  setOperatorVoiceSession(null);
  el.handlers = null;
  el.sent.length = 0;
});

async function bringUpPlayerSession(socketPath: string): Promise<{ desktop: Client; tui: Client }> {
  const desktop = await client(socketPath);
  const tui = await client(socketPath);
  desktop.sock.write(encodeHello({ clientId: 'desktop-1', clientKind: 'desktop' }));
  desktop.sock.write(encodeControl({ op: 'start' }));
  await waitFor(() => el.handlers !== null);
  el.handlers!.onText(elInit());
  tui.sock.write(encodeHello({ clientId: 'tui-1', clientKind: 'tui' }));
  await waitFor(() => desktop.state()?.status === 'idle' && tui.state()?.playerId === 'desktop-1');
  return { desktop, tui };
}

describe('synthetic-voice E2E — real socket + host, fake EL, no hardware (P-011)', () => {
  it('streams synthetic mic audio → host forwards the EXACT bytes to EL (chunking preserved)', async () => {
    setOperatorVoiceSession(new OperatorVoiceSession(makeDeps()));
    const { socketPath } = startLocalVoiceSocket();
    const { desktop } = await bringUpPlayerSession(socketPath);

    // 300 ms of synthetic voice, streamed as THREE odd-sized mic frames.
    const speech = synthVoicePcm16(4800); // 16k * 0.3s
    const cut1 = 1234 * 2; // arbitrary odd byte boundaries (keep 16-bit alignment)
    const cut2 = 3001 * 2;
    desktop.sock.write(encodeMic(speech.subarray(0, cut1)));
    desktop.sock.write(encodeMic(speech.subarray(cut1, cut2)));
    desktop.sock.write(encodeMic(speech.subarray(cut2)));

    await waitFor(() => elReceivedMicBytes().length >= speech.length);
    // EL got the synthetic audio byte-for-byte (host = transparent mic pipe).
    expect(Array.from(elReceivedMicBytes())).toEqual(Array.from(speech));
    desktop.sock.destroy();
  });

  it('EL synthetic response audio fans out to BOTH surfaces verbatim', async () => {
    setOperatorVoiceSession(new OperatorVoiceSession(makeDeps()));
    const { socketPath } = startLocalVoiceSocket();
    const { desktop, tui } = await bringUpPlayerSession(socketPath);

    // The "spoken" response: a distinct synthetic waveform.
    const responsePcm = synthVoicePcm16(1600); // 100 ms
    el.handlers!.onText(elTranscript('synthetic question'));
    el.handlers!.onText(elAudio(responsePcm));
    el.handlers!.onText(
      JSON.stringify({ type: 'agent_response', agent_response_event: { agent_response: '<say>synthetic answer</say>' } }),
    );

    await waitFor(
      () => desktop.recv.some((m) => m.kind === 'response_audio') && tui.recv.some((m) => m.kind === 'response_audio'),
    );
    for (const c of [desktop, tui]) {
      const audio = c.recv.find((m) => m.kind === 'response_audio');
      expect(audio).toBeTruthy();
      if (audio?.kind === 'response_audio') {
        expect(audio.format).toBe('pcm_s16le');
        expect(audio.sampleRate).toBe(16000);
        expect(Array.from(audio.audio)).toEqual(Array.from(responsePcm)); // exact synthetic bytes
      }
      // both surfaces also see the input + response transcript
      expect(c.recv.some((m) => m.kind === 'input_transcript' && m.text === 'synthetic question')).toBe(true);
      expect(c.recv.some((m) => m.kind === 'response_transcript')).toBe(true);
    }
    desktop.sock.destroy();
    tui.sock.destroy();
  });

  it('drops a NON-player surface’s mic — single capture (P-007)', async () => {
    setOperatorVoiceSession(new OperatorVoiceSession(makeDeps()));
    const { socketPath } = startLocalVoiceSocket();
    const { desktop, tui } = await bringUpPlayerSession(socketPath);

    // tui is NOT the player → its synthetic mic must never reach EL.
    tui.sock.write(encodeMic(synthVoicePcm16(800)));
    // desktop (player) DOES reach EL.
    const fromPlayer = synthVoicePcm16(800);
    desktop.sock.write(encodeMic(fromPlayer));

    await waitFor(() => elReceivedMicBytes().length >= fromPlayer.length);
    // EL got exactly the player's audio — nothing from the non-player.
    expect(Array.from(elReceivedMicBytes())).toEqual(Array.from(fromPlayer));
    desktop.sock.destroy();
    tui.sock.destroy();
  });
});
