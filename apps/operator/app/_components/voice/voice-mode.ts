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
  /** True if the browser actually supports Web Speech API. */
  supported: boolean;
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
  lastTranscript: '',
  speakingRole: null,
};

let config: VoiceConfig = { ...DEFAULT_CONFIG };

type Listener = (s: VoiceState) => void;
const listeners = new Set<Listener>();

let recognition: any = null;
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
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const supported = !!SR && !!window.speechSynthesis;
  setState({ supported });
  if (!supported) return;

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
  if (typeof window === 'undefined' || !state.supported) return;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onresult = (event: any) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    const lower = transcript.toLowerCase();
    if (lower.includes(config.wakeWord)) {
      // Wake word detected — switch to active listening.
      const idx = lower.lastIndexOf(config.wakeWord);
      const after = transcript.slice(idx + config.wakeWord.length).trim();
      activateListening(after);
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
    setState({ status: 'idle', lastTranscript: finalTranscript.trim() });
    // Notify listeners that a final transcript is ready (via state).
    if (finalTranscript.trim()) {
      onUtteranceFinal(finalTranscript.trim());
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
  if (!state.supported) return;
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
 * Speak text in the voice assigned to `role`. Queues if another role is
 * already speaking. Only one utterance plays at a time.
 */
export function speak(text: string, role = 'system:operator', priority: 'polite' | 'assertive' = 'polite'): void {
  if (state.mode === 'off' || !state.supported) return;
  // Tutorial gate (v4 §2l): voice no-ops until first-run tutorial is complete.
  if (typeof window !== 'undefined' && sessionStorage.getItem('oracle-tutorial-complete') !== 'true') return;
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
    if (leader.available && !leader.isLeader) return;
  } catch { /* leader module not yet loaded — fall through and speak */ }
  synthQueue.push({ text, role });
  if (!isSynthSpeaking) processSynthQueue();
}

function processSynthQueue(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const next = synthQueue.shift();
  if (!next) {
    isSynthSpeaking = false;
    setState({ status: state.mode === 'off' ? 'off' : 'idle', speakingRole: null });
    return;
  }
  isSynthSpeaking = true;
  setState({ status: 'speaking', speakingRole: next.role });
  const utt = new SpeechSynthesisUtterance(next.text);
  utt.rate = config.rate;
  const voiceName = voiceForRole(next.role);
  if (voiceName) {
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find((vv) => vv.name === voiceName);
    if (v) utt.voice = v;
  }
  utt.onend = () => {
    processSynthQueue();
  };
  utt.onerror = () => {
    processSynthQueue();
  };
  window.speechSynthesis.speak(utt);
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
