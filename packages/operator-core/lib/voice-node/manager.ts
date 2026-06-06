/**
 * Voice-node manager — the operator-side singleton wiring @papercusp/p2p-voice
 * to real infrastructure (plan holepunch-voice-channels-2026-06-05 P-006).
 *
 * Swarm: a DEDICATED lazy Hyperswarm instance (not the shared hyperbee swarm).
 * Rationale (amends D-011 as recorded in the plan): voice frames on the shared
 * swarm would multiplex via Protomux next to corestore replication bursts —
 * poor isolation for real-time audio — and the spike validated exactly the
 * dedicated-swarm + raw-stream-framing shape. Peer gating is the channel
 * topic + hello handshake.
 *
 * Listeners (mixed frames / peer events) are held HERE and survive channel
 * switches — the local audio socket and the agent peer subscribe once.
 *
 * Encryption (P-013): the operator↔operator media path is end-to-end encrypted
 * by construction. `ensureNode` injects ONLY the real Hyperswarm (below), and
 * every Hyperswarm connection is a `NoiseSecretStream` (X25519 Noise handshake
 * over HyperDHT) — there is no plaintext-transport code path in production; the
 * identity/plaintext `SwarmLike` exists solely as a test stub. So every CTRL +
 * AUDIO frame written to a peer `conn` rides the Noise stream. This was measured
 * empirically by the P-001 spike (`libs/holepunch-spike/voice/RESULTS.md`:
 * "Noise-encrypted UDX stream"). The local operator↔client leg is a same-host
 * unix socket (`local-audio-socket`, loopback — never network-exposed).
 */
import { hostname, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  createVoiceNode,
  type ChannelHandle,
  type SwarmLike,
  type VoiceNode,
  type VoicePeerState,
} from '@papercusp/p2p-voice';
import { getOpusCodec, VOICE_FRAME_SAMPLES } from './codec';
import { resolveVoiceChannel, type VoiceChannel } from './registry';
import { swarmConstructorOpts } from '../sync/hyperbee/swarm';

export interface VoiceStatus {
  channel: VoiceChannel | null;
  muted: boolean;
  peers: VoicePeerState[];
  identity: { id: string; label: string };
  /** True while the local agent brain is speaking a reply (P-011 indicator). */
  agentSpeaking: boolean;
}

interface VoiceSwarmLike extends SwarmLike {
  destroy(): Promise<void>;
}

const identity = {
  id: `${hostname()}-${randomBytes(3).toString('hex')}`,
  label: `${(() => {
    try {
      return userInfo().username;
    } catch {
      return 'operator';
    }
  })()}@${hostname()}`,
};

let swarm: VoiceSwarmLike | null = null;
let node: VoiceNode | null = null;
let handle: ChannelHandle | null = null;
let channel: VoiceChannel | null = null;
let agentSpeaking = false;

const mixedCbs = new Set<(frame: Int16Array) => void>();
const peerFrameCbs = new Set<(peerId: string, frame: Int16Array) => void>();
const peerVideoCbs = new Set<(peerId: string, payload: Uint8Array) => void>();
const changedCbs = new Set<(status: VoiceStatus) => void>();
const handleUnsubs: Array<() => void> = [];

async function ensureNode(): Promise<VoiceNode> {
  if (node) return node;
  const mod = (await import('hyperswarm')) as { default: new (opts?: unknown) => VoiceSwarmLike };
  swarm = new mod.default(swarmConstructorOpts());
  const codec = await getOpusCodec();
  node = createVoiceNode({ swarm, codec, identity });
  return node;
}

export function voiceStatus(): VoiceStatus {
  return {
    channel,
    muted: handle?.muted ?? false,
    peers: handle?.peers() ?? [],
    identity,
    agentSpeaking,
  };
}

/**
 * The agent brain reports its speaking state here (P-011) so it rides the same
 * status push to every voice client. Kept on the manager (not the brain) to
 * avoid an import cycle — the brain imports the manager, never the reverse.
 */
export function setVoiceAgentSpeaking(speaking: boolean): void {
  if (agentSpeaking === speaking) return;
  agentSpeaking = speaking;
  emitChanged();
}

function emitChanged(): void {
  const s = voiceStatus();
  for (const cb of changedCbs) cb(s);
}

export async function joinVoiceChannel(idOrName: string): Promise<VoiceStatus> {
  const target = await resolveVoiceChannel(idOrName);
  if (!target) throw new Error(`voice: unknown channel "${idOrName}" — create it via voice:channels first`);
  if (channel?.id === target.id && handle) return voiceStatus();
  await leaveVoiceChannel();
  const n = await ensureNode();
  const h = n.joinChannel(target.topicHex);
  handle = h;
  channel = target;
  handleUnsubs.push(
    h.onMixedFrame((frame) => {
      for (const cb of mixedCbs) cb(frame);
    }),
    h.onPeerFrame((peerId, frame) => {
      for (const cb of peerFrameCbs) cb(peerId, frame);
    }),
    h.onPeerVideoFrame((peerId, payload) => {
      for (const cb of peerVideoCbs) cb(peerId, payload);
    }),
    h.onPeersChanged(() => emitChanged()),
  );
  emitChanged();
  return voiceStatus();
}

export async function leaveVoiceChannel(): Promise<VoiceStatus> {
  if (handle) {
    for (const un of handleUnsubs.splice(0)) un();
    const h = handle;
    handle = null;
    channel = null;
    await h.leave();
    emitChanged();
  }
  return voiceStatus();
}

/** Push one local mic frame (PCM16, VOICE_FRAME_SAMPLES samples). */
export function pushMicFrame(frame: Int16Array): void {
  handle?.pushMic(frame);
}

/**
 * Push one local encoded VIDEO frame (opaque `[1B flags][8B ts][chunk]` bytes
 * from the webview's WebCodecs encoder) → fanned per-peer (plan
 * holepunch-video-shared-harnesses-2026-06-05 P-003). The operator never decodes
 * it; the codec lives in the webview (D-002/D-007).
 */
export function pushVideoFrame(payload: Uint8Array): void {
  handle?.pushVideo(payload);
}

export function setVoiceMuted(muted: boolean): void {
  handle?.setMuted(muted);
  emitChanged();
}

/** Announce the local camera on/off state to channel peers (in-band, D-008). */
export function setVideoCameraOn(on: boolean): void {
  handle?.setCameraOn(on);
  emitChanged();
}

/** Subscribe to the N-peer mix (local playback feed). Survives channel switches. */
export function onMixedFrame(cb: (frame: Int16Array) => void): () => void {
  mixedCbs.add(cb);
  return () => mixedCbs.delete(cb);
}

/** Subscribe to per-peer decoded frames (the agent/STT tap, D-007). */
export function onPeerFrame(cb: (peerId: string, frame: Int16Array) => void): () => void {
  peerFrameCbs.add(cb);
  return () => peerFrameCbs.delete(cb);
}

/**
 * Subscribe to per-peer inbound VIDEO frames (opaque encoded payload, tagged
 * with the sender peer id). The local voice socket fans these to opted-in
 * desktop clients as VID frames. Survives channel switches.
 */
export function onPeerVideoFrame(cb: (peerId: string, payload: Uint8Array) => void): () => void {
  peerVideoCbs.add(cb);
  return () => peerVideoCbs.delete(cb);
}

export function onVoiceStatusChanged(cb: (status: VoiceStatus) => void): () => void {
  changedCbs.add(cb);
  return () => changedCbs.delete(cb);
}

export const VOICE_MIC_FRAME_SAMPLES = VOICE_FRAME_SAMPLES;

/** Full teardown (tests + graceful shutdown). */
export async function destroyVoiceNode(): Promise<void> {
  await leaveVoiceChannel();
  if (node) {
    await node.destroy();
    node = null;
  }
  if (swarm) {
    try {
      await swarm.destroy();
    } catch {
      /* socket already gone */
    }
    swarm = null;
  }
}
