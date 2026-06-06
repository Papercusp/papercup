/**
 * Browser-side voice mode runtime.
 *
 * Uses the Web Speech API (SpeechRecognition + SpeechSynthesis) — no
 * server roundtrip, no external dependencies.
 *
 * Capabilities:
 *   - STT (push-to-talk + always-on with wake word)
 *   - TTS with per-role voice assignment (consistent across harnesses)
 *   - Single-utterance-at-a-time queue (only the in-focus speaker plays)
 *   - Barge-in: user starting to speak interrupts current utterance
 *   - Wake-word detection ("hey papercup") for always-on mode
 *
 * The voice runtime is a singleton initialized once in the operator
 * shell. Components subscribe via `subscribeVoiceState()` and dispatch
 * via the public methods.
 */

import { stripWakeWordAndPrefix } from '@papercusp/operator-core/lib/wake-word';
import { getBrowserWorkspaceId, wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { createOperatorVoiceTagObserver } from '@papercusp/operator-core/lib/operator-converse-voice';
import { persistOperatorVoiceTurn } from '@papercusp/operator-core/lib/operator-conversation-client';
import { startDesktopOperatorVoice, type OperatorVoiceRuntime } from './operator-voice-runtime';
// Statically imported — neither sibling imports voice-mode, so there is no
// cycle. (Were CJS require()s, which are undefined in the Vite browser bundle.)
import { loadVoicePrefsClient } from './voice-prefs-client';
import { requestVoiceLead, getVoiceLeaderState } from './voice-leader';
// Static-imported (not dynamic): these are small, dependency-light modules,
// and dynamic import() of them was intermittently HANGING in the operator-vite
// build — which left PTT capture never starting → "No audio detected". The
// heavy/optional engines (stt-voicemode's MicVAD, deepgram) stay dynamic below.
import {
  startPttRawCapture,
  classifyPttResult,
  resampleLinearTo16k,
  isBlankTranscript,
  type PttRawCapture,
  type PttRawCaptureResult,
} from './ptt-capture';
import { f32ToWav } from './f32-to-wav';
import { transcribeChunk } from '@papercusp/operator-core/lib/voice-engines/whisper';
import { startEnergyVadCapture } from './energy-vad-capture';

/**
 * Emit the voice-engagement signal the OperatorConversationProvider
 * listens for. Provider lives in the React tree; voice-mode is the
 * imperative singleton outside it. Window event is the right seam.
 *
 * Plan's "engagement detection in passive: user voice utterance with
 * address=operator → engagement" — wired here, end-to-end. The voice
 * engines (EL Conv AI, OpenAI Realtime) all gate STT behind either
 * wake-word (always-on mode) or PTT (user-initiated), so every
 * transcript that lands here is implicitly addressed to the operator;
 * no further address filtering is required. C3 of the audit.
 *
 * Timestamp is captured at emit time (the moment STT finalizes the
 * transcript), not at provider receive time, so a slow React queue
 * doesn't shift the engagement window. C1 of the audit.
 */
function emitOperatorUserTurn(text: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = text?.trim();
  if (!trimmed) return;
  const tsMs = Date.now();
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:operatorUserTurn', {
        detail: { text: trimmed, source: 'voice_stt', tsMs },
      }),
    );
  } catch { /* ignore */ }
}

export type VoiceModeStatus =
  | 'off'                    // Voice mode disabled
  | 'connecting'             // Bringing up full-agent session (EL/Realtime negotiating)
  | 'idle'                   // Listening for wake word (or idle in PTT)
  | 'listening'              // Actively recording user speech
  | 'speaking'               // Reading agent text
  | 'paused';                // User-paused

export type VoiceMode = 'off' | 'push-to-talk' | 'always-on';

export interface VoiceState {
  mode: VoiceMode;
  status: VoiceModeStatus;
  /** True if voice mode can run at all (any engine path is viable). */
  supported: boolean;
  /** True if the browser provides Web Speech STT (used by wake-word + PTT). */
  hasWebSpeechSTT: boolean;
  /** True if the browser provides Web Speech TTS (otherwise route via engine adapters). */
  hasWebSpeechTTS: boolean;
  /** Last transcript text (latest user utterance). */
  lastTranscript: string;
  /** Currently-speaking role (e.g. 'orchestrator', 'operator', 'system:oracle'). */
  speakingRole: string | null;
  /** Pulses true for ~2.5s when a wake word is detected (any engine —
   *  Porcupine, openWakeWord, or string-match in transcript). UI uses
   *  this to flash an amber visual indicator on the voice button. */
  wakeDetected: boolean;
  /** Pulses true for ~2s when the user just finished an utterance the
   *  voice engine accepted (EL Conv AI transcript, Whisper finalized,
   *  Realtime turn end). Distinct from wakeDetected — flashes cyan, not
   *  amber, so the user can tell "wake word fired" from "agent heard
   *  the full utterance". */
  userSpoke: boolean;
  /** True while a full-agent engine (EL Conv AI / OpenAI Realtime) owns
   *  the microphone. Suppresses our local useMicLevel analyser so two
   *  concurrent getUserMedia consumers don't fight for the device —
   *  some browsers serialize this and the second-acquired track
   *  delivers no media, breaking WebRTC negotiation downstream. */
  micOwnedByFullAgent: boolean;
  /** True when the mic is currently picking up audio above the
   *  silence threshold. Drives "Hearing you" visual feedback during
   *  PTT so users can tell apart "button pressed but mic dead" from
   *  "button pressed AND voice being captured". Set by the active
   *  capture engine or by the local useMicLevel analyser. */
  audioReceiving: boolean;
  /** True between stopPushToTalk and the next onUtteranceFinal —
   *  i.e. "you released the button, we're transcribing your audio." */
  processingTranscript: boolean;
  /** True between onUtteranceFinal and status='speaking' (or timeout)
   *  — i.e. "transcript was captured, the agent is preparing a reply." */
  awaitingResponse: boolean;
}

interface VoiceConfig {
  /** Wake word for always-on mode. Default: "hey papercup". */
  wakeWord: string;
  /** Voice assignments by role. Falls back to default voice if missing. */
  roleVoices: Record<string, string>;
  /** Default voice name (browser-specific). */
  defaultVoice: string | null;
  /** Speech rate (0.1 to 10). Default 1.0. */
  rate: number;
  /** Persisted last mode so navigation preserves user's choice. */
  lastMode: VoiceMode;
}

const DEFAULT_CONFIG: VoiceConfig = {
  wakeWord: 'hey papercup',
  roleVoices: {},
  defaultVoice: null,
  rate: 1.0,
  lastMode: 'off',
};

const STORAGE_KEY = 'papercusp.voice.config.v1';

let state: VoiceState = {
  mode: 'off',
  status: 'off',
  supported: false,
  hasWebSpeechSTT: false,
  hasWebSpeechTTS: false,
  lastTranscript: '',
  speakingRole: null,
  wakeDetected: false,
  userSpoke: false,
  micOwnedByFullAgent: false,
  audioReceiving: false,
  processingTranscript: false,
  awaitingResponse: false,
};

/**
 * Set whether the mic is currently picking up audio above the silence
 * threshold. Called by useMicLevel (the visualization analyser) and
 * any engine that exposes input-VAD callbacks. Cheap idempotent write
 * — guarded against redundant setState noise.
 */
export function setAudioReceiving(receiving: boolean): void {
  if (state.audioReceiving === receiving) return;
  setState({ audioReceiving: receiving });
}

/**
 * Last error thrown by the visualization getUserMedia in useMicLevel.
 * Previously swallowed silently, so every capture failure — permission
 * denied, device busy, no device — collapsed into the same opaque "No
 * audio detected" toast. Recording it here lets stopPushToTalk's no-audio
 * branch say something the user can actually act on. A nullish value
 * clears it (called on each successful acquire so stale errors don't leak).
 */
let lastMicError: { name: string; message: string } | null = null;
export function setMicCaptureError(err: unknown): void {
  if (!err) { lastMicError = null; return; }
  const e = err as { name?: string; message?: string };
  lastMicError = { name: e?.name ?? '', message: e?.message ?? String(err) };
}

// Timeouts for the two "stuck" phases. Each phase has a soft warning
// at the end of its timer — clears the phase flag, fires a toast, so
// the user understands "this should have happened by now and didn't"
// rather than staring at a spinning indicator forever.
let processingTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
let awaitingResponseTimer: ReturnType<typeof setTimeout> | null = null;
// Safety net for the optimistic always-on 'connecting' status: if no
// full-agent session (or fallback capture) has materialized shortly after a
// mode change, resolve to a usable state instead of a permanent "Connecting…".
let connectingWatchdog: ReturnType<typeof setTimeout> | null = null;

/**
 * Mark "the user just released PTT — we're transcribing whatever was
 * captured." Auto-clears on transcript final OR after 8s with a toast
 * warning that STT didn't return in time.
 */
function beginProcessingTranscript(): void {
  if (processingTranscriptTimer) clearTimeout(processingTranscriptTimer);
  setState({ processingTranscript: true });
  processingTranscriptTimer = setTimeout(() => {
    processingTranscriptTimer = null;
    if (!state.processingTranscript) return;
    setState({ processingTranscript: false });
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('papercusp:voiceTimeout', {
            detail: { phase: 'transcript', message: 'No transcript received — try speaking again.' },
          }),
        );
      } catch { /* ignore */ }
    }
  }, 8000);
}

function endProcessingTranscript(): void {
  if (processingTranscriptTimer) {
    clearTimeout(processingTranscriptTimer);
    processingTranscriptTimer = null;
  }
  if (state.processingTranscript) setState({ processingTranscript: false });
}

/**
 * Mark "transcript captured — the agent is composing a response."
 * Cleared when status becomes 'speaking' (TTS started) OR after 15s
 * with a toast warning.
 */
function beginAwaitingResponse(): void {
  if (awaitingResponseTimer) clearTimeout(awaitingResponseTimer);
  setState({ awaitingResponse: true });
  awaitingResponseTimer = setTimeout(() => {
    awaitingResponseTimer = null;
    if (!state.awaitingResponse) return;
    setState({ awaitingResponse: false });
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('papercusp:voiceTimeout', {
            detail: { phase: 'response', message: 'Agent did not respond — check connection.' },
          }),
        );
      } catch { /* ignore */ }
    }
  }, 15000);
}

function endAwaitingResponse(): void {
  if (awaitingResponseTimer) {
    clearTimeout(awaitingResponseTimer);
    awaitingResponseTimer = null;
  }
  if (state.awaitingResponse) setState({ awaitingResponse: false });
}

// Pulse the wake-detected flag for ~1.2s. Auto-clears so the visual
// indicator is a flash, not a stuck highlight. Idempotent — re-firing
// while the pulse is active resets the timer (back-to-back wakes still
// produce one continuous flash rather than two flickers).
let wakeDetectedTimer: ReturnType<typeof setTimeout> | null = null;
export function signalWakeDetected(): void {
  if (wakeDetectedTimer) {
    clearTimeout(wakeDetectedTimer);
    wakeDetectedTimer = null;
  }
  setState({ wakeDetected: true });
  wakeDetectedTimer = setTimeout(() => {
    wakeDetectedTimer = null;
    setState({ wakeDetected: false });
  }, 2500);
}

// Pulse the "user-spoke" flag for ~2s. Different state + different
// color from wakeDetected so the user can tell "wake word fired" apart
// from "agent received my full utterance". Used by EL Conv AI's
// onTranscript callback and the legacy Whisper finalized-result path.
let userSpokeTimer: ReturnType<typeof setTimeout> | null = null;
export function pulseUserSpoken(): void {
  if (userSpokeTimer) {
    clearTimeout(userSpokeTimer);
    userSpokeTimer = null;
  }
  setState({ userSpoke: true });
  userSpokeTimer = setTimeout(() => {
    userSpokeTimer = null;
    setState({ userSpoke: false });
  }, 2000);
}

let config: VoiceConfig = { ...DEFAULT_CONFIG };

type Listener = (s: VoiceState) => void;
const listeners = new Set<Listener>();

let recognition: any = null;
// Voice playback queue (defensive limit to prevent runaway accumulation
// from a stuck TTS engine + a chatty caller — e.g. background scanner
// fires while playback is hung). Hard cap drops oldest items beyond MAX.
const SYNTH_QUEUE_MAX = 8;
let synthQueue: Array<{ text: string; role: string }> = [];
let isSynthSpeaking = false;

function notify() {
  for (const l of listeners) l(state);
}

function setState(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  notify();
}

function loadConfig(): VoiceConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
  try {
    const raw = localStorage.getItem(wsLocalKey(STORAGE_KEY));
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(wsLocalKey(STORAGE_KEY), JSON.stringify(config));
  } catch {
    /* storage full / disabled */
  }
}

export function subscribeVoiceState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceState(): VoiceState {
  return state;
}

export function getVoiceConfig(): VoiceConfig {
  return { ...config };
}

export function updateVoiceConfig(patch: Partial<VoiceConfig>): void {
  config = { ...config, ...patch };
  saveConfig();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event('pc-voice-config-changed'));
  }
}

/**
 * Initialize voice runtime. Call once on app load. Idempotent.
 *
 * Restores the user's last mode (persisted in config) so voice mode
 * survives navigation between pages.
 */
export function initVoiceMode(): void {
  if (typeof window === 'undefined') return;
  config = loadConfig();

  // Release the EL/Realtime session immediately on tab close or refresh.
  // Without this, the EL workspace concurrency slot stays held for ~30s
  // server-side, blocking the next page load (and any other tab) from
  // minting a new session. pagehide fires for both close and refresh
  // (beforeunload doesn't fire reliably on mobile / on hidden tabs).
  // .stop() is fire-and-forget — the page is going away.
  const releaseOnUnload = () => {
    if (realtimeSession) {
      try { void realtimeSession.stop(); } catch { /* page is gone, swallow */ }
      realtimeSession = null;
    }
  };
  window.addEventListener('pagehide', releaseOnUnload);
  window.addEventListener('beforeunload', releaseOnUnload);

  // Silence-nudge teardown handoff (plan: silence-nudge-reliability-2026-05-14
  // §C.2). The conversation provider's grace timer fires this when the
  // Ready card has been open unanswered for `silenceNudgeGraceSecs`.
  // Tear down the active EL session + arm wake-word listening (if
  // configured) so the user can resume hands-free. No-op when no
  // session is active.
  window.addEventListener('papercusp:voiceSilenceTeardown', (e) => {
    if (!realtimeSession) return;
    const detail = (e as CustomEvent<{ wakeword?: string | null }>).detail;
    const wakeword = detail?.wakeword || null;
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
    // Restart wake-word listener for hands-free resume. Reuses the
    // same path the generic idle timer takes.
    if (wakeGated && state.mode !== 'off') {
      void startWakeWordGate(wakeGatedPrefsCache).catch(() => {});
    }
    // Handoff cue — gated by pref. Spoken via the standard speak()
    // queue so it lands cleanly even mid-TTS.
    try {
      const prefs = loadVoicePrefsClient();
      if (prefs.speakSessionHandoff !== false && wakeword) {
        const msg = `Going to wake-word listening. Say ${wakeword} when you're ready.`;
        speak(msg, 'system:operator', 'polite');
      }
    } catch { /* prefs unreachable → skip handoff */ }
  });
  // Voice mode is "supported" as long as the runtime can plausibly speak
  // OR transcribe via *some* engine. Web Speech is sufficient but not
  // required — Tauri/WebKitGTK lacks it but Voicemode (local Kokoro +
  // Whisper) covers the same surface, and the cloud engines (ElevenLabs,
  // OpenAI, Cartesia, Deepgram) work via fetch+Audio. So we default to
  // supported in any browser context and let individual code paths gate
  // on the specific API they need.
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const hasWebSpeechSTT = !!SR;
  const hasWebSpeechTTS = !!window.speechSynthesis;
  setState({ supported: true, hasWebSpeechSTT, hasWebSpeechTTS });

  // Defer the network-touching + heavy-import parts of init until the
  // browser has done first paint and is otherwise idle. Without this,
  // mounting the global VoiceButton synchronously triggers:
  //   - fetch /api/agent-mcp/operator-voice-prefs (~tens of ms)
  //   - fetch /api/agent-mcp/operator-elevenlabs-bootstrap (2.4s cold)
  //   - dynamic import of @elevenlabs/client (~3 MB chunk parse)
  //   - WebRTC handshake to the EL workspace
  // …on every page load even for users who don't use voice. Pushing this
  // to requestIdleCallback gets it off the critical path; the visible
  // VoiceButton renders immediately, and the user-perceived "Connecting…"
  // status appears within ~100ms of paint instead of blocking it.
  const runDeferred = () => {
    // Prime the TTS engine cache so the first speak() routes through
    // the user's chosen engine instead of defaulting to Browser TTS.
    void fetchPreferredEngine();

    // Restore last mode from config so navigation preserves user choice.
    // Skip if state.mode is already non-off (init may run again on hot reload).
    if (state.mode === 'off' && config.lastMode !== 'off') {
      setVoiceMode(config.lastMode);
    }
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(runDeferred, { timeout: 1500 });
  } else {
    setTimeout(runDeferred, 50);
  }

  // Pre-populate available voices once they're loaded by the browser.
  // Skip on runtimes without the Web Speech API (Tauri/WebKitGTK has no
  // SpeechSynthesis) — `hasWebSpeechTTS` is set above; cloud engines and
  // local Voicemode handle the speak path on those runtimes.
  if (hasWebSpeechTTS) {
    const populateVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length && !config.defaultVoice) {
        // Prefer en-US voices; fallback to first available.
        const preferred = voices.find((v) => v.lang.startsWith('en-US'));
        config.defaultVoice = (preferred ?? voices[0]).name;
        saveConfig();
      }
    };
    populateVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
  }
}

/**
 * Pick a stable voice for a given role. Same role → same voice across
 * harnesses, sessions, and browser restarts (config persisted to
 * localStorage).
 */
// Per-engine role-voice pools. Hashing the role name into one of these
// gives every role a distinct, stable voice when speaking through a
// cloud / Kokoro engine.
const KOKORO_VOICE_POOL = [
  'af_bella', 'af_nova', 'af_sarah', 'af_sky', 'af_nicole',
  'am_michael', 'am_adam', 'am_echo', 'am_liam', 'am_onyx',
  'bf_alice', 'bf_emma', 'bm_daniel', 'bm_george',
];
const OPENAI_VOICE_POOL = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'];
const ELEVEN_VOICE_POOL = [
  '21m00Tcm4TlvDq8ikWAM', // Rachel
  'AZnzlk1XvdvUeBnXmlld', // Domi
  'EXAVITQu4vr4xnSDxMaL', // Bella
  'TxGEqnHWrfWFTfGW9XjX', // Josh
  'VR6AewLTigWG4xSOukaG', // Arnold
  'pNInz6obpgDQGcFmaJgB', // Adam
];
const CARTESIA_VOICE_POOL = [
  'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop Man
  '79a125e8-cd45-4c13-8a67-188112f4dd22', // British Reading Lady
  '2ee87190-8f84-4925-97da-e52547f9462c', // Child
  'fb26447f-308b-471e-8b00-8e9f04284eb5', // Doctor Mischief
  '156fb8d2-335b-4950-9cb3-a2d33befec77', // Help Desk Man
  '95856005-0332-41b0-935f-352e296aa0df', // Classy British Man
];

function hashRole(role: string): number {
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function voiceForEngineRole(engine: string, role: string): string | null {
  // Per-slug override may exist in voice config (Web Speech style names).
  // For cloud engines we treat the override as opaque and pass it through.
  let baseRole = role;
  const at = role.indexOf('@');
  if (at > 0) baseRole = role.slice(0, at);
  if (config.roleVoices[role]) return config.roleVoices[role];
  if (config.roleVoices[baseRole]) return config.roleVoices[baseRole];

  const h = hashRole(baseRole);
  switch (engine) {
    case 'kokoro':     return KOKORO_VOICE_POOL[h % KOKORO_VOICE_POOL.length];
    case 'openai':     return OPENAI_VOICE_POOL[h % OPENAI_VOICE_POOL.length];
    case 'elevenlabs': return ELEVEN_VOICE_POOL[h % ELEVEN_VOICE_POOL.length];
    case 'cartesia':   return CARTESIA_VOICE_POOL[h % CARTESIA_VOICE_POOL.length];
    default:           return null;
  }
}

function voiceForRole(roleOrComposite: string): string | null {
  // Per-slug override (v4 §2h v1.5): callers may pass `role@slug` to
  // request a slug-specific assignment. Lookup chain:
  //   1. exact `role@slug`     (specific)
  //   2. base `role`           (shared across instances)
  //   3. auto-assign (hashed)
  let role = roleOrComposite;
  let slugKey: string | null = null;
  const at = roleOrComposite.indexOf('@');
  if (at > 0) {
    slugKey = roleOrComposite;
    role = roleOrComposite.slice(0, at);
    if (config.roleVoices[slugKey]) return config.roleVoices[slugKey];
  }
  if (config.roleVoices[role]) return config.roleVoices[role];

  // Auto-assign a voice for this role if not configured. We hash the
  // role name to a stable index into the available voices list.
  // Tauri/WebKitGTK lacks SpeechSynthesis — fall back to defaultVoice
  // (cloud / Voicemode engines have their own role-pool logic elsewhere).
  if (typeof window === 'undefined') return null;
  if (!window.speechSynthesis) return config.defaultVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return config.defaultVoice;
  const enVoices = voices.filter((v) => v.lang.startsWith('en'));
  const pool = enVoices.length ? enVoices : voices;
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  const picked = pool[Math.abs(h) % pool.length];
  // Persist so it stays consistent.
  config.roleVoices[role] = picked.name;
  saveConfig();
  return picked.name;
}

/**
 * Set voice mode. 'off' fully disables; 'push-to-talk' arms STT on
 * explicit invocation; 'always-on' listens for the wake word.
 */
function clearConnectingWatchdog(): void {
  if (connectingWatchdog) {
    clearTimeout(connectingWatchdog);
    connectingWatchdog = null;
  }
}

/**
 * Arm a watchdog that resolves a stuck optimistic 'connecting' status. Fires
 * only if we're still 'connecting' with no realtime session attached and no
 * full-agent start in flight — i.e. nothing is actually going to come up, so
 * the spinner would otherwise hang forever (the cross-window / no-engine bug).
 */
function armConnectingWatchdog(): void {
  clearConnectingWatchdog();
  if (typeof window === 'undefined') return;
  connectingWatchdog = setTimeout(() => {
    connectingWatchdog = null;
    if (state.status === 'connecting' && !realtimeSession && !fullAgentStarting) {
      setState({
        status: state.mode === 'off' ? 'off' : 'idle',
        micOwnedByFullAgent: false,
      });
    }
  }, 4000);
}

export function setVoiceMode(mode: VoiceMode): void {
  if (mode === state.mode) return;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* not running */
    }
    recognition = null;
  }
  // Persist the chosen mode so navigation preserves it.
  config.lastMode = mode;
  saveConfig();
  if (mode === 'off') {
    cancelAllSpeech();
    stopWhisperCaptureIfRunning();
    clearConnectingWatchdog();
    setState({ mode, status: 'off', micOwnedByFullAgent: false });
    return;
  }
  if (mode === 'push-to-talk') {
    // Push-to-talk is button-driven — there is no persistent session to
    // "connect" to, so it must NOT enter the optimistic 'connecting' state
    // (which only makes sense for the full-agent EL/Realtime engines and
    // otherwise sticks as a permanent "Connecting…"). Go straight to 'idle'
    // (ready); capture happens on hold via startPushToTalk.
    // Tear down any always-on continuous capture (e.g. energy-VAD) so it
    // doesn't keep the mic open and block per-hold PTT capture.
    clearConnectingWatchdog();
    stopWhisperCaptureIfRunning();
    setState({ mode, status: 'idle', micOwnedByFullAgent: false });
  } else {
    // always-on: claim mic ownership SYNCHRONOUSLY in the same setState that
    // flips the mode. Without this, React renders once with mode='always-on'
    // but micOwnedByFullAgent=false → useMicLevel opens getUserMedia → a
    // microtask later maybeStartFullAgent flips the flag → useMicLevel tears
    // down its stream — and EL has now also opened getUserMedia in parallel
    // on top of the cleanup, getting a silent track. Setting both flags in
    // one render eliminates the window. A watchdog guarantees this optimistic
    // 'connecting' always resolves even if no full-agent engine materializes.
    setState({ mode, status: 'connecting', micOwnedByFullAgent: true });
    armConnectingWatchdog();
  }
  // User-clicked-voice-on is also a "take voice over here" gesture.
  // Request the lead so any other tab currently running EL/STT yields.
  // No-op if we're already leader, or if BroadcastChannel is unavailable
  // (Safari private windows / WebViews — single-tab fallback handles it).
  try {
    const ls = getVoiceLeaderState();
    if (ls.available && !ls.isLeader) {
      requestVoiceLead(`user-set-mode-${mode}`);
    }
  } catch { /* leader module not yet loaded — initial subscriber boot will handle */ }
  // STT capture is leader-gated: only one tab in the BroadcastChannel
  // group opens the mic + transcribes. Followers stay silent so we don't
  // run N parallel getUserMedia + N transcription pipelines + dispatch
  // the same intent N times. We re-evaluate when leader changes (see
  // syncSttToLeader below).
  syncSttToLeader();
}

function maybeIsLeader(): boolean {
  try {
    const ls = getVoiceLeaderState();
    // If leader-election hasn't booted yet, treat us as leader so a
    // single-tab user isn't blocked from STT during initial load.
    if (!ls.available) return true;
    return ls.isLeader;
  } catch {
    return true;
  }
}

function syncSttToLeader(): void {
  if (state.mode === 'off') {
    stopWhisperCaptureIfRunning();
    stopRealtimeSession();
    stopWakeWordGate();
    // Clear the WebRTC-blocked gate so the user can retry the full
    // EL stack after switching networks / disabling VPN / etc.
    return;
  }
  if (!maybeIsLeader()) {
    stopWhisperCaptureIfRunning();
    stopRealtimeSession();
    stopWakeWordGate();
    if (recognition) {
      try { recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
    // Another tab owns voice — clear the optimistic 'connecting' so this tab
    // doesn't sit on a permanent spinner (the original bug: a follower window
    // toggled voice on, bailed here, and never reset the status).
    if (state.status === 'connecting') {
      clearConnectingWatchdog();
      setState({ status: 'idle', micOwnedByFullAgent: false });
    }
    return;
  }
  // Push-to-talk captures on demand (button hold), so there is nothing to
  // start here — and no full-agent session (those engines are conversational
  // / always-listening). Just make sure no leftover realtime session lingers.
  if (state.mode === 'push-to-talk') {
    stopRealtimeSession();
    return;
  }
  // Always-on: full-agent mode (EL Conv / OpenAI Realtime) takes precedence
  // over the STT pipeline — it bundles STT + LLM + TTS + intent dispatch.
  void maybeStartFullAgent().then((started) => {
    if (started) return;
    void maybeStartWhisperCapture(state.mode).catch(() => {
      if (state.mode === 'always-on') startWakeWordListening();
    });
  });
}

let realtimeSession: { stop(): Promise<void>; sendSystem?: (text: string) => void } | null = null;
/** Timestamp of last EL onConnect; reset to 0 in onDisconnect. Used to
 *  differentiate immediate-disconnect (negotiation failure) vs. mid-session
 *  drops vs. natural session-end so the toast wording matches reality. */
let elConnectedAt = 0;

// One-shot gate: set when EL fails with a WebRTC negotiation error so
// subsequent toggles in the same session skip EL and go straight to
// Whisper. Cleared on voice-mode 'off' or on prefs change.

// Idle-disconnect timer for EL Conv AI / Realtime sessions. Mic streams
// continuously while connected; silence still bills minutes. The timer
// is reset by every USER transcript (agent transcripts intentionally
// don't reset — see voice-mode onAssistantText). Default timeout from
// voice-prefs (2 min); 0 = disabled.
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimeoutMs = 2 * 60_000;

// Hard session-max timer. Regardless of activity, the session
// auto-disconnects after this many ms. Backstop for stuck-session
// edge cases (idle-detection failure, abandoned tabs, etc.).
// Set from voice-prefs.fullAgentSessionMaxMin; 0 = no max.
let sessionMaxTimer: ReturnType<typeof setTimeout> | null = null;
let sessionMaxMs = 30 * 60_000;

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function clearSessionMaxTimer(): void {
  if (sessionMaxTimer) {
    clearTimeout(sessionMaxTimer);
    sessionMaxTimer = null;
  }
}

/**
 * Arm the hard session-max timer at session-start. Runs ONCE — does
 * NOT reset on activity. The whole point is to bound worst-case
 * billable duration regardless of how active the session is.
 */
function armSessionMaxTimer(): void {
  clearSessionMaxTimer();
  if (sessionMaxMs <= 0) return;
  if (!realtimeSession) return;
  sessionMaxTimer = setTimeout(() => {
    sessionMaxTimer = null;
    if (!realtimeSession) return;
    const labelMin = Math.round(sessionMaxMs / 60_000);
    void emitVoiceToast(
      'info',
      `Voice session hit ${labelMin}m max — disconnecting. Tap the button to start another.`,
    );
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
  }, sessionMaxMs);
}

function armIdleTimer(): void {
  clearIdleTimer();
  if (idleTimeoutMs <= 0) return;
  if (!realtimeSession) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!realtimeSession) return;
    const labelMin = Math.round(idleTimeoutMs / 60_000);
    const labelSec = Math.round(idleTimeoutMs / 1000);
    const label = labelMin >= 1 ? `${labelMin}m` : `${labelSec}s`;
    void emitVoiceToast('info', wakeGated
      ? `Voice idle ${label} — going back to wake-word listening.`
      : `Voice idle ${label} — disconnecting to save minutes. Tap the button to resume.`);
    stopRealtimeSession();
    setState({ status: state.mode === 'off' ? 'off' : 'idle' });
    // Wake-word-gated mode: restart the local listener so the next
    // wake utterance brings the session back. Always-on mode just
    // sits idle until the user taps the button again.
    if (wakeGated && state.mode !== 'off') {
      void startWakeWordGate(wakeGatedPrefsCache).catch(() => {});
    }
  }, idleTimeoutMs);
}

/** Public hook so other modules can reset the idle clock. */
/**
 * Push a system-style note into the live EL session so the agent
 * sees it on its next turn. Used by the async delegate path: when
 * a long delegate finishes, the OperatorDelegationListener calls
 * this with the result headline so the agent can speak about it
 * naturally instead of having said "looking into that" minutes ago
 * and never followed up.
 *
 * No-op when there's no active full-agent session (the user might
 * be on the Whisper-only path, or have voice off entirely). Result
 * still lands in the panel via the parallel
 * operator:delegation-complete event.
 */
export function sendSystemToActiveSession(text: string): boolean {
  if (!realtimeSession?.sendSystem) return false;
  try {
    realtimeSession.sendSystem(text);
    return true;
  } catch (e) {
    console.warn('[voice-mode] sendSystem failed:', e);
    return false;
  }
}

export function nudgeFullAgentIdle(): void {
  if (realtimeSession) armIdleTimer();
}

/**
 * Drain the operator's coord-inbox hindsight channel into the live EL session
 * (collapse-delegate D-003 — replaced the bespoke delegate-inbox poll). Folds all
 * pending notifications into a single contextual update so the agent gets one
 * compact briefing, not a flood. No-op if nothing pending or no session.
 */
async function drainHindsightOnConnect(): Promise<void> {
  if (!realtimeSession?.sendSystem) return;
  try {
    const r = await fetch('/api/agent-mcp/operator-hindsight?drain=1');
    if (!r.ok) return;
    const data = await r.json();
    const items: Array<{ headline: string }> = data?.items ?? [];
    if (items.length === 0) return;
    const header = items.length === 1
      ? '[While you were away, 1 update]'
      : `[While you were away, ${items.length} updates]`;
    const body = items.map((it, i) => `${i + 1}. ${it.headline}`).join(' ');
    realtimeSession.sendSystem(`${header} ${body}`);
  } catch (e) {
    console.warn('[voice-mode] inbox drain failed:', e);
  }
}

// Tracks the in-flight stop so a re-entry (rapid off→on, focus-follows-
// tab swap, syncSttToLeader cascade) waits for the previous session's
// mic track to fully release before getUserMedia retries. Without this
// gate, Chrome throws NotReadableError → 'Could not start audio source'
// because the device looks busy mid-teardown.
let stopInFlight: Promise<void> | null = null;
function stopRealtimeSession(): Promise<void> {
  clearIdleTimer();
  clearSessionMaxTimer();
  if (!realtimeSession) return stopInFlight ?? Promise.resolve();
  const session = realtimeSession;
  realtimeSession = null;
  setState({ micOwnedByFullAgent: false });
  stopInFlight = (async () => {
    try { await session.stop(); }
    catch { /* swallow — best effort */ }
    // Belt-and-suspenders: a tiny grace window for Chrome to flush the
    // device handle. The SDK's endSession resolves before the underlying
    // MediaStreamTrack.stop() has propagated to the OS-level audio
    // session, so a follow-up getUserMedia on the same tick can still
    // see the device busy. 150ms is below user-perceptible delay and
    // empirically enough on macOS/Linux/Windows.
    await new Promise<void>((res) => setTimeout(res, 150));
  })();
  stopInFlight.finally(() => { stopInFlight = null; });
  return stopInFlight;
}

/** Public wait-for-stop used by maybeStartFullAgent before re-acquiring. */
export function waitForRealtimeSessionStop(): Promise<void> {
  return stopInFlight ?? Promise.resolve();
}

// ── Wake-word-gated EL session ──────────────────────────────────────
// When voicePrivacyMode='wake-word-gated', the local wake-word engine
// (Porcupine / openWakeWord) listens on-device. mic-to-EL streaming
// only happens between wake-fire and idle-disconnect.

let wakeGated = false;
let wakeGatedPrefsCache: any = null;
let wakeGateHandle: { stop(): Promise<void> } | null = null;

async function startWakeWordGate(prefs: any): Promise<boolean> {
  if (wakeGateHandle) return true;
  // Pick the engine: prefs.wakeWordEngine ('porcupine' | 'openwakeword').
  // 'off' is invalid here — the gated path requires a real engine.
  const engine = prefs?.wakeWordEngine ?? 'off';
  if (engine === 'off') {
    void emitVoiceToast(
      'error',
      'Wake-word-gated privacy mode needs a wake-word engine. Set wakeWordEngine to porcupine or openwakeword in /settings/voice.',
    );
    return false;
  }
  try {
    if (engine === 'porcupine') {
      const bootR = await fetch('/api/agent-mcp/operator-picovoice-bootstrap').catch(() => null);
      if (!bootR?.ok) {
        void emitVoiceToast('error', 'Wake-word gate: missing Picovoice key. Add it in /settings/api-keys.');
        return false;
      }
      const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
      if (!apiKey) return false;
      const { startWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/porcupine');
      wakeGateHandle = await startWakeWordDetection({
        accessKey: apiKey,
        keyword: prefs.porcupineKeyword ?? 'Computer',
        onWake: () => { signalWakeDetected(); void onWakeFireGated(prefs); },
        onError: (err) => console.warn('[wake-gate]', err),
      });
    } else if (engine === 'openwakeword') {
      const { startOpenWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/openwakeword');
      wakeGateHandle = await startOpenWakeWordDetection({
        keyword: prefs.openwakewordKeyword ?? 'hey_jarvis',
        threshold: 0.5,
        onWake: () => { signalWakeDetected(); void onWakeFireGated(prefs); },
        onError: (err) => console.warn('[wake-gate]', err),
      });
    } else {
      return false;
    }
    setState({ status: 'idle' });
    void emitVoiceToast('info', `Listening for "${prefs.porcupineKeyword ?? prefs.openwakewordKeyword ?? 'wake word'}". Mic stays on-device until you say it.`);
    return true;
  } catch (err) {
    console.warn('[wake-gate] start failed:', err);
    return false;
  }
}

function stopWakeWordGate(): void {
  if (!wakeGateHandle) return;
  void wakeGateHandle.stop().catch(() => {});
  wakeGateHandle = null;
}

async function onWakeFireGated(prefs: any): Promise<void> {
  // Tear down the local listener before bringing up EL — they share
  // the mic and Porcupine's stream is in the way of EL's WebRTC capture.
  stopWakeWordGate();
  // Honor the per-gated idle budget rather than the always-on default.
  const gatedSec = Math.max(5, Math.min(300, Number(prefs?.wakeGatedIdleTimeoutSec ?? 20)));
  idleTimeoutMs = gatedSec * 1000;
  const ok = await startElevenLabsConvAgent(prefs);
  if (!ok) {
    // Failed to bring up EL — go back to listening so the user can retry.
    void startWakeWordGate(prefs).catch(() => {});
  }
}

let fullAgentStarting: Promise<boolean> | null = null;

async function maybeStartFullAgent(): Promise<boolean> {
  if (realtimeSession) return true;
  // Reentrancy guard: syncSttToLeader can fire from multiple sources
  // (tab focus, leader-change, mode-change) within the same tick. Without
  // this, two concurrent startElevenLabsConv calls each call
  // getUserMedia — Chrome arbitrates by giving one a working track and
  // the other a silent one, and EL ends up with the silent one (zero
  // audio in/out for the entire session).
  if (fullAgentStarting) return fullAgentStarting;
  fullAgentStarting = (async () => {
    try {
      // Wait for any in-flight stop from a previous session to fully
      // release the device before we acquire it again. Without this,
      // a quick off→on toggle (or a focus-follows-tab handover) calls
      // getUserMedia while Chrome's still tearing down the previous
      // track, which throws NotReadableError → "Could not start audio
      // source" → fallback to Whisper. The wait is bounded inside
      // stopRealtimeSession (~150ms) so it's invisible if there's no
      // prior session.
      await waitForRealtimeSessionStop();
      return await maybeStartFullAgentInner();
    } finally { fullAgentStarting = null; }
  })();
  return fullAgentStarting;
}

async function maybeStartFullAgentInner(): Promise<boolean> {
  // Optimistically show "Connecting…" + claim the mic so useMicLevel
  // does NOT spin up its own getUserMedia in the gap between the
  // mode-change and the EL SDK's mic acquisition. Two consumers in
  // close succession on Chrome can leave EL's published track silent
  // (60s ICE timeout, no audio reaches the agent — exact field bug).
  // Reset both below if no full-agent engine ends up applying.
  if (state.mode !== 'off' && state.status !== 'connecting') {
    setState({ status: 'connecting', micOwnedByFullAgent: true });
  }
  const resetIfNotStarted = () => {
    if (!realtimeSession && state.status === 'connecting') {
      setState({
        status: state.mode === 'off' ? 'off' : 'idle',
        micOwnedByFullAgent: false,
      });
    }
  };
  // Track which "stage" we reached so the failure toast can point at the
  // exact thing that broke (prefs / bootstrap / SDK connect / runtime err).
  let stage: 'prefs' | 'bootstrap' | 'connect' | 'runtime' = 'prefs';
  try {
    // 30s timeout: Next.js dev cold-compile of this route can take 7-15s
    // on first hit, and voice-mode auto-restores on every page load when the
    // user previously enabled it. 10s was right at the boundary and we'd
    // see a startup "[voice] realtime start failed at stage=prefs" warning
    // on a cold tab; 30s leaves headroom without affecting a real hang.
    const prefsR = await fetch('/api/agent-mcp/operator-voice-prefs', { signal: AbortSignal.timeout(30000) });
    if (!prefsR.ok) return false;
    const prefs = await prefsR.json();
    // Pull idle-timeout pref so both EL and Realtime paths can use it.
    if (typeof prefs.fullAgentIdleTimeoutMin === 'number') {
      idleTimeoutMs = Math.max(0, prefs.fullAgentIdleTimeoutMin) * 60_000;
    }
    // Pull session-max pref. Hard ceiling regardless of activity.
    if (typeof prefs.fullAgentSessionMaxMin === 'number') {
      sessionMaxMs = Math.max(0, prefs.fullAgentSessionMaxMin) * 60_000;
    }
    // Wake-word-gated mode: don't open EL/Realtime yet — start the local
    // wake-word engine instead. The onWake callback brings up EL only
    // when the wake word fires.
    wakeGated = prefs.voicePrivacyMode === 'wake-word-gated';
    wakeGatedPrefsCache = prefs;
    if (wakeGated && (prefs.fullAgentEngine === 'elevenlabs-conv' || prefs.fullAgentEngine === 'elevenlabs-conversational' || prefs.fullAgentEngine === 'openai-realtime')) {
      const started = await startWakeWordGate(prefs);
      // Even if the gate failed to start, return true so we don't fall
      // through to Whisper-always-on; surfacing the error toast is enough.
      return started;
    }
    // WebRTC is required by both ElevenLabs Conv (LiveKit) and OpenAI
    // Realtime (RTCPeerConnection). WebKitGTK (Tauri's webview on
    // Linux) ships without WebRTC, so any attempt produces a noisy
    // toast every page load. Silently fall through to Whisper on
    // engines that need WebRTC when the API isn't available.
    const engineNeedsWebRTC =
      prefs.fullAgentEngine === 'elevenlabs-conv' ||
      prefs.fullAgentEngine === 'elevenlabs-conversational' ||
      prefs.fullAgentEngine === 'openai-realtime';
    if (engineNeedsWebRTC && typeof RTCPeerConnection === 'undefined') {
      debugLog('full-agent:webrtc-unsupported', { engine: prefs.fullAgentEngine });
      return false;
    }
    // ElevenLabs Conv AI — primary path in v5+
    if (prefs.fullAgentEngine === 'elevenlabs-conv' || prefs.fullAgentEngine === 'elevenlabs-conversational') {
      // Spend-cap check. Skip silently if the endpoint isn't reachable
      // (degraded mode); refuse only on a hard "over_cap: true". Warn
      // (toast, don't refuse) at 80% so the user has time to react.
      try {
        const sr = await fetch('/api/agent-mcp/operator-el-spend', { signal: AbortSignal.timeout(5000) });
        if (sr.ok) {
          const spend = await sr.json() as {
            over_cap?: boolean; minutes_used?: number; minutes_cap?: number | null; pct_used?: number | null;
          };
          if (spend.over_cap) {
            void emitVoiceToast(
              'error',
              `EL monthly cap hit (${spend.minutes_used}/${spend.minutes_cap} min). Raise the cap in /settings/voice or wait for next month.`,
            );
            return false;
          }
          if (spend.pct_used != null && spend.pct_used >= 0.8 && spend.minutes_cap) {
            void emitVoiceToast(
              'info',
              `EL usage ${Math.round((spend.pct_used) * 100)}% of monthly cap (${spend.minutes_used}/${spend.minutes_cap} min). Auto-disconnect after idle keeps the meter down.`,
            );
          }
        }
      } catch { /* fail-open if check is broken — the user explicitly toggled voice on */ }
      return await startElevenLabsConvAgent(prefs);
    }
    if (prefs.fullAgentEngine !== 'openai-realtime') return false;
    stage = 'bootstrap';
    const bootR = await fetch('/api/agent-mcp/operator-realtime-bootstrap');
    if (!bootR.ok) {
      void emitVoiceToast('error', `Realtime: bootstrap returned ${bootR.status}. Check OpenAI key in /settings/api-keys.`);
      return false;
    }
    const { apiKey } = await bootR.json();
    if (!apiKey) {
      void emitVoiceToast('error', 'Realtime: no OpenAI key. Add one in /settings/api-keys.');
      return false;
    }
    stage = 'connect';
    const { startRealtimeSession } = await import('@papercusp/operator-core/lib/voice-engines/openai-realtime');
    // Same tag observer as the EL Conv AI path — operator can flip
    // mode / set sleep timer via tags emitted in either voice engine.
    const realtimeTagObserver = createOperatorVoiceTagObserver();
    realtimeSession = await startRealtimeSession(apiKey, {
      onTranscript: (text) => {
        setState({ lastTranscript: text });
        void persistOperatorVoiceTurn({ role: 'user', text, source: 'voice_stt' });
        emitOperatorUserTurn(text);
        // Idle = USER idle. Resetting on agent transcripts too lets a
        // chatty agent keep the session alive indefinitely, defeating
        // the timeout. EL credit-burn audit, fix #2.
        nudgeFullAgentIdle();
      },
      onAssistantText: (text) => {
        realtimeTagObserver.push(text);
        void persistOperatorVoiceTurn({ role: 'assistant', text, source: 'voice_tts' });
        // Intentionally NOT calling nudgeFullAgentIdle() here. See above.
      },
      onError: (err) => {
        console.error('[realtime]', err);
        try { realtimeTagObserver.flush(); realtimeTagObserver.dispose(); } catch { /* ignore */ }
        void emitVoiceToast('error', `Realtime runtime error: ${err?.message ?? String(err)}`);
      },
    });
    setState({ status: 'listening', micOwnedByFullAgent: true });
    void emitVoiceToast('info', 'Realtime connected — speak to talk to the operator.');
    armIdleTimer();
    armSessionMaxTimer();
    return true;
  } catch (err: any) {
    const errName = err?.name ?? '';
    const errMsg = err?.message ?? String(err);
    const msg = errName ? `${errName}: ${errMsg}` : errMsg;
    debugLog('realtime:start-failed', { stage, msg });
    // Suppress the user-facing toast for fetch-cancellation / network
    // teardown errors — voice auto-restores on every page load and the
    // in-flight fetch from the previous mount gets cancelled, which
    // WebKit reports as "AbortError" / "TimeoutError" / "Load failed"
    // depending on the platform/timing. Whisper fallback still happens
    // via the return false; only debugLog records it.
    const isTransient =
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      /aborted|abort\b|Load failed|Fetch is aborted|signal timed out/i.test(errMsg);
    if (!isTransient) {
      void emitVoiceToast('error', `Realtime failed at ${stage}: ${err?.message ?? String(err)}. Falling back to Whisper.`);
    }
    return false;
  } finally {
    // Always clear the optimistic 'connecting' if no session ended up
    // attached — covers every early-return path inside the try block.
    resetIfNotStarted();
  }
}

// ── ElevenLabs Conv AI ──────────────────────────────────────────────────

function debugLog(event: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  console.log(`[voice-debug] ${event}`, detail ?? '');
  void fetch('/api/agent-mcp/voice-debug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, detail, ts: Date.now() }),
  }).catch(() => { /* best-effort */ });
}

// ── Shared-session control surface (discord-shortcuts 2026-06-06) ──────────
// The active bus runtime, exposed module-level so global shortcut handlers
// (Mod+Shift+M mute / Mod+Shift+D deafen — GlobalVoiceShortcuts) can drive
// the ONE shared session without reaching into the closure below.
// `operatorVoiceMuted` mirrors the host's authoritative session_state
// broadcasts (with an optimistic flip on toggle so rapid presses behave).
let operatorVoiceRuntime: OperatorVoiceRuntime | null = null;
let operatorVoiceMuted = false;

export function getOperatorVoiceRuntime(): OperatorVoiceRuntime | null {
  return operatorVoiceRuntime;
}

/**
 * Toggle the shared session's mic mute. Returns false when no bus session is
 * active (caller may toast a hint). Mute is a BUS control — it applies once
 * at the session host and the authoritative state echoes back to every
 * attached surface (universal-voice-interface P-004).
 */
export function toggleOperatorVoiceMute(): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.control({ op: 'mute', muted: !operatorVoiceMuted });
  operatorVoiceMuted = !operatorVoiceMuted; // host broadcast reconciles
  return true;
}

/**
 * Toggle LOCAL deafen — this surface keeps showing transcripts but silences
 * its own playout. Returns false when no bus session is active.
 */
export function toggleOperatorVoiceDeafen(): boolean {
  if (!operatorVoiceRuntime) return false;
  operatorVoiceRuntime.setDeafened(!operatorVoiceRuntime.isDeafened());
  return true;
}

async function startElevenLabsConvAgent(_prefs: unknown): Promise<boolean> {
  debugLog('el-conv:start-attempt', { mode: state.mode });
  // Claim the mic so useMicLevel's analyzer doesn't also open getUserMedia —
  // the runtime captures it for the shared session below.
  setState({ micOwnedByFullAgent: true });
  // Universal voice (universal-voice-interface-2026-06-05, P-008): the desktop
  // no longer starts its OWN ElevenLabs WebRTC session. It attaches to the ONE
  // shared EL/operator session hosted by the voice service, over the
  // desktop-voice-ws bus. The host mints the EL URL, runs the brain, persists
  // the turns once (P-010), and streams input + response to every attached
  // client; only the lease-elected client plays audio + captures the mic
  // (Model A). voice-mode here is a thin client of that session.
  let activeRuntime: OperatorVoiceRuntime | null = null;
  // The agent's turn may carry <set_mode>/<sleep> tags that flip the navbar
  // toggle — the same dispatcher the text path uses. <say> is NOT re-rendered
  // (the host's TTS already spoke it).
  const tagObserver = createOperatorVoiceTagObserver();
  const disposeObserver = () => {
    try {
      tagObserver.flush();
      tagObserver.dispose();
    } catch {
      /* ignore */
    }
  };
  try {
    const tabId = getOrAssignTabId();
    const runtime = await startDesktopOperatorVoice({
      clientId: tabId,
      label: 'Desktop',
      onInputTranscript: (text, final) => {
        setState({ lastTranscript: text });
        if (!final) return;
        debugLog('el-conv:user-transcript', { text });
        pulseUserSpoken();
        if (text && text.trim().length > 1) onUtteranceFinal(text);
        emitOperatorUserTurn(text);
        nudgeFullAgentIdle();
        // The HOST persists this user turn once to the shared operator
        // conversation (P-010) — the desktop no longer double-writes it.
      },
      onResponseTranscript: (text) => {
        debugLog('el-conv:agent-text', { text: String(text).slice(0, 200) });
        tagObserver.push(text);
        // Host persists the assistant turn once (P-010) — no desktop write.
      },
      onState: (s) => {
        // Mirror the host's authoritative mute flag for the toggle shortcut.
        operatorVoiceMuted = !!s.muted;
        switch (s.status) {
          case 'connecting':
            setState({ status: 'connecting' });
            return;
          case 'idle':
          case 'listening':
          case 'speaking':
            setState({ status: s.status, micOwnedByFullAgent: true });
            return;
          case 'off':
            // pre-start / settling echo — not terminal, ignore.
            return;
          case 'ended':
          case 'error': {
            disposeObserver();
            void activeRuntime?.stop();
            activeRuntime = null;
            operatorVoiceRuntime = null;
            realtimeSession = null;
            setState({ status: state.mode === 'off' ? 'off' : 'idle', micOwnedByFullAgent: false });
            if (s.reason) {
              void emitVoiceToast(s.status === 'error' ? 'error' : 'info', `Voice: ${s.reason}`);
            }
            return;
          }
        }
      },
      onError: (err) => {
        const m = (err as { message?: string })?.message ?? String(err);
        debugLog('el-conv:error', { m });
        void emitVoiceToast('error', `Voice runtime error: ${m}`);
      },
    });
    activeRuntime = runtime;
    operatorVoiceRuntime = runtime;
    realtimeSession = {
      async stop() {
        disposeObserver();
        await activeRuntime?.stop();
        activeRuntime = null;
        operatorVoiceRuntime = null;
      },
    };
    setState({ status: 'connecting', micOwnedByFullAgent: true });
    armIdleTimer();
    armSessionMaxTimer();
    // Hindsight inbox: deliver async-delegate completions that arrived while no
    // session was live, once the session is up.
    setTimeout(() => {
      void drainHindsightOnConnect();
    }, 1500);
    void emitVoiceToast('info', 'Voice connected — talking to the shared operator session.');
    return true;
  } catch (err: any) {
    disposeObserver();
    void activeRuntime?.stop();
    activeRuntime = null;
    operatorVoiceRuntime = null;
    const errName = err?.name ?? '';
    const errMsg = err?.message ?? String(err);
    debugLog('el-conv:start-failed', { msg: errMsg });
    // Suppress the toast for fetch-cancellation / network-teardown errors —
    // voice auto-restores on every page load and an in-flight connect from the
    // previous mount gets cancelled. Whisper fallback still happens via the
    // return false; debugLog records the detail. Real failures still toast.
    const isTransient =
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      /aborted|abort\b|Load failed|Fetch is aborted|signal timed out|signaling failed/i.test(errMsg);
    if (!isTransient) {
      void emitVoiceToast('error', `Voice failed to attach: ${errMsg}. Falling back to Whisper.`);
    }
    setState({ status: state.mode === 'off' ? 'off' : 'idle', micOwnedByFullAgent: false });
    return false;
  }
}

function getOrAssignTabId(): string {
  if (typeof window === 'undefined') return 'srv';
  const KEY = 'pc-voice-tab-id';
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}

// getBrowserWorkspaceId now lives in @/lib/browser-workspace (imported above)
// — it additionally prefers the host-injected window.__PAPERCUSP_WS__ global.

// Best-effort sonner toast — sonner only ships in the browser bundle, so
// a dynamic import keeps the SSR build clean.
async function emitVoiceToast(
  level: 'info' | 'error',
  text: string,
  opts?: { actionLabel?: string; onAction?: () => void },
): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const { toast } = await import('sonner');
    const action = opts?.actionLabel && opts?.onAction
      ? { label: opts.actionLabel, onClick: opts.onAction }
      : undefined;
    if (level === 'error') toast.error(text, { duration: 8000, action });
    else toast(text, { action });
  } catch { /* sonner not in bundle on this page; drop */ }
}

// React to leader-election changes: when we're newly elected leader,
// start STT; when we lose leadership, stop. Subscribed once at module
// load. Also opens the cross-process SSE bridge (so cross-process callers
// like Oracle / EL webhook can deliver browser:'required' commands here).
if (typeof window !== 'undefined') {
  void (async () => {
    try {
      const { subscribeVoiceLeader, bootVoiceLeader, getVoiceLeaderState, requestVoiceLead } =
        await import('./voice-leader');
      await bootVoiceLeader();
      // Track previous leadership so we only toast on actual transitions.
      let prevIsLeader = getVoiceLeaderState().isLeader;
      subscribeVoiceLeader((ls) => {
        // Toast only when voice is on (mode !== 'off'); silent otherwise so
        // dormant tabs don't flash unrelated notifications.
        if (state.mode !== 'off' && ls.available && ls.isLeader !== prevIsLeader) {
          if (ls.isLeader) {
            void emitVoiceToast('info', 'Listening here now');
          } else {
            void emitVoiceToast('info', 'Listening moved to another tab — click to bring back', {
              actionLabel: 'Bring back',
              onAction: () => requestVoiceLead('toast-action'),
            });
          }
        }
        prevIsLeader = ls.isLeader;
        if (state.mode !== 'off') syncSttToLeader();
      });

      // Focus-follows-tab leadership: when this tab is visible+focused
      // for FOCUS_TAKEOVER_DELAY_MS continuously, take the lead. The
      // delay prevents a quick alt-tab from thrashing the EL session
      // (each handover tears down the WebRTC PC + frees a workspace
      // concurrency slot, which the new leader's connect must re-claim
      // — flapping at 1Hz would be expensive).
      //
      // Cancellation: any visibility loss before the timer fires
      // discards the pending takeover. Only sustained focus claims it.
      const FOCUS_TAKEOVER_DELAY_MS = 4_000;
      let focusTakeoverTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelFocusTakeover = () => {
        if (focusTakeoverTimer) {
          clearTimeout(focusTakeoverTimer);
          focusTakeoverTimer = null;
        }
      };
      const scheduleFocusTakeover = () => {
        cancelFocusTakeover();
        // Skip when there's nothing to take: voice off, or we're
        // already leader, or we're in single-tab fallback mode.
        if (state.mode === 'off') return;
        const ls = getVoiceLeaderState();
        if (!ls.available || ls.isLeader) return;
        focusTakeoverTimer = setTimeout(() => {
          focusTakeoverTimer = null;
          // Re-check at fire time — state may have flipped.
          if (state.mode === 'off') return;
          const cur = getVoiceLeaderState();
          if (!cur.available || cur.isLeader) return;
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
          requestVoiceLead('focus-follows-tab');
        }, FOCUS_TAKEOVER_DELAY_MS);
      };
      const onVisibility = () => {
        if (document.visibilityState === 'visible') scheduleFocusTakeover();
        else cancelFocusTakeover();
      };
      window.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', scheduleFocusTakeover);
      window.addEventListener('blur', cancelFocusTakeover);
      // If the page is already visible at boot (likely), arm the timer
      // so a tab that loads while focused earns the lead after the
      // delay. Without this, a freshly-opened-already-focused tab
      // would only take over after the user blur+focuses it.
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        scheduleFocusTakeover();
      }

      // Leader-bridge wiring: subscribe to the SSE channel when we're
      // the elected leader for the workspace. Cross-process callers
      // (Oracle MCP, EL webhook, Pi) deliver 'browser:required' commands
      // through this bridge. See plan §3.3.
      const { startLeaderBridge } = await import('@papercusp/operator-core/lib/commands/leader-bridge');
      // NOTE: '/index' is load-bearing — operator-core's exports map is
      // `"./lib/*": "./lib/*.ts"`, so a bare directory subpath resolves to
      // a nonexistent `defs.ts` and 500s the whole Vite module graph.
      await import('@papercusp/operator-core/lib/commands/defs/index');
      let teardown: (() => void) | null = null;
      const leaderListeners = new Set<() => void>();
      const bridgeOpts = {
        getWorkspace: () => getBrowserWorkspaceId(),
        isLeader: () => getVoiceLeaderState().isLeader,
        onLeaderChange: (cb: () => void) => {
          leaderListeners.add(cb);
          return () => leaderListeners.delete(cb);
        },
        tabId: getOrAssignTabId(),
      };
      teardown = startLeaderBridge(bridgeOpts);
      subscribeVoiceLeader(() => {
        for (const cb of leaderListeners) cb();
      });
      // Re-bridge on workspace change (URL nav).
      window.addEventListener('popstate', () => {
        teardown?.();
        teardown = startLeaderBridge(bridgeOpts);
      });
    } catch { /* leader module missing — STT runs ungated, prior behavior */ }
  })();
}

let whisperCapture: { stop(): void } | null = null;
let porcupineHandle: { stop(): Promise<void> } | null = null;
// Raw push-to-talk capture (voicemode whisper engine). Unlike the streaming
// `whisperCapture` above (Silero VAD, which can't load on WebKitGTK), this
// records the whole hold and transcribes on release — see ./ptt-capture.
let pttRawCapture: PttRawCapture | null = null;
// True between startPushToTalk and stopPushToTalk. Lets the async capture
// startup tear itself down if the user already released (prevents an orphaned
// mic stream when the hold ends before getUserMedia resolves).
let pttActive = false;

const VOICEMODE_WHISPER_URL = 'http://localhost:2022';

async function maybeStartWakeWordGate(prefs: any): Promise<boolean> {
  // Returns true if a wake-word engine took over (Whisper should NOT
  // also run continuously). The wake-word engine fires onWake → we spin
  // up Whisper once for the command utterance, then return to gating.
  const engine = prefs.wakeWordEngine ?? 'off';
  if (engine === 'off') return false;

  if (engine === 'porcupine') {
    // Porcupine needs a Picovoice access key.
    const bootR = await fetch('/api/agent-mcp/operator-picovoice-bootstrap').catch(() => null);
    if (!bootR?.ok) return false;
    const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
    if (!apiKey) return false;
    try {
      const { startWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/porcupine');
      porcupineHandle = await startWakeWordDetection({
        accessKey: apiKey,
        keyword: prefs.porcupineKeyword ?? 'Computer',
        onWake: () => {
          signalWakeDetected();
          void runOneShotWhisperAfterWake().catch(() => {});
        },
        onError: (err) => console.warn('[porcupine]', err),
      });
      return true;
    } catch (err) {
      console.warn('[voice] porcupine start failed; falling back:', err);
      return false;
    }
  }

  if (engine === 'openwakeword') {
    // No key required — Apache 2.0, models downloaded from upstream release.
    try {
      const { startOpenWakeWordDetection } = await import('@papercusp/operator-core/lib/voice-engines/openwakeword');
      porcupineHandle = await startOpenWakeWordDetection({
        keyword: prefs.openwakewordKeyword ?? 'hey_jarvis',
        threshold: 0.5,
        onWake: () => {
          signalWakeDetected();
          void runOneShotWhisperAfterWake().catch(() => {});
        },
        onError: (err) => console.warn('[openwakeword]', err),
      });
      return true;
    } catch (err) {
      console.warn('[voice] openwakeword start failed; falling back:', err);
      return false;
    }
  }

  return false;
}

async function runOneShotWhisperAfterWake(): Promise<void> {
  if (whisperCapture) return; // already running
  // Use whatever STT engine is configured (Voicemode whisper / Deepgram).
  // The Whisper capture's first onFinal handler ships the transcript; we
  // then tear it down and resume Porcupine gating.
  const probe = await fetch('http://localhost:2022/health', { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!probe?.ok) return;
  const { startWhisperCapture } = await import('../../../app/_components/voice/stt-voicemode');
  let fired = false;
  whisperCapture = await startWhisperCapture('http://localhost:2022', {
    onFinal: (text) => {
      if (fired) return;
      fired = true;
      setState({ lastTranscript: text });
      // Synthesize "operator <text>" so the wake-word strip doesn't drop it.
      onUtteranceFinal(`operator ${text}`);
      stopWhisperCaptureIfRunning();
    },
  });
  // Auto-tear-down after 8s in case no transcript ever fires.
  window.setTimeout(() => {
    if (!fired) stopWhisperCaptureIfRunning();
  }, 8000);
}


// Exported for unit testing the runtime-gating truth table. Returns true
// on the Tauri WebKitGTK desktop webview without crossOriginIsolated —
// the runtime where onnxruntime-web threading (and thus voicemode Whisper)
// can't run, so always-on capture must fall through to wake-word listening.
export function shouldSkipVoicemodeWhisperOnThisRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isTauri = Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const isWebKit = /AppleWebKit/i.test(ua) && !/(Chrome|Chromium|Edg)\//i.test(ua);
  return isTauri && isWebKit && !self.crossOriginIsolated;
}

async function maybeStartWhisperCapture(mode: VoiceMode): Promise<void> {
  // Only initialize whisper for always-on. PTT continues to use Web
  // Speech for now (synchronous start/stop semantics are awkward to
  // replicate over MediaRecorder VAD).
  if (mode !== 'always-on') {
    if (mode !== 'off' && mode === 'push-to-talk') {
      // PTT keeps the existing Web Speech recognizer.
      return;
    }
    return;
  }
  try {
    const prefsR = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (!prefsR.ok) { startWakeWordListening(); return; }
    const prefs = await prefsR.json();
    // Porcupine gate: when enabled, run wake-word detection only.
    // Whisper spins up only on wake — big idle-CPU win.
    if (await maybeStartWakeWordGate(prefs)) return;
    if (prefs.sttEngine === 'deepgram') {
      // Deepgram cloud streaming (BYO key + leak-ack gate, same as Web Speech).
      if (!prefs.webSpeechLeakAcked) { startWakeWordListening(); return; }
      const bootR = await fetch('/api/agent-mcp/operator-stt-bootstrap?engine=deepgram').catch(() => null);
      if (!bootR?.ok) { startWakeWordListening(); return; }
      const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
      if (!apiKey) { startWakeWordListening(); return; }
      const { startDeepgramStream } = await import('@papercusp/operator-core/lib/voice-engines/deepgram');
      whisperCapture = await startDeepgramStream({
        apiKey,
        onFinal: (text) => {
          setState({ lastTranscript: text });
          onUtteranceFinal(text);
        },
        onSoftCap: (usd) => {
          // Server already deduped to once-per-day; just speak it.
          speak(`Heads up: Deepgram spend just crossed ${usd.toFixed(2)} today.`, 'system:stt-soft-cap', 'polite');
        },
        onHardCap: (usd) => {
          speak(`Deepgram daily cap reached at ${usd.toFixed(2)}; switching microphone off.`, 'system:stt-hard-cap', 'assertive');
          whisperCapture = null;
          // Fall back to wake-word listening so always-on still works (free path).
          startWakeWordListening();
        },
      });
      return;
    }
    if (prefs.sttEngine !== 'voicemode') {
      startWakeWordListening();
      return;
    }
    // Detect whisper endpoint.
    const probe = await fetch(`${VOICEMODE_WHISPER_URL}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!probe?.ok) {
      startWakeWordListening();
      return;
    }
    if (shouldSkipVoicemodeWhisperOnThisRuntime()) {
      // Silero VAD (onnxruntime-web threaded WASM → SharedArrayBuffer) can't
      // run on the WebKitGTK desktop webview. Use energy-gated raw capture
      // instead so always-on actually listens here, transcribing each speech
      // segment via the same local whisper server.
      await startEnergyVadAlwaysOn();
      return;
    }
    const { startWhisperCapture } = await import('./stt-voicemode');
    whisperCapture = await startWhisperCapture(VOICEMODE_WHISPER_URL, {
      onFinal: (text) => {
        setState({ lastTranscript: text });
        onUtteranceFinal(text);
      },
    });
  } catch {
    startWakeWordListening();
  }
}

/**
 * Always-on capture via energy-gated VAD (the WebKitGTK-safe path). Segments
 * speech by RMS energy, then resamples → WAV-encodes → POSTs each utterance to
 * the local whisper server, dispatching transcripts the same way the Silero
 * path does. The handle is stored in `whisperCapture` so stopWhisperCaptureIfRunning
 * tears it down on mode change.
 */
async function startEnergyVadAlwaysOn(): Promise<void> {
  whisperCapture = await startEnergyVadCapture({
    onSpeechStart: () => setAudioReceiving(true),
    onSpeechEnd: () => setAudioReceiving(false),
    onUtterance: async (pcm16k) => {
      // Drop sub-0.2s blips (16kHz → 3200 samples) that slipped the VAD.
      if (pcm16k.length < 3200) return;
      try {
        const text = (await transcribeChunk(VOICEMODE_WHISPER_URL, f32ToWav(pcm16k, 16000))).trim();
        if (!isBlankTranscript(text)) {
          setState({ lastTranscript: text });
          onUtteranceFinal(text);
        }
      } catch { /* network blip / whisper down — drop this utterance */ }
    },
  });
  // Capture is live; clear the optimistic 'connecting' to the listening-ready
  // state (mode label shows "Always-on"; audioReceiving drives the hearing UI).
  if (state.status === 'connecting') {
    clearConnectingWatchdog();
    setState({ status: 'idle', micOwnedByFullAgent: false });
  }
}

function stopWhisperCaptureIfRunning(): void {
  if (whisperCapture) {
    try { whisperCapture.stop(); } catch { /* ignore */ }
    whisperCapture = null;
  }
  if (porcupineHandle) {
    void porcupineHandle.stop();
    porcupineHandle = null;
  }
}

function startWakeWordListening(): void {
  if (typeof window === 'undefined' || !state.hasWebSpeechSTT) return;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (event: any) => {
    let transcript = '';
    let sawFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) sawFinal = true;
    }
    const wake = stripWakeWordAndPrefix(transcript, config.wakeWord);
    if (wake.matched) {
      signalWakeDetected();
      // Single-utterance fast path: wake word + command spoken together
      // and the recognizer has already marked the utterance final. Dispatch
      // immediately instead of opening a fresh recognizer that would wait
      // for the no-speech timeout (~5s) before firing onend.
      if (sawFinal && wake.dispatchText) {
        cancelAllSpeech();
        setState({ status: 'idle', lastTranscript: wake.dispatchText });
        onUtteranceFinal(wake.dispatchText);
        if (state.mode === 'always-on') {
          setTimeout(() => startWakeWordListening(), 200);
        }
        try { recognition?.stop(); } catch { /* ignore */ }
        return;
      }
      activateListening(wake.trailing);
    }
  };
  recognition.onerror = () => {
    // Errors are routine (no-speech, audio-capture); restart silently.
    if (state.mode === 'always-on') {
      setTimeout(() => startWakeWordListening(), 1000);
    }
  };
  recognition.onend = () => {
    if (state.mode === 'always-on') {
      // Restart for continuous listening.
      setTimeout(() => startWakeWordListening(), 100);
    }
  };
  try {
    recognition.start();
  } catch {
    /* already started */
  }
}

function activateListening(seedTranscript: string): void {
  // Barge-in: stop any current TTS before listening.
  cancelAllSpeech();
  setState({ status: 'listening', lastTranscript: seedTranscript });
  // Listen for the rest of the utterance.
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  let finalTranscript = seedTranscript;
  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += ' ' + event.results[i][0].transcript;
      }
    }
    setState({ lastTranscript: finalTranscript.trim() });
  };
  recognition.onend = () => {
    const trimmed = finalTranscript.trim();
    setState({ status: 'idle', lastTranscript: trimmed });
    if (trimmed) {
      // Re-prefix "operator " when the wake word stripped it, so
      // parseOperatorIntent can match. Skip if user already said
      // "operator …" as the seed (rare case where wakeWord === intent prefix).
      const dispatch = trimmed.toLowerCase().startsWith('operator ')
        ? trimmed
        : `operator ${trimmed}`;
      onUtteranceFinal(dispatch);
    }
    // Resume wake-word listening if mode is always-on.
    if (state.mode === 'always-on') {
      setTimeout(() => startWakeWordListening(), 200);
    }
  };
  try {
    recognition.start();
  } catch {
    /* ignore */
  }
}

/**
 * Push-to-talk: start capture using the user's configured STT engine.
 * Was hardcoded to Web Speech, which silently no-op'd for users on
 * Voicemode whisper or Deepgram. Now respects sttEngine the same way
 * always-on does.
 */
export function startPushToTalk(): void {
  if (!state.supported) return;
  pttActive = true;
  setState({ status: 'listening' });
  // Use the same capture path as always-on. setVoiceMode-style sync
  // handles which engine to spin up based on prefs.sttEngine.
  void maybeStartCaptureForPtt().catch(() => {
    // Last-ditch: try Web Speech if everything else failed.
    if (state.hasWebSpeechSTT) activateListening('');
  });
}

/**
 * Fire the actionable "no audio" toast, tailoring the message to the real
 * getUserMedia failure (captured by useMicLevel / the PTT raw capture) so it
 * stops being a guessing game. Always phase:'no-audio' so VoiceButton renders
 * the "Mic permissions" deep-link action.
 */
function dispatchNoAudioToast(): void {
  if (typeof window === 'undefined') return;
  const errStr = lastMicError ? `${lastMicError.name} ${lastMicError.message}` : '';
  let message = 'No audio detected — check your microphone and try again.';
  if (/NotAllowedError|SecurityError|Permission|denied/i.test(errStr)) {
    message = 'Microphone access is blocked — grant permission and try again.';
  } else if (/NotReadableError|NotFoundError|OverconstrainedError|AbortError|busy|in use|device/i.test(errStr)) {
    message = `Microphone unavailable${lastMicError?.name ? ` (${lastMicError.name})` : ''} — make sure it isn't muted or used by another app, and that the right input device is selected.`;
  }
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:voiceTimeout', { detail: { phase: 'no-audio', message } }),
    );
  } catch { /* ignore */ }
}

/** Fire the "no transcript" toast — the mic worked but no words came back. */
function dispatchNoTranscriptToast(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('papercusp:voiceTimeout', {
        detail: { phase: 'transcript', message: 'No transcript received — try speaking again.' },
      }),
    );
  } catch { /* ignore */ }
}

/** Stop push-to-talk: tear down whichever capture is running. */
export function stopPushToTalk(): void {
  pttActive = false;
  // Read before the reset below: for streaming engines this is the "did we
  // capture audio?" signal.
  const heardAudio = state.audioReceiving || !!state.lastTranscript;
  setState({ status: state.mode === 'off' ? 'off' : 'idle', audioReceiving: false });
  if (recognition) {
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
  }

  // Voicemode raw-capture path: finalize from the actual recorded buffer
  // (robust — the no-audio decision comes from real captured audio, not the
  // visualization analyser's threshold).
  if (pttRawCapture) {
    const cap = pttRawCapture;
    pttRawCapture = null;
    let result: PttRawCaptureResult | null = null;
    try { result = cap.stop(); } catch { result = null; }
    void finalizePttRawCapture(result);
    return;
  }

  // Streaming engines (Deepgram / Web Speech): only enter "processing
  // transcript" if we actually captured audio. If audioReceiving never became
  // true during the hold, the mic was dead — fire the no-audio toast instead
  // of pretending a transcript is on the way.
  stopWhisperCaptureIfRunning();
  if (heardAudio) {
    beginProcessingTranscript();
  } else {
    dispatchNoAudioToast();
  }
}

/**
 * Finalize a voicemode PTT raw capture: classify the buffer, and either fire
 * the actionable no-audio toast (capture failed / mic delivered silence) or
 * resample → WAV-encode → POST to whisper and dispatch the transcript.
 */
async function finalizePttRawCapture(result: PttRawCaptureResult | null): Promise<void> {
  if (classifyPttResult(result) === 'no-audio') {
    dispatchNoAudioToast();
    return;
  }
  // Non-null after classify !== 'no-audio'.
  const captured = result as PttRawCaptureResult;
  beginProcessingTranscript();
  try {
    const pcm16k = resampleLinearTo16k(captured.samples, captured.sampleRate);
    const blob = f32ToWav(pcm16k, 16000);
    const text = (await transcribeChunk(VOICEMODE_WHISPER_URL, blob)).trim();
    if (!isBlankTranscript(text)) {
      setState({ lastTranscript: text });
      onUtteranceFinal(text); // clears processing, begins awaiting-response
    } else {
      endProcessingTranscript();
      dispatchNoTranscriptToast();
    }
  } catch {
    endProcessingTranscript();
    dispatchNoTranscriptToast();
  }
}

async function maybeStartCaptureForPtt(): Promise<void> {
  if (pttRawCapture) return; // already capturing
  // Release any lingering always-on capture (e.g. energy-VAD) so PTT owns the
  // mic — otherwise its open stream blocks this and PTT silently no-ops.
  stopWhisperCaptureIfRunning();

  // Open the mic and start buffering IMMEDIATELY — before resolving prefs,
  // probing whisper, or importing engines. That async startup used to run
  // first and swallow the opening ~0.5–1s of speech on a quick hold, surfacing
  // as "No audio detected". Voicemode whisper (raw capture → transcribe on
  // release) is the default and the only engine that works on the WebKitGTK
  // desktop; deepgram/web-speech are swapped in below when configured.
  try {
    if (!whisperCapture) {
      const cap = await startPttRawCapture();
      if (!pttActive) { try { cap.stop(); } catch { /* ignore */ } return; } // released mid-startup
      pttRawCapture = cap;
      setMicCaptureError(null);
    }
  } catch (err) {
    // getUserMedia/permission/device failure — record it so the no-audio toast
    // on release names the real cause. pttRawCapture stays null, so
    // stopPushToTalk falls through to the no-audio branch.
    setMicCaptureError(err);
  }

  // Resolve the configured engine; swap to a cloud streaming engine if set.
  const prefsR = await fetch('/api/agent-mcp/operator-voice-prefs').catch(() => null);
  const prefs = prefsR?.ok ? await prefsR.json() : null;
  if (prefs?.sttEngine === 'deepgram' && prefs.webSpeechLeakAcked) {
    const bootR = await fetch('/api/agent-mcp/operator-stt-bootstrap?engine=deepgram').catch(() => null);
    const apiKey: string | null = bootR?.ok ? ((await bootR.json())?.apiKey ?? null) : null;
    if (apiKey) {
      // Hand the mic from the raw capture over to Deepgram's own stream.
      if (pttRawCapture) { try { pttRawCapture.stop(); } catch { /* ignore */ } pttRawCapture = null; }
      const { startDeepgramStream } = await import('@papercusp/operator-core/lib/voice-engines/deepgram');
      whisperCapture = await startDeepgramStream({
        apiKey,
        onFinal: (text) => { setState({ lastTranscript: text }); onUtteranceFinal(text); },
      });
      return;
    }
  }

  // Voicemode default keeps the raw capture already running. If neither the raw
  // capture nor a streaming engine came up, last-ditch Web Speech.
  if (!pttRawCapture && !whisperCapture && state.hasWebSpeechSTT) activateListening('');
}

const utteranceListeners = new Set<(text: string) => void>();

export function onFinalUtterance(listener: (text: string) => void): () => void {
  utteranceListeners.add(listener);
  return () => {
    utteranceListeners.delete(listener);
  };
}



function onUtteranceFinal(text: string): void {
  endProcessingTranscript();
  beginAwaitingResponse();
  for (const l of utteranceListeners) {
    try {
      l(text);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Test helper used by the "Test wake word" button in /settings/voice.
 * Fires onUtteranceFinal as if a real STT engine had just produced
 * a transcript, exercising the full dispatch path (VoiceAppBridge →
 * stripWakeWordAndPrefix → parseOperatorIntent).
 */
export function __simulateUtterance(text: string): void {
  setState({ lastTranscript: text });
  onUtteranceFinal(text);
}

/**
 * Speak text in the voice assigned to `role`. Queues if another role is
 * already speaking. Only one utterance plays at a time.
 */
export function speak(
  text: string,
  role = 'system:operator',
  priority: 'polite' | 'assertive' = 'polite',
  options: { force?: boolean } = {},
): void {
  if (!state.supported) return;
  if (!options.force) {
    // Normal path: voice mode must be on AND tutorial complete AND we
    // must be the leader tab. Test/preview buttons in /settings/voice
    // pass force:true to bypass these gates — they ARE the explicit
    // user request to make sound.
    if (state.mode === 'off') return;
    if (typeof window !== 'undefined' && sessionStorage.getItem('oracle-tutorial-complete') !== 'true') return;
  }
  // Aria-live publish — independent of TTS engine + leader election so
  // screen-reader users always see the same content the leader speaks.
  try {
    // Lazy-import to avoid pulling React-side bus into non-React callers.
    void import('./aria-live-bus').then((m) => m.publishAriaLive(priority, text));
  } catch { /* ignore */ }
  // When a full-agent engine (EL Conv AI / OpenAI Realtime) is active,
  // the agent itself is the voice. Local speak() calls — spend-cap
  // warnings, op-narration, anything else routed through here — would
  // talk over the agent in a different voice. Drop them silently after
  // the aria-live publish above so screen readers still see the text.
  // Callers who genuinely need to override (test buttons in
  // /settings/voice) already pass force:true.
  if (realtimeSession && !options.force) return;
  // Leader-election gate (v4 §2i): only the leader tab actually emits TTS.
  // Followers are silent; aria-live still publishes so screen-readers in any
  // tab see the text.
  try {
    const leader = getVoiceLeaderState();
    if (leader.available && !leader.isLeader && !options.force) return;
  } catch { /* leader module not yet loaded — fall through and speak */ }
  synthQueue.push({ text, role });
  // Cap queue depth: drop the oldest items beyond MAX so newer (more
  // relevant) utterances win. Critical when a stuck TTS engine + a
  // chatty caller (background scanner during always-on voice) would
  // otherwise queue megabytes of stale text.
  if (synthQueue.length > SYNTH_QUEUE_MAX) {
    synthQueue = synthQueue.slice(-SYNTH_QUEUE_MAX);
  }
  if (!isSynthSpeaking) processSynthQueue();
}

function processSynthQueue(): void {
  if (typeof window === 'undefined') return;
  const next = synthQueue.shift();
  if (!next) {
    isSynthSpeaking = false;
    setState({ status: state.mode === 'off' ? 'off' : 'idle', speakingRole: null });
    return;
  }
  isSynthSpeaking = true;
  endAwaitingResponse();
  setState({ status: 'speaking', speakingRole: next.role });

  // Engine routing: only use Web Speech if the user explicitly picked it,
  // OR if it's our last-resort fallback (no speechSynthesis would mean
  // we go straight to the adapter route). Previously we always used
  // speechSynthesis when available, ignoring the user's engine choice —
  // so picking Kokoro in settings still produced robotic OS voices.
  const cachedEngine = adapterEngineCache; // sync read; populated by prior fetch
  const useBrowser =
    cachedEngine === 'browser' ||
    (cachedEngine === null && window.speechSynthesis && state.hasWebSpeechTTS);
  if (useBrowser && window.speechSynthesis) {
    const utt = new SpeechSynthesisUtterance(next.text);
    utt.rate = config.rate;
    const voiceName = voiceForRole(next.role);
    if (voiceName) {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((vv) => vv.name === voiceName);
      if (v) utt.voice = v;
    }
    utt.onend = () => { processSynthQueue(); };
    utt.onerror = () => { processSynthQueue(); };
    window.speechSynthesis.speak(utt);
    // Kick off prefs fetch in the background so the next utterance can
    // route correctly once we know the user's pick.
    if (cachedEngine === null) void fetchPreferredEngine();
    return;
  }

  // Adapter route — Kokoro / ElevenLabs / OpenAI / Cartesia via the
  // server-side TTS preview endpoint (keys never leave the server).
  void synthViaAdapter(next.text, next.role).finally(() => processSynthQueue());
}

let adapterAudio: HTMLAudioElement | null = null;
let adapterEngineCache: string | null = null;
let adapterEngineCacheAt = 0;

async function fetchPreferredEngine(): Promise<string> {
  // Cache the prefs lookup for 30s so a chatty caller doesn't hammer the
  // prefs route once per utterance.
  const now = Date.now();
  if (adapterEngineCache && now - adapterEngineCacheAt < 30_000) return adapterEngineCache;
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (r.ok) {
      const prefs = await r.json();
      adapterEngineCache = prefs.ttsEngine ?? 'kokoro';
      adapterEngineCacheAt = now;
      return adapterEngineCache!;
    }
  } catch { /* fall through */ }
  return 'kokoro';
}

async function synthViaAdapter(text: string, role: string): Promise<void> {
  let engine = await fetchPreferredEngine();
  // 'browser' isn't synthable here (no speechSynthesis); coerce to kokoro.
  if (engine === 'browser') engine = 'kokoro';
  const voiceId = voiceForEngineRole(engine, role);
  try {
    const r = await fetch('/api/agent-mcp/operator-tts-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, text, voiceId }),
    });
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (adapterAudio) {
      try { adapterAudio.pause(); } catch {}
      try { URL.revokeObjectURL(adapterAudio.src); } catch {}
    }
    const a = new Audio(url);
    adapterAudio = a;
    await new Promise<void>((resolve) => {
      a.onended = () => { URL.revokeObjectURL(url); resolve(); };
      a.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      void a.play().catch(() => resolve());
    });
  } catch { /* ignore — keep queue flowing */ }
}

/**
 * Cancel any in-progress speech and clear the queue. Used for barge-in
 * and when voice mode is turned off.
 */
export function cancelAllSpeech(): void {
  synthQueue = [];
  isSynthSpeaking = false;
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
  if (adapterAudio) {
    try { adapterAudio.pause(); } catch {}
    try { URL.revokeObjectURL(adapterAudio.src); } catch {}
    adapterAudio = null;
  }
  if (state.status === 'speaking') {
    setState({ status: state.mode === 'off' ? 'off' : 'idle', speakingRole: null });
  }
}

/**
 * Get the list of available browser voices. Used by the settings UI.
 */
export function listAvailableVoices(): Array<{ name: string; lang: string }> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
}

/** Assign a specific voice to a role. */
export function assignVoiceToRole(role: string, voiceName: string): void {
  config.roleVoices = { ...config.roleVoices, [role]: voiceName };
  saveConfig();
}
