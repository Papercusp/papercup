/**
 * Voice preferences storage (Phase 1c of voice-mode plan v4).
 *
 * Source of truth: `harness_shared.operator_voice_prefs` (PG, migration 020).
 * Was previously `<papercuspRoot>/system/operator/voice-prefs.json`. The
 * file approach worked but moving to PG unifies multi-tab + multi-machine
 * state with the rest of the operator-state migration.
 *
 * Schema (the JSONB payload) covers:
 *   - 7 feature toggles (suggestion announcements, toasts, flips, etc.)
 *   - 3 engine selectors (sttEngine, ttsEngine, elevenlabsVoiceId)
 *   - 1 leak-warning consent record (webSpeechLeakAcked)
 *   - 1 hardware-suggestion ack (kokoroSlowSuggestionDismissed)
 *   - Internal state: nudge dedup last-spoken-at per kind
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export type SttEngineKind = 'voicemode' | 'webspeech' | 'deepgram' | 'off';
export type TtsEngineKind = 'kokoro' | 'browser' | 'elevenlabs' | 'openai' | 'cartesia';
/**
 * Full-agent engine — bundles STT + LLM + TTS + intent dispatch in one
 * connection. When set to anything other than 'off', it OVERRIDES
 * sttEngine + ttsEngine: voice-mode.ts uses the full-agent transport
 * and bypasses the per-utterance pipeline.
 */
export type FullAgentEngineKind =
  | 'off'
  | 'openai-realtime'
  | 'gemini-live'
  | 'elevenlabs-conversational'  // legacy alias of elevenlabs-conv
  | 'elevenlabs-conv';            // primary in v5+ (Conv AI agent platform)

export interface VoicePrefs {
  // Feature toggles (defaults reflect v4 §3.2)
  speakSuggestions: boolean;        // ON
  speakBackgroundToasts: boolean;   // ON
  speakReceivingFlips: boolean;     // OFF — chatty
  speakEscalations: boolean;        // ON — significant
  speakCadenceStatus: boolean;      // OFF — chatty
  speakNudges: boolean;             // ON
  wakeWordIntents: boolean;         // ON
  /** Speak open chat:ask_choice card prompts aloud when voice is on. */
  speakOpenCards: boolean;          // ON
  /** Allow STT transcripts to resolve voiceAnswerable cards via /card-response. */
  cardAnsweringEnabled: boolean;    // ON
  /**
   * After a silence-nudge card opens with no response, tear down the
   * active EL Conv AI session this many seconds later. Wake-word
   * listener kicks in (when configured) so the user can resume
   * hands-free. Range 5-120; 0 disables teardown entirely.
   */
  silenceNudgeGraceSecs: number;    // 30
  /**
   * Speak a short handoff cue ("Going to wake-word listening...")
   * when the silence-nudge grace timer tears down the EL session.
   * No-op when EL wasn't active or wake-word isn't configured.
   */
  speakSessionHandoff: boolean;     // ON

  // ── Operator behavior (active-mode proactive responses) ──────────
  /**
   * Master toggle for active-mode auto-fire on terminal turns. When
   * false, terminal turns just terminate (passive behavior in active
   * mode too — manual "Generate ideas" button still works).
   * Plan: active-mode-proactive-ticks-2026-05-14.md §C.4.
   */
  proactiveTicksEnabled: boolean;   // ON
  /**
   * Maximum number of `<continue/>` chains the brain can run before
   * the runtime force-waits for user input. Prevents runaway chains.
   */
  maxConsecutiveContinues: number;  // 5
  /**
   * Maximum wall-clock duration (seconds) of a single `<continue/>`
   * chain. Forces a wait once exceeded, even if `maxConsecutiveContinues`
   * hasn't been hit.
   */
  maxContinueChainSecs: number;     // 300

  // Engine selection
  sttEngine: SttEngineKind;
  ttsEngine: TtsEngineKind;
  /** Full-agent engine. When set to anything but 'off', overrides STT + TTS. */
  fullAgentEngine: FullAgentEngineKind;

  // P2P voice-channel settings (holepunch-voice-channels-2026-06-05 P-016/D-008).
  // Devices are client-side ids (cpal device name on the pui; MediaDeviceInfo
  // id on desktop); null = system default.
  voiceInputDevice: string | null;
  voiceOutputDevice: string | null;
  /** Channel input mode — push-to-talk or open mic (open mic wants AEC on). */
  voiceInputMode: 'ptt' | 'open-mic';
  /** PTT key in the client keymap space (the pui binds single chars). */
  voicePttKey: string;
  /** Acoustic echo cancellation for channel audio. */
  voiceAec: boolean;
  /** Noise suppression for channel audio. */
  voiceNoiseSuppression: boolean;
  /** Mic gain multiplier (0.0–4.0, 1.0 = unity). */
  voiceInputGain: number;
  /** Playback volume multiplier (0.0–2.0, 1.0 = unity). */
  voiceOutputVolume: number;
  /**
   * Wake-word engine. 'off' = transcribe-everything-then-string-match (current default);
   * 'porcupine' = Picovoice Porcupine (commercial, free for dev, BYO key);
   * 'openwakeword' = openWakeWord (Apache 2.0, no key, custom-trainable).
   */
  wakeWordEngine: 'off' | 'porcupine' | 'openwakeword';
  /** Wake-word keyword. Each engine has its own model name space. */
  porcupineKeyword: 'Computer' | 'Jarvis' | 'Bumblebee' | 'Picovoice' | 'Porcupine' | 'Alexa' | 'Hey Google' | 'Hey Siri' | 'Okay Google' | 'Terminator' | 'Americano' | 'Blueberry' | 'Grapefruit' | 'Grasshopper';
  openwakewordKeyword: 'alexa' | 'hey_jarvis' | 'hey_mycroft' | 'hey_rhasspy' | 'ok_nabu' | 'weather' | 'timer';
  /**
   * Noise suppression engine for the mic input.
   * 'browser' = built-in WebRTC noiseSuppression (free, default);
   * 'rnnoise' = Jitsi RNNoise WASM (BSD, stronger);
   * 'koala' = Picovoice Koala (commercial, BYO key);
   * 'off' = no suppression.
   */
  noiseSuppressionEngine: 'off' | 'browser' | 'rnnoise' | 'koala';
  elevenlabsVoiceId: string;        // default Adam preset
  openaiVoice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  openaiModel: 'tts-1' | 'tts-1-hd';
  cartesiaVoiceId: string;
  cartesiaModel: 'sonic' | 'sonic-2';

  /**
   * ElevenLabs Conversational AI agent ID (`agent_…`). Required when
   * fullAgentEngine === 'elevenlabs-conv'. Set in /settings/voice;
   * separate from the ElevenLabs API key (which lives in
   * voice-credentials and is shared with the TTS path).
   */
  elevenLabsAgentId: string;
  /**
   * Historical: auto-open the operator panel when a delegate completed
   * with a result that should be shown.
   */
  voicePanelAutoOpen: boolean;
  /**
   * Cached scan / verbatim readout cap. Voice speaks fullText if its
   * word count is ≤ this; otherwise speaks gist + 'details in panel'.
   * Default 120 words ≈ 60s of speech at standard rates.
   */
  voiceMaxSpokenWords: number;
  /**
   * Long-op narration: announce when replan / supervisor / cleanup /
   * provision start, occasionally during, and at completion. Side-channel
   * TTS — bypasses the EL Conv AI agent. Default ON. See
   * /docs/agents/operator-persona §6.
   */
  narrateLongOps: boolean;
  /**
   * Operator may reference short anecdotes from prior work when the
   * trigger matches. Limited to a few times per session. Default ON.
   * See /docs/agents/operator-persona §7.
   */
  operatorBackstoryEnabled: boolean;
  /**
   * On every fresh app load, seed the operator's interaction mode to
   * 'active' (continuous turn-taking, silence prompts, the operator
   * brings ideas out of the user). Default ON. The user can toggle
   * mid-session via the navbar; the mode-flip is sessionStorage so a
   * refresh re-seeds from this setting. See OperatorConversationProvider
   * for the state machine, OperatorActiveToggle for the navbar control.
   */
  operatorActiveOnStartup: boolean;
  /**
   * Auto-disconnect EL Conv AI / Realtime full-agent sessions after
   * this many minutes of USER inactivity (agent transcripts don't reset
   * the timer — see voice-mode.ts onAssistantText). Mic streams
   * continuously while connected — silence still costs minutes.
   * 0 = never auto-disconnect. Default 2 minutes (was 5 — too generous;
   * EL credit-burn audit recommended tighter).
   */
  fullAgentIdleTimeoutMin: number;
  /**
   * Hard maximum session duration in minutes. Regardless of activity,
   * the session auto-disconnects after this many minutes. Backstop for
   * edge cases where idle-detection fails (stuck transcripts, abandoned
   * tabs, etc.). 0 = no max. Default 30 minutes.
   */
  fullAgentSessionMaxMin: number;
  /**
   * Conversation flow mode for full-agent voice. Workspace default; each
   * device may override locally (mobile in EncryptedSharedPrefs/UserDefaults,
   * desktop in ~/.papercusp/desktop-voice-prefs.json) and pass it as a
   * `mode=` query param to /voice-session-init.
   *
   * - 'continuous' (default): session stays open until user / idle / max.
   *   Matches ChatGPT mobile voice.
   * - 'hybrid': continuous + agent calls end_conversation after a
   *   definitive answer. Best for transactional commands ("mark X done").
   * - 'single-utterance': one turn, then disconnect. Idle drops to ~3s.
   *   Most cost-conservative; best for cellular.
   *
   * The phone/desktop sends its choice to /voice-session-init, which
   * passes it through to EL as dynamic_variables.voice_mode. The agent's
   * system prompt branches on this and is one source of truth for the
   * 3 behaviors. end_conversation tool is registered on the agent for
   * all modes — only the prompt instructions differ.
   */
  fullAgentVoiceMode: 'continuous' | 'hybrid' | 'single-utterance';
  /**
   * How many tokens of recent chat history the operator brain sees per
   * converse turn. Replaces the legacy 30-turn fixed cap. The route
   * walks messages newest → oldest, accumulating until this budget is
   * hit. Higher = better long-conversation recall, more $ per reply.
   * Default 40000 (~10-15% of Claude's 200k context). Range 5000-150000.
   */
  operatorHistoryTokenBudget: number;
  /**
   * How the operator brain keeps long-conversation context
   * (operator-context-compaction-2026-06-05 D-001):
   *   - 'compaction' (default): recent turns verbatim (within
   *     operatorHistoryTokenBudget) + a rolling PG-stored summary of every
   *     older turn — the operator remembers the gist of the WHOLE
   *     conversation at bounded cost.
   *   - 'window': the legacy escape hatch — verbatim recent window only;
   *     anything older than the budget is forgotten.
   */
  operatorContextMode: 'compaction' | 'window';
  /**
   * Hard monthly cap on ElevenLabs Conv AI minutes. Once the current
   * month's usage reaches this number, voice-mode refuses to start a
   * new session and surfaces a toast. 0 = uncapped. Default 600 min
   * (10 hours; sized for a moderate Pro-plan user with overage room).
   */
  fullAgentMonthlyMinuteCap: number;
  /**
   * Privacy mode for the EL Conv AI / Realtime full-agent path.
   *   - 'always-on' (default): mic streams continuously to the provider
   *     while the session is connected. Lowest latency, highest cost,
   *     audio leaves the box at rest.
   *   - 'wake-word-gated': local wake-word engine listens on-device;
   *     mic only streams to the provider after the wake word fires
   *     and until the gated-idle timer ends the session. Privacy +
   *     cost win, ~1.5s extra latency on the first turn after wake.
   */
  voicePrivacyMode: 'always-on' | 'wake-word-gated';
  /**
   * Idle timeout (seconds) used when voicePrivacyMode='wake-word-gated'.
   * Tighter than fullAgentIdleTimeoutMin since session restart is
   * cheap (just say the wake word again). Default 20s.
   */
  wakeGatedIdleTimeoutSec: number;
  /**
   * BCP-47 language code passed to ElevenLabs Conv AI as the agent's
   * `language` override at session start. Pinning the language stops
   * EL's STT auto-detect from flipping to e.g. Spanish when background
   * music or ambient noise has speech-like spectral features.
   *
   * Default 'en'. Users who want the agent to handle multiple languages
   * can set it empty (`''`) to let EL auto-detect — at the cost of the
   * noise-mishear failure mode.
   *
   * Supported codes match EL's Conv AI language list (en, es, fr, de,
   * pt, it, pl, nl, hi, ja, ko, zh, ar, …). See:
   * https://elevenlabs.io/docs/conversational-ai/customization/language
   */
  agentLanguage: string;

  /**
   * Embedder choice for the mem0 memory layer (Plan 3).
   *   'auto'     — prefer OpenAI if key present, else local, else off
   *   'openai'   — force OpenAI text-embedding-3-small (cheap, fast,
   *                requires openai_api_key in /settings/api-keys)
   *   'local'    — force @huggingface/transformers BGE-small (free,
   *                ~400MB RAM, ~120MB disk; works offline)
   *   'disabled' — turn memory off entirely (memory:* tools no-op)
   *
   * Switching modes uses per-mode collection names in pgvector, so
   * existing memories aren't corrupted but become "hidden" until you
   * switch back. See lib/memory/mem0-client.ts.
   */
  memoryEmbedderMode: 'auto' | 'openai' | 'local' | 'disabled';

  /**
   * Who the operator thinks it's talking to. Controls which audience-mode
   * persona overlay is injected at the start of the system prompt.
   *   'engineer' (default) — terse, technical, peer-to-peer
   *   'novice'             — warm, plain-English, outcome-framed
   */
  audienceMode: 'engineer' | 'novice';

  /**
   * Which human-facing brain/persona the LIVE converse paths (voice host +
   * text panel + device/mobile) run behind `ask_operator` / `*:converse`
   * (sentinel-herald P-011/P-012).
   *   'operator' (default) — the existing operator persona; live voice stays
   *                          byte-for-byte unchanged.
   *   'sentinel'           — the Sentinel Herald persona (loads `sentinel:converse`).
   *
   * DECOUPLED from the Sentinel sidebar flag (that flag shows the settings
   * tab; this pref switches the live brain). A deliberate, reversible toggle.
   */
  humanFacingRole: 'operator' | 'sentinel';

  /**
   * Do-not-disturb for the Sentinel herald (sentinel-as-herald-2026-06-21).
   * When true, the herald stays quiet — a single live pause lever the user
   * can flip on/off from the Sentinel sidebar tab without unwinding every
   * individual speak* toggle. Default false (herald speaks).
   */
  silenceVoice: boolean;

  // One-time consents
  webSpeechLeakAcked: boolean;
  kokoroSlowSuggestionDismissed: boolean;

  // Internal: persisted nudge dedup last-spoken-at per kind
  nudgeDedup: {
    budget:  { lastSpokenAt: string | null };
    breaker: { lastSpokenAt: string | null };
    pause:   { lastSpokenAt: string | null };
  };
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  speakSuggestions: true,
  speakBackgroundToasts: true,
  speakReceivingFlips: false,
  speakEscalations: true,
  speakCadenceStatus: false,
  speakNudges: true,
  silenceVoice: false,
  wakeWordIntents: true,
  speakOpenCards: true,
  cardAnsweringEnabled: true,
  silenceNudgeGraceSecs: 30,
  speakSessionHandoff: true,
  proactiveTicksEnabled: true,
  maxConsecutiveContinues: 5,
  maxContinueChainSecs: 300,
  sttEngine: 'voicemode',
  ttsEngine: 'kokoro',
  fullAgentEngine: 'off',
  voiceInputDevice: null,
  voiceOutputDevice: null,
  voiceInputMode: 'ptt',
  voicePttKey: 'v',
  voiceAec: true,
  voiceNoiseSuppression: true,
  voiceInputGain: 1,
  voiceOutputVolume: 1,
  wakeWordEngine: 'off',
  porcupineKeyword: 'Computer',
  openwakewordKeyword: 'hey_jarvis',
  noiseSuppressionEngine: 'browser',
  elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM', // Adam preset
  openaiVoice: 'nova',
  openaiModel: 'tts-1',
  cartesiaVoiceId: 'a0e99841-438c-4a64-b679-ae501e7d6091', // Barbershop Man, common preset
  cartesiaModel: 'sonic-2',
  elevenLabsAgentId: '',
  voicePanelAutoOpen: true,
  voiceMaxSpokenWords: 120,
  narrateLongOps: true,
  operatorBackstoryEnabled: true,
  operatorActiveOnStartup: true,
  fullAgentIdleTimeoutMin: 2,
  fullAgentSessionMaxMin: 30,
  fullAgentVoiceMode: 'continuous',
  operatorHistoryTokenBudget: 40000,
  operatorContextMode: 'compaction',
  fullAgentMonthlyMinuteCap: 600,
  voicePrivacyMode: 'always-on',
  wakeGatedIdleTimeoutSec: 20,
  agentLanguage: 'en',
  memoryEmbedderMode: 'auto',
  audienceMode: 'engineer',
  humanFacingRole: 'operator',
  webSpeechLeakAcked: false,
  kokoroSlowSuggestionDismissed: false,
  nudgeDedup: {
    budget:  { lastSpokenAt: null },
    breaker: { lastSpokenAt: null },
    pause:   { lastSpokenAt: null },
  },
};

/**
 * Workspace-only prefs, skipping the per-user override merge. Use when
 * you need the raw workspace value (e.g. the /settings/user override
 * UI shows BOTH workspace-default AND the user override, so it can't
 * use loadVoicePrefs which already merges them).
 */
export async function loadWorkspaceVoicePrefs(): Promise<VoicePrefs> {
  const raw = await readOperatorState<Partial<VoicePrefs>>('operator_voice_prefs');
  if (!raw) return { ...DEFAULT_VOICE_PREFS };
  return mergePrefs(DEFAULT_VOICE_PREFS, raw);
}

export async function loadVoicePrefs(): Promise<VoicePrefs> {
  const raw = await readOperatorState<Partial<VoicePrefs>>('operator_voice_prefs');
  // Merge with defaults so newly-added fields don't break old rows.
  // EL credit-burn audit concern #3: existing installs whose PG row
  // pre-dates a new field (e.g. agentLanguage, fullAgentSessionMaxMin)
  // inherit DEFAULT_VOICE_PREFS values via this merge. No migration
  // needed for ADDED fields — only CHANGED defaults of existing fields
  // (concern #6, fullAgentIdleTimeoutMin 5→2) require a one-shot
  // migration if you want to retroactively apply.
  const workspace = raw
    ? mergePrefs(DEFAULT_VOICE_PREFS, raw)
    : { ...DEFAULT_VOICE_PREFS };

  // Per-user overrides on top of workspace (Plan 4). If no session
  // user, returns workspace prefs unchanged. User-level overrides only
  // apply to the specific keys in VOICE_USER_OVERRIDE_KEYS — other
  // settings (engine, monthly cap, dedup state) stay workspace-scoped.
  try {
    const { getSessionUser } = await import('./auth');
    const { loadUserPreferences, mergeUserOverWorkspace, VOICE_USER_OVERRIDE_KEYS } =
      await import('./user-preferences');
    const user = await getSessionUser();
    if (!user) return workspace;
    const userPrefs = await loadUserPreferences(user.id);
    return mergeUserOverWorkspace(workspace, userPrefs, VOICE_USER_OVERRIDE_KEYS);
  } catch {
    // Loading user-prefs is best-effort; if cookies aren't available
    // (background workers, MCP routes) we fall through to workspace.
    return workspace;
  }
}

export async function saveVoicePrefs(patch: Partial<VoicePrefs>): Promise<VoicePrefs> {
  const current = await loadVoicePrefs();
  const next = mergePrefs(current, patch);
  await writeOperatorState('operator_voice_prefs', next);
  return next;
}

function mergePrefs(base: VoicePrefs, patch: Partial<VoicePrefs>): VoicePrefs {
  const out: VoicePrefs = { ...base, ...patch };
  // Clamp operatorHistoryTokenBudget to a sane range. Fall back to the
  // base default on NaN / negative / absurdly small / absurdly large.
  const budget = Number(out.operatorHistoryTokenBudget);
  if (!Number.isFinite(budget) || budget < 5000 || budget > 150000) {
    out.operatorHistoryTokenBudget = base.operatorHistoryTokenBudget ?? 40000;
  } else {
    out.operatorHistoryTokenBudget = Math.round(budget);
  }
  // Closed enum guard for operatorContextMode — anything unrecognized
  // falls back to the default ('compaction').
  if (out.operatorContextMode !== 'compaction' && out.operatorContextMode !== 'window') {
    out.operatorContextMode = base.operatorContextMode ?? 'compaction';
  }
  // Deep-merge nudgeDedup so partial patches don't drop unwritten kinds.
  if (patch.nudgeDedup) {
    out.nudgeDedup = {
      budget:  { ...base.nudgeDedup.budget,  ...patch.nudgeDedup.budget  },
      breaker: { ...base.nudgeDedup.breaker, ...patch.nudgeDedup.breaker },
      pause:   { ...base.nudgeDedup.pause,   ...patch.nudgeDedup.pause   },
    };
  } else {
    out.nudgeDedup = {
      budget:  { ...base.nudgeDedup.budget  },
      breaker: { ...base.nudgeDedup.breaker },
      pause:   { ...base.nudgeDedup.pause   },
    };
  }
  return out;
}

/**
 * Internal/derived keys that are NOT user-facing tunables: `nudgeDedup` is
 * last-spoken-at bookkeeping (not config), and `webSpeechLeakAcked` /
 * `kokoroSlowSuggestionDismissed` are one-shot consent acks. They're excluded
 * from the override diff so config:list-overrides shows only real config drift.
 */
const VOICE_NON_TUNABLE_KEYS = new Set<keyof VoicePrefs>([
  'nudgeDedup',
  'webSpeechLeakAcked',
  'kokoroSlowSuggestionDismissed',
]);

/** Reset workspace voice-prefs to DEFAULT_VOICE_PREFS (clears every override). Writes the full
    default row directly (NOT through saveVoicePrefs, which merges over current). The concern's
    reset; per-user overrides in user_preferences are a separate layer and untouched. */
export async function resetWorkspaceVoicePrefs(): Promise<VoicePrefs> {
  const next = { ...DEFAULT_VOICE_PREFS };
  await writeOperatorState('operator_voice_prefs', next);
  return next;
}

/** The WORKSPACE-layer keys that diverge from DEFAULT_VOICE_PREFS (skipping internal/derived
    keys). Compared by value (JSON for the rare non-scalar) so a flipped toggle or retuned engine
    surfaces as one entry. This is the workspace default-vs-override shape; the per-user layer
    (user_preferences + VOICE_USER_OVERRIDE_KEYS) is reported by its own concern, not here. */
function voicePrefsOverrides(ws: VoicePrefs): OverrideEntry[] {
  const out: OverrideEntry[] = [];
  for (const k of Object.keys(DEFAULT_VOICE_PREFS) as (keyof VoicePrefs)[]) {
    if (VOICE_NON_TUNABLE_KEYS.has(k)) continue;
    const eff = ws[k];
    const def = DEFAULT_VOICE_PREFS[k];
    const differs = typeof eff === 'object' || typeof def === 'object'
      ? JSON.stringify(eff) !== JSON.stringify(def)
      : eff !== def;
    if (differs) out.push({ key: k, effective: eff, default: def, layer: 'pg-settings' });
  }
  return out;
}

// Self-register as a runtime-config override concern (P-024 registry / sentinel-herald P-037):
// the WORKSPACE-level voice/operator prefs that diverge from DEFAULT_VOICE_PREFS show up in
// config:list-overrides, and config:reset-overrides reverts them to defaults. Lazy-imports
// loadWorkspaceVoicePrefs at call time (it's defined above; the concern just references it).
registerOverrideConcern({
  name: 'voice-prefs',
  description: 'workspace voice/operator prefs diverging from defaults (operator_voice_prefs)',
  auditAction: 'operator:voice_prefs',
  diff: async () => voicePrefsOverrides(await loadWorkspaceVoicePrefs()),
  capture: () => loadWorkspaceVoicePrefs(),
  reset: () => resetWorkspaceVoicePrefs(),
  restore: async (snap) => { await writeOperatorState('operator_voice_prefs', snap as VoicePrefs); },
});
