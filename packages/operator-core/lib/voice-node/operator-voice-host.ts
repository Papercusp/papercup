/**
 * Operator-voice host wiring (universal-voice-interface-2026-06-05, P-002/3/4).
 *
 * Constructs the singleton `OperatorVoiceSession` with its production deps and
 * attaches it to the local-audio-socket bus (so the socket routes inbound
 * HELLO/MIC/CONTROL to it and fans its outbound frames to every attached
 * client), then keeps the elected player's voice-lease warm on a heartbeat.
 * Called once from the operator bootstrap, right after the voice socket + the
 * desktop WS bridge are up.
 */
import { startLocalVoiceSocket, broadcastOpVoice, setOperatorVoiceSession } from './local-audio-socket';
import { OperatorVoiceSession } from './operator-voice-session';
import { createOperatorVoiceSessionDeps } from './operator-voice-session-deps';

/** Re-claim the elected player's lease well under its 12s TTL. */
const LEASE_HEARTBEAT_MS = 5_000;

let started = false;
let session: OperatorVoiceSession | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

export function startOperatorVoiceHost(): void {
  if (started) return;
  started = true;
  // The bus transport must exist before clients can attach (idempotent — the
  // bootstrap also starts it for the P2P channel path).
  startLocalVoiceSocket();
  session = new OperatorVoiceSession(createOperatorVoiceSessionDeps(broadcastOpVoice));
  setOperatorVoiceSession(session);
  heartbeat = setInterval(() => {
    void session?.heartbeat();
  }, LEASE_HEARTBEAT_MS);
  // Never hold the process open just for the heartbeat.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  console.log('[voice-host] operator voice session host attached to the bus');
}

export async function stopOperatorVoiceHost(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  setOperatorVoiceSession(null);
  if (session) {
    await session.stop().catch(() => {});
    session = null;
  }
  started = false;
}
