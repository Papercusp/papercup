/**
 * Multi-client shared-session E2E (universal-voice-interface-2026-06-05, P-011 —
 * the automatable half). Stands up the REAL local-audio-socket + a REAL
 * `OperatorVoiceSession` (with a FAKE EL endpoint + brain/persist/lease so no
 * ElevenLabs credits or audio hardware are touched), connects TWO real client
 * sockets (a desktop + a tui), and proves the Model-A contract end to end:
 *
 *   • both clients attach to ONE session and BOTH receive the input transcript,
 *     the response audio, the response transcript, and session state;
 *   • exactly ONE client is the elected player at a time (a plain 2nd `start`
 *     does NOT steal; `force-host` does);
 *   • a control from EITHER client applies once and broadcasts to both;
 *   • the host persists each turn exactly ONCE (sole writer, D-005/P-010);
 *   • closing the PLAYER re-elects the surviving client — the session and the
 *     other client survive (P-011).
 *
 * The remaining P-011 surface — a live run with real EL + real mic/speaker on
 * the two GUIs — is the supervised-audio step that needs the owner's box; this
 * proves the integration logic deterministically without it.
 *
 * HOME is redirected to a tmp dir so the discovery file + socket never touch the
 * live operator's ~/.papercusp.
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
  decodeOpVoiceFrame,
  isOpVoiceFrameType,
  type OpVoiceMessage,
  type SessionStateMsg,
} from './operator-voice-bus';
import type {
  OperatorVoiceSessionDeps,
  ElConnectHandlers,
  ElSocket,
} from './operator-voice-session';

// Keep the P2P channel infra (hyperswarm) out — only OPV routing is exercised.
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

// ── fake EL endpoint the host connects to ─────────────────────────────────
interface FakeEl {
  handlers: ElConnectHandlers | null;
  sent: string[];
}
const el: FakeEl = { handlers: null, sent: [] };
const persisted: Array<{ role: string; text: string }> = [];
const leaseClaims: Array<{ playerId: string; force: boolean }> = [];
const leaseReleases: string[] = [];

function makeDeps(): OperatorVoiceSessionDeps {
  return {
    resolveConfig: async () => ({ ok: true, config: { signedUrl: 'wss://fake', overrides: null, dynamicVariables: {} } }),
    connect: async (_url: string, handlers: ElConnectHandlers): Promise<ElSocket> => {
      el.handlers = handlers;
      return { send: (t: string) => el.sent.push(t), close: () => {} };
    },
    askOperator: async () => 'all systems green',
    loadConversationId: async () => 'conv_1',
    persistTurn: async (role, text) => {
      persisted.push({ role, text });
    },
    parseUtterance: (raw) => ({ say: raw.replace(/<[^>]+>/g, '').trim() || null, setMode: null }),
    claimLease: async (playerId, _kind, force) => {
      leaseClaims.push({ playerId, force });
      return true;
    },
    releaseLease: async (playerId) => {
      leaseReleases.push(playerId);
    },
    broadcast: (frame) => broadcastOpVoice(frame),
  };
}

// ── a decoding test client over the real socket ───────────────────────────
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

// EL server-event shorthands
const elInit = () =>
  JSON.stringify({
    type: 'conversation_initiation_metadata',
    conversation_initiation_metadata_event: { conversation_id: 'el_conv_1', agent_output_audio_format: 'pcm_16000' },
  });
const elUserTranscript = (t: string) => JSON.stringify({ type: 'user_transcript', user_transcription_event: { user_transcript: t } });
const elAgentResponse = (t: string) => JSON.stringify({ type: 'agent_response', agent_response_event: { agent_response: t } });
const elAudio = (b64: string) => JSON.stringify({ type: 'audio', audio_event: { audio_base_64: b64 } });

const ORIG_HOME = process.env.HOME;
let session: OperatorVoiceSession;

beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'opv-mc-'));
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
  persisted.length = 0;
  leaseClaims.length = 0;
  leaseReleases.length = 0;
});

describe('universal voice — two surfaces, one session (P-011)', () => {
  it('both clients share ONE session: both receive input + response, exactly one plays', async () => {
    session = new OperatorVoiceSession(makeDeps());
    setOperatorVoiceSession(session);
    const { socketPath } = startLocalVoiceSocket();

    const desktop = await client(socketPath); // will become player
    const tui = await client(socketPath);

    // Desktop attaches + starts → it becomes the elected player and the host
    // opens the (fake) EL session.
    desktop.sock.write(encodeHello({ clientId: 'desktop-1', clientKind: 'desktop' }));
    desktop.sock.write(encodeControl({ op: 'start' }));
    await waitFor(() => el.handlers !== null);
    el.handlers!.onText(elInit());

    // tui attaches + sends a PLAIN start → it must NOT steal the player role.
    tui.sock.write(encodeHello({ clientId: 'tui-1', clientKind: 'tui' }));
    tui.sock.write(encodeControl({ op: 'start' }));
    await waitFor(() => desktop.state()?.status === 'idle' && tui.state() !== undefined);

    expect(desktop.state()?.playerId).toBe('desktop-1');
    expect(tui.state()?.playerId).toBe('desktop-1'); // tui sees desktop as player (display-only)
    expect(desktop.state()?.conversationId).toBe('conv_1');

    // User speaks once → BOTH surfaces get the input transcript; host persists once.
    el.handlers!.onText(elUserTranscript('how is the fleet'));
    await waitFor(() =>
      desktop.recv.some((m) => m.kind === 'input_transcript') && tui.recv.some((m) => m.kind === 'input_transcript'),
    );
    expect(desktop.recv.find((m) => m.kind === 'input_transcript')).toMatchObject({ text: 'how is the fleet', final: true });
    expect(tui.recv.find((m) => m.kind === 'input_transcript')).toMatchObject({ text: 'how is the fleet' });

    // EL responds once: audio + transcript → BOTH receive both frames.
    el.handlers!.onText(elAudio(Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64')));
    el.handlers!.onText(elAgentResponse('<say>all green</say>'));
    await waitFor(
      () =>
        desktop.recv.some((m) => m.kind === 'response_audio') &&
        tui.recv.some((m) => m.kind === 'response_audio') &&
        desktop.recv.some((m) => m.kind === 'response_transcript') &&
        tui.recv.some((m) => m.kind === 'response_transcript'),
    );
    // Persist-once (P-010): exactly one user + one assistant turn recorded by the host.
    expect(persisted.filter((p) => p.role === 'user')).toHaveLength(1);
    expect(persisted.filter((p) => p.role === 'assistant')).toHaveLength(1);

    desktop.sock.destroy();
    tui.sock.destroy();
  });

  it('a control from either client applies once and broadcasts to both', async () => {
    session = new OperatorVoiceSession(makeDeps());
    setOperatorVoiceSession(session);
    const { socketPath } = startLocalVoiceSocket();
    const desktop = await client(socketPath);
    const tui = await client(socketPath);

    desktop.sock.write(encodeHello({ clientId: 'desktop-1', clientKind: 'desktop' }));
    desktop.sock.write(encodeControl({ op: 'start' }));
    await waitFor(() => el.handlers !== null);
    el.handlers!.onText(elInit());
    tui.sock.write(encodeHello({ clientId: 'tui-1', clientKind: 'tui' }));
    await waitFor(() => tui.state() !== undefined);

    // tui mutes → host applies once, both surfaces see muted=true.
    tui.sock.write(encodeControl({ op: 'mute', muted: true }));
    await waitFor(() => desktop.state()?.muted === true && tui.state()?.muted === true);
    expect(desktop.state()?.muted).toBe(true);

    desktop.sock.destroy();
    tui.sock.destroy();
  });

  it('force-host flips the player; closing the player re-elects the survivor (session survives)', async () => {
    session = new OperatorVoiceSession(makeDeps());
    setOperatorVoiceSession(session);
    const { socketPath } = startLocalVoiceSocket();
    const desktop = await client(socketPath);
    const tui = await client(socketPath);

    desktop.sock.write(encodeHello({ clientId: 'desktop-1', clientKind: 'desktop' }));
    desktop.sock.write(encodeControl({ op: 'start' }));
    await waitFor(() => el.handlers !== null);
    el.handlers!.onText(elInit());
    tui.sock.write(encodeHello({ clientId: 'tui-1', clientKind: 'tui' }));
    await waitFor(() => tui.state()?.playerId === 'desktop-1');

    // tui force-hosts → it takes the player role; both see playerId flip.
    tui.sock.write(encodeControl({ op: 'force-host' }));
    await waitFor(() => desktop.state()?.playerId === 'tui-1' && tui.state()?.playerId === 'tui-1');

    // Close the PLAYER (tui). The host re-elects the surviving desktop client —
    // the session stays live and desktop becomes the player (P-011 survival).
    tui.sock.destroy();
    await waitFor(() => desktop.state()?.playerId === 'desktop-1');
    expect(desktop.state()?.status).not.toBe('off'); // session survived the player leaving
    expect(desktop.state()?.status).not.toBe('ended');

    desktop.sock.destroy();
  });
});
