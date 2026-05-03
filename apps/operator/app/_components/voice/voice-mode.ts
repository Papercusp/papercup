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
 *   - Wake-word detection ("hey operator") for always-on mode
 *
 * The voice runtime is a singleton initialized once in the operator
 * shell. Components subscribe via `subscribeVoiceState()` and dispatch
 * via the public methods.
 */

import { stripWakeWordAndPrefix } from '../../../lib/wake-word';

export type VoiceModeStatus =
  | 'off'                    // Voice mode disabled
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
}

interface VoiceConfig {
  /** Wake word for always-on mode. Default: "hey operator". */
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
  wakeWord: 'hey operator',
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
};

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
    const raw = localStorage.getItem(STORAGE_KEY);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
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

  // Prime the TTS engine cache so the first speak() routes through
  // the user's chosen engine instead of defaulting to Browser TTS.
  void fetchPreferredEngine();

  // Restore last mode from config so navigation preserves user choice.
  // Skip if state.mode is already non-off (init may run again on hot reload).
  if (state.mode === 'off' && config.lastMode !== 'off') {
    setVoiceMode(config.lastMode);
  }

  // Pre-populate available voices once they're loaded by the browser.
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
  if (typeof window === 'undefined') return null;
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
    setState({ mode, status: 'off' });
    return;
  }
  setState({ mode, status: 'idle' });
  // STT engine selection (v4 §1.1): if Voicemode whisper is selected
  // and reachable, use the local capture loop; otherwise fall back to
  // Web Speech for both PTT and always-on.
  void maybeStartWhisperCapture(mode).catch(() => {
    // On failure, fall through to Web Speech path.
    if (mode === 'always-on') startWakeWordListening();
  });
}

let whisperCapture: { stop(): void } | null = null;

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
    if (prefs.sttEngine === 'deepgram') {
      // Deepgram cloud streaming (BYO key + leak-ack gate, same as Web Speech).
      if (!prefs.webSpeechLeakAcked) { startWakeWordListening(); return; }
      const bootR = await fetch('/api/agent-mcp/operator-stt-bootstrap?engine=deepgram').catch(() => null);
      if (!bootR?.ok) { startWakeWordListening(); return; }
      const apiKey: string | null = (await bootR.json())?.apiKey ?? null;
      if (!apiKey) { startWakeWordListening(); return; }
      const { startDeepgramStream } = await import('../../../lib/voice-engines/deepgram');
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
    const probe = await fetch('http://localhost:2022/health', { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!probe?.ok) {
      startWakeWordListening();
      return;
    }
    const { startWhisperCapture } = await import('./stt-voicemode');
    whisperCapture = await startWhisperCapture('http://localhost:2022', {
      onFinal: (text) => {
        setState({ lastTranscript: text });
        onUtteranceFinal(text);
      },
    });
  } catch {
    startWakeWordListening();
  }
}

function stopWhisperCaptureIfRunning(): void {
  if (whisperCapture) {
    try { whisperCapture.stop(); } catch { /* ignore */ }
    whisperCapture = null;
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

/** Push-to-talk: kick off active listening immediately. */
export function startPushToTalk(): void {
  if (!state.hasWebSpeechSTT) return;
  setState({ mode: 'push-to-talk', status: 'listening' });
  activateListening('');
}

/** Stop push-to-talk and finalize the current utterance. */
export function stopPushToTalk(): void {
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
}

const utteranceListeners = new Set<(text: string) => void>();

export function onFinalUtterance(listener: (text: string) => void): () => void {
  utteranceListeners.add(listener);
  return () => {
    utteranceListeners.delete(listener);
  };
}

function onUtteranceFinal(text: string): void {
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
  // Leader-election gate (v4 §2i): only the leader tab actually emits TTS.
  // Followers are silent; aria-live still publishes so screen-readers in any
  // tab see the text.
  try {
    const { getVoiceLeaderState } = require('./voice-leader') as typeof import('./voice-leader');
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
