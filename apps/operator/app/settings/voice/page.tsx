'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'next-view-transitions';

import { toast } from 'sonner';
import { LazyDetails } from '../../_components/LazyDetails';
import { Checkbox } from '../../harness/Checkbox';
import {
  initVoiceMode,
  listAvailableVoices,
  getVoiceConfig,
  updateVoiceConfig,
  assignVoiceToRole,
  speak,
} from '@/app/_components/voice/voice-mode';
import type { VoicePrefs, SttEngineKind, TtsEngineKind } from '@/lib/voice-prefs';
import type { TtsSpendState } from '@/lib/tts-spend';
import type { SttSpendState } from '@/lib/stt-spend';

const KNOWN_ROLES = [
  'system:operator',
  'system:operator-nudge',
  'system:oracle',
  'harness',          // generic fallback for receiving-flips
  'orchestrator',
  'worker',
  'validator',
  'architect',
  'scoper',
  'plan-gate',
  'documenter',
  'summarizer',
  'curator',
  'debugger',
  'crosscheck',
  'ui-qa',
  'project_manager',
  'director',
  'coordinator',
  'auditor',
];

interface ApiKeyState { configured: boolean; apiKey: string | null }
interface CloudCredentialsSnapshot {
  elevenlabs: ApiKeyState;
  openai: ApiKeyState;
  cartesia: ApiKeyState;
  deepgram: ApiKeyState;
  picovoice: ApiKeyState;
  google: ApiKeyState;
}
type ElevenLabsKeyState = ApiKeyState;
interface ElevenLabsConnTest { ok: boolean; tier?: string; characterCount?: number; characterLimit?: number; email?: string | null; error?: string }
interface ElevenLabsVoice { id: string; name: string; lang?: string }

export default function VoiceSettingsPage() {
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [config, setConfig] = useState(() => getVoiceConfig());

  // v4 prefs + engine state
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [credentials, setCredentials] = useState<ElevenLabsKeyState>({ configured: false, apiKey: null });
  const [allCreds, setAllCreds] = useState<CloudCredentialsSnapshot | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [connTest, setConnTest] = useState<ElevenLabsConnTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [elevenVoices, setElevenVoices] = useState<ElevenLabsVoice[]>([]);
  const [spend, setSpend] = useState<TtsSpendState | null>(null);
  const [sttSpend, setSttSpend] = useState<SttSpendState | null>(null);
  const [showLeakWarning, setShowLeakWarning] = useState(false);

  useEffect(() => {
    initVoiceMode();
    setConfig(getVoiceConfig());

    // Browsers fire `voiceschanged` exactly once after the voice list
    // is populated. Listen for that AND poll a few times in case the
    // browser doesn't emit the event (some Linux Chromium builds);
    // stop polling as soon as voices arrive or after a short window so
    // we don't churn the page on environments without Web Speech (Tauri
    // WebKitGTK), where the list stays empty forever.
    let stopped = false;
    let attempts = 0;
    const maxAttempts = 10; // 10 × 500ms = 5s ceiling
    let interval: ReturnType<typeof setInterval> | null = null;

    const tryRefresh = () => {
      if (stopped) return;
      const v = listAvailableVoices();
      if (v.length) {
        // Only set state when the list actually changed length — avoids
        // a no-op render loop.
        setVoices((prev) => (prev.length === v.length ? prev : v));
        stopped = true;
        if (interval) clearInterval(interval);
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        stopped = true;
        if (interval) clearInterval(interval);
      }
    };

    tryRefresh();
    interval = setInterval(tryRefresh, 500);

    const onVoicesChanged = () => tryRefresh();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.addEventListener?.('voiceschanged', onVoicesChanged);
    }

    void Promise.all([
      fetch('/api/agent-mcp/operator-voice-prefs').then((r) => r.ok ? r.json() : null),
      fetch('/api/agent-mcp/operator-credentials').then((r) => r.ok ? r.json() : null),
      fetch('/api/agent-mcp/operator-tts-spend').then((r) => r.ok ? r.json() : null),
      fetch('/api/agent-mcp/operator-stt-spend').then((r) => r.ok ? r.json() : null),
    ]).then(([p, c, s, ss]) => {
      if (p) setPrefs(p as VoicePrefs);
      if (c?.elevenlabs) setCredentials(c.elevenlabs);
      if (c) setAllCreds(c as CloudCredentialsSnapshot);
      if (s) setSpend(s as TtsSpendState);
      if (ss) setSttSpend(ss as SttSpendState);
    });

    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.removeEventListener?.('voiceschanged', onVoicesChanged);
      }
    };
  }, []);

  const savePrefsPatch = useCallback(async (patch: Partial<VoicePrefs>) => {
    setSavingPrefs(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-voice-prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (r.ok) setPrefs(await r.json());
    } finally {
      setSavingPrefs(false);
    }
  }, []);

  const onAssign = useCallback((role: string, voiceName: string) => {
    assignVoiceToRole(role, voiceName);
    setConfig(getVoiceConfig());
  }, []);

  const onTest = useCallback((role: string) => {
    speak(`This is the voice for ${role.replace(':', ' ')}.`, role, 'polite', { force: true });
  }, []);

  const onTestVoice = useCallback(() => {
    speak('Voice mode is working.', 'system:operator', 'polite', { force: true });
  }, []);

  const onTestAllRoles = useCallback(() => {
    if (prefs?.ttsEngine === 'elevenlabs') {
      if (!confirm(`Test all ${KNOWN_ROLES.length} roles? This will send ~${KNOWN_ROLES.length} requests to ElevenLabs (≈${(KNOWN_ROLES.length * 0.04).toFixed(2)} estimated charges).`)) return;
    }
    KNOWN_ROLES.forEach((role, i) => {
      setTimeout(() => speak(`This is the ${role.replace(':', ' ')} voice.`, role, 'polite', { force: true }), i * 1500);
    });
  }, [prefs?.ttsEngine]);

  const onRedetect = useCallback(() => {
    // The chrome's voice-engines.ts caches detection; re-fetching prefs
    // triggers a fresh probe on next speak(). For now we just refetch
    // prefs + spend so the UI reflects current state.
    void fetch('/api/agent-mcp/operator-voice-prefs')
      .then((r) => r.ok ? r.json() : null)
      .then((p) => { if (p) setPrefs(p as VoicePrefs); });
    toast.info('Re-detecting engines. Reload the page if engine status doesn\'t update.');
  }, []);

  const setSttEngine = useCallback((kind: SttEngineKind) => {
    if ((kind === 'webspeech' || kind === 'deepgram') && !prefs?.webSpeechLeakAcked) {
      setShowLeakWarning(true);
      return;
    }
    void savePrefsPatch({ sttEngine: kind });
  }, [prefs?.webSpeechLeakAcked, savePrefsPatch]);

  const ackLeakWarning = useCallback(async () => {
    await savePrefsPatch({ webSpeechLeakAcked: true, sttEngine: 'webspeech' });
    setShowLeakWarning(false);
  }, [savePrefsPatch]);

  const setTtsEngine = useCallback((kind: TtsEngineKind) => {
    void savePrefsPatch({ ttsEngine: kind });
    if (kind === 'elevenlabs' && credentials.configured) {
      void fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': credentials.apiKey ?? '' },
      }).catch(() => {});
    }
  }, [savePrefsPatch, credentials]);

  const onSaveKey = useCallback(async () => {
    if (!keyDraft.trim()) return;
    const r = await fetch('/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elevenlabsApiKey: keyDraft.trim() }),
    });
    if (r.ok) {
      setCredentials((await r.json()).elevenlabs);
      setKeyDraft('');
      toast.success('ElevenLabs key saved');
    }
  }, [keyDraft]);

  const onClearKey = useCallback(async () => {
    if (!confirm('Clear the ElevenLabs API key?')) return;
    const r = await fetch('/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elevenlabsApiKey: null }),
    });
    if (r.ok) {
      setCredentials((await r.json()).elevenlabs);
      setConnTest(null);
      setElevenVoices([]);
    }
  }, []);

  const onTestConnection = useCallback(async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-elevenlabs-test', { method: 'POST' });
      const data: ElevenLabsConnTest = await r.json();
      setConnTest(data);
      if (data.ok) {
        // Populate voice picker
        try {
          const vr = await fetch('https://api.elevenlabs.io/v1/voices');
          // Note: this won't work without the API key in the request — proxy via server in production.
          // For now, we rely on the connection-test passing and fall back to a default list.
          if (vr.ok) {
            const body = await vr.json();
            const list = (body?.voices ?? []) as Array<{ voice_id: string; name: string }>;
            setElevenVoices(list.map((v) => ({ id: v.voice_id, name: v.name })));
          }
        } catch { /* ignore */ }
        toast.success(`ElevenLabs connected — ${data.tier} tier`);
      } else {
        toast.error(`ElevenLabs test failed: ${data.error ?? 'unknown'}`);
      }
    } finally {
      setTesting(false);
    }
  }, []);

  const onRateUiChange = useCallback((rate: number) => {
    updateVoiceConfig({ rate });
    setConfig(getVoiceConfig());
  }, []);

  const onWakeWordChange = useCallback((wakeWord: string) => {
    updateVoiceConfig({ wakeWord });
    setConfig(getVoiceConfig());
  }, []);

  const updateSpendKnob = useCallback(async (patch: Partial<TtsSpendState>) => {
    const r = await fetch('/api/agent-mcp/operator-tts-spend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) setSpend(await r.json());
  }, []);

  const todaySpend = spend?.spend?.[0];

  // Hold the render until the prefs fetch resolves. Otherwise every
  // `prefs?.sttEngine ?? 'voicemode'` style fallback in the JSX paints
  // the default value, then the fetch lands and every control snaps to
  // its real value half a second later. The skeleton matches the real
  // layout's outer dimensions so there's no shift when prefs arrives.
  if (!prefs) {
    return (
      <div style={{ padding: '8px 4px', maxWidth: 880 }} aria-busy="true">
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Voice mode</h1>
        <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
          Loading your voice settings…
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 4px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Voice mode</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
        Voice runs in the browser. Local Voicemode (Whisper STT + Kokoro TTS) is the default;
        ElevenLabs cloud TTS is opt-in with bring-your-own API key.
      </p>

      {/* ── ENGINE SELECTORS ─────────────────────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Engines</h2>
        {(() => {
          const fullAgentOn = (prefs?.fullAgentEngine ?? 'off') !== 'off';
          const sttTtsDisabled = savingPrefs || fullAgentOn;
          const sttTtsDimStyle: React.CSSProperties = fullAgentOn
            ? { opacity: 0.5, pointerEvents: 'none' as const }
            : {};
          return (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={lbl}>Full-agent engine</label>
                <select
                  value={prefs?.fullAgentEngine ?? 'off'}
                  onChange={(e) => savePrefsPatch({ fullAgentEngine: e.target.value as VoicePrefs['fullAgentEngine'] })}
                  style={sel}
                  disabled={savingPrefs}
                >
                  <option value="off">Off — use the STT + TTS pair below</option>
                  <option value="openai-realtime" disabled={!allCreds?.openai?.configured}>
                    OpenAI Realtime (gpt-4o-realtime){!allCreds?.openai?.configured ? ' — needs OpenAI key' : ''}
                  </option>
                  <option value="gemini-live" disabled={!allCreds?.google?.configured}>
                    Google Gemini Live (multimodal){!allCreds?.google?.configured ? ' — needs Google AI key' : ''}
                  </option>
                  <option value="elevenlabs-conversational" disabled={!allCreds?.elevenlabs?.configured}>
                    ElevenLabs Conversational AI{!allCreds?.elevenlabs?.configured ? ' — needs ElevenLabs key' : ''}
                  </option>
                </select>
                <p style={hint}>
                  Full-agent mode replaces the STT + TTS pair with a single conversational session.
                  Costs ~$0.06/min audio in + $0.24/min audio out (~$18/hr). Requires an OpenAI API key.
                  Intents (open / scan / approve / across workspaces) become tool calls — the model handles them naturally.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, ...sttTtsDimStyle }}
                   aria-disabled={fullAgentOn}>
                <div>
                  <label style={lbl}>STT (speech → text){fullAgentOn ? ' — overridden by full-agent' : ''}</label>
                  <select
                    value={prefs?.sttEngine ?? 'voicemode'}
                    onChange={(e) => setSttEngine(e.target.value as SttEngineKind)}
                    style={sel}
                    disabled={sttTtsDisabled}
                  >
                    <option value="voicemode">Voicemode (Whisper, local)</option>
                    <option value="webspeech">Web Speech (browser cloud)</option>
                    <option value="deepgram">Deepgram Nova-2 (cloud, BYO key)</option>
                    <option value="off">Off</option>
                  </select>
                  <p style={hint}>
                    Voicemode runs locally — audio never leaves your machine.
                    Start it via <code>mcp__voicemode__service whisper start</code>.
                  </p>
                </div>
                <div>
                  <label style={lbl}>TTS (text → speech){fullAgentOn ? ' — overridden by full-agent' : ''}</label>
                  <select
                    value={prefs?.ttsEngine ?? 'kokoro'}
                    onChange={(e) => setTtsEngine(e.target.value as TtsEngineKind)}
                    style={sel}
                    disabled={sttTtsDisabled}
                  >
                    <option value="kokoro">Kokoro (Voicemode, local) — recommended</option>
                    <option value="browser">Browser (OS voices)</option>
                    <option value="elevenlabs">ElevenLabs Turbo v2.5 (cloud, BYO key)</option>
                    <option value="openai">OpenAI tts-1 (cloud, BYO key)</option>
                    <option value="cartesia">Cartesia Sonic-2 (cloud, BYO key)</option>
                  </select>
                  <EnginePreview engine={prefs?.ttsEngine ?? 'kokoro'} />
                  <p style={hint}>
                    Kokoro requires Voicemode (port 8880). Browser TTS works without setup but quality varies by OS.
                    ElevenLabs requires an API key below.
                  </p>
                </div>
              </div>
            </>
          );
        })()}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={onTestVoice} style={btnPrimary}>Test voice</button>
          <button type="button" onClick={onTestAllRoles} style={btn}>Test all roles</button>
          <button type="button" onClick={onRedetect} style={btn}>Re-detect engines</button>
          <p style={{ ...hint, margin: 0, flexBasis: '100%' }}>
            Test buttons play immediately even when voice mode is off — they're how you check the engine works.
            Toggle voice mode (mic icon in the header) to enable announcements during normal use.
          </p>
        </div>
      </section>

      {/* ── CLOUD API KEYS POINTER ────────────────────────────────
          Keys live on the dedicated /settings/api-keys page so users
          have one place to manage all credentials (LLM + voice). */}
      <section style={{ marginBottom: 24, padding: 12, border: '1px dashed var(--border)', borderRadius: 4 }}>
        <p style={{ ...hint, margin: 0 }}>
          Cloud API keys (OpenAI, ElevenLabs, Cartesia, Deepgram, Picovoice, Google AI) live on
          the dedicated <Link href="/settings/api-keys" style={{ textDecoration: 'underline' }}>API keys</Link> page.
        </p>
      </section>

      {/* ── ELEVENLABS SUB-SECTION ───────────────────────────────── */}
      {prefs?.ttsEngine === 'elevenlabs' && (
        <section style={{ marginBottom: 32, padding: 16, background: 'rgba(99, 102, 241, 0.04)', borderRadius: 6 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>ElevenLabs</h2>
          <p style={{ ...hint, marginBottom: 12 }}>
            Cloud TTS — text leaves the machine to ElevenLabs.
            BYO API key from <a href="https://elevenlabs.io" target="_blank" rel="noreferrer">elevenlabs.io</a>.
          </p>

          <div style={{ marginBottom: 16 }}>
            <label style={lbl}>API key</label>
            {credentials.configured ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ padding: '6px 10px', background: 'var(--bg-1)', borderRadius: 4, fontSize: 13 }}>
                  {credentials.apiKey ?? '(masked)'}
                </code>
                <button type="button" onClick={onTestConnection} disabled={testing} style={btn}>
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                <button type="button" onClick={onClearKey} style={{ ...btn, color: '#fca5a5' }}>Clear</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="sk_..."
                  style={{ flex: 1, padding: '6px 10px', fontSize: 13, fontFamily: 'monospace' }}
                />
                <button type="button" onClick={onSaveKey} disabled={!keyDraft.trim()} style={btnPrimary}>Save</button>
              </div>
            )}
          </div>

          {connTest && connTest.ok && (
            <div style={{ marginBottom: 12, padding: 8, background: 'rgba(45, 212, 191, 0.1)', borderRadius: 4, fontSize: 13 }}>
              Connected as <strong>{connTest.email ?? '(no email)'}</strong> — <strong>{connTest.tier}</strong> tier
              · {connTest.characterCount?.toLocaleString()} / {connTest.characterLimit?.toLocaleString()} chars used
            </div>
          )}

          {credentials.configured && (
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Default voice</label>
              <select
                value={prefs?.elevenlabsVoiceId ?? '21m00Tcm4TlvDq8ikWAM'}
                onChange={(e) => savePrefsPatch({ elevenlabsVoiceId: e.target.value })}
                style={sel}
              >
                <option value="21m00Tcm4TlvDq8ikWAM">Adam (default)</option>
                {elevenVoices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <p style={hint}>Click "Test connection" above to populate the full voice list from your account.</p>
            </div>
          )}

          {spend && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
              <Stat label="Today" value={`$${(todaySpend?.estimatedUsd ?? 0).toFixed(2)}`} />
              <Stat label="Last 7 days" value={`$${spend.spend.reduce((a, d) => a + d.estimatedUsd, 0).toFixed(2)}`} />
              <Stat label="Soft cap" value={`$${spend.softCapUsd}`} />
              <Stat label="Hard cap" value={`$${spend.hardCapUsd}`} />
            </div>
          )}

          {spend && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <NumField
                label="Rate per 1k chars (USD)"
                value={spend.perKCharRate}
                step={0.01}
                onCommit={(n) => updateSpendKnob({ perKCharRate: n })}
                hint="Approximate; defaults to ElevenLabs Creator tier (~$0.18/1k). Check your dashboard for actual billing. Set to 0 to hide estimates."
              />
              <NumField
                label="Soft cap (USD/day)"
                value={spend.softCapUsd}
                step={1}
                onCommit={(n) => updateSpendKnob({ softCapUsd: n })}
                hint="Spoken nudge once per day when crossed."
              />
              <NumField
                label="Hard cap (USD/day)"
                value={spend.hardCapUsd}
                step={1}
                onCommit={(n) => updateSpendKnob({ hardCapUsd: n })}
                hint="Auto-fall-back to Kokoro/browser when crossed."
              />
            </div>
          )}

        </section>
      )}

      {/* STT spend lives outside the ElevenLabs sub-section — Deepgram is the cloud STT,
          unrelated to TTS engine choice. Only renders once the API has loaded the state. */}
      {sttSpend && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>STT spend (Deepgram)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
            <Stat label="Today" value={`${(sttSpend.spend[0]?.estimatedUsd ?? 0).toFixed(2)}`} />
            <Stat label="Minutes" value={(sttSpend.spend[0]?.minutes ?? 0).toFixed(1)} />
            <Stat label="Soft cap" value={`${sttSpend.softCapUsd}`} />
            <Stat label="Hard cap" value={`${sttSpend.hardCapUsd}`} />
          </div>
          <p style={hint}>
            Voicemode (local Whisper) and Web Speech are free; only Deepgram accrues spend.
            Recorded server-side from the capture loop's heartbeat.
          </p>
        </section>
      )}

      {/* ── FEATURE TOGGLES ──────────────────────────────────────── */}
      {prefs && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Feature toggles</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
            {([
              ['speakSuggestions',       'Speak suggestions when they arrive in the panel'],
              ['speakBackgroundToasts',  'Speak background auto-fire toasts (with cancel cue)'],
              ['speakReceivingFlips',    'Speak when a card flips to consumed (chatty)'],
              ['speakEscalations',       'Speak when a card is escalated (significant)'],
              ['speakCadenceStatus',     'Speak scan-start / scan-done status (chatty)'],
              ['speakNudges',            'Speak budget / breaker / pause nudges'],
              ['wakeWordIntents',        'Enable "operator scan" wake-word commands'],
            ] as const).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Checkbox
                  checked={prefs[key]}
                  onChange={(v) => savePrefsPatch({ [key]: v } as any)}
                  disabled={savingPrefs}
                  ariaLabel={label}
                  style={{ marginTop: 2 }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* ── EXISTING WAKE-WORD + RATE + PER-ROLE VOICES ──────────── */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Wake word (always-on mode)</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            value={config.wakeWord}
            onChange={(e) => onWakeWordChange(e.target.value)}
            style={{ padding: '6px 10px', minWidth: 240, fontSize: 14 }}
          />
          <WakeWordTestButton wakeWord={config.wakeWord} />
        </div>
        <p style={hint}>3-syllable phrase that doesn't appear in normal speech (e.g. "hey operator"). Click <strong>Test wake word</strong> to simulate the dispatch path without using your voice.</p>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          {/* Wake-word engine: single enum (engine + keyword are paired). */}
          <label style={lbl}>Wake-word engine</label>
          <select
            value={prefs?.wakeWordEngine ?? 'off'}
            onChange={(e) => savePrefsPatch({ wakeWordEngine: e.target.value as VoicePrefs['wakeWordEngine'] })}
            style={{ ...sel, maxWidth: 360 }}
            disabled={savingPrefs}
          >
            <option value="off">Off — string-match wake word in transcript</option>
            <option value="openwakeword">openWakeWord (Apache 2.0, no key)</option>
            <option value="porcupine" disabled={!allCreds?.picovoice?.configured}>
              Porcupine (Picovoice, BYO key{!allCreds?.picovoice?.configured ? ' — not configured' : ''})
            </option>
          </select>
          <p style={hint}>
            On-device neural wake-word. Whisper only spins up AFTER the wake fires —
            big idle-CPU win when always-on mode is enabled.{' '}
            <strong>openWakeWord</strong> is open source and free; <strong>Porcupine</strong> is
            commercial (requires a Picovoice API key in the section above) but more accurate.
          </p>
          {prefs?.wakeWordEngine === 'porcupine' && (
            <div style={{ marginTop: 8 }}>
              <label style={lbl}>Porcupine keyword (built-in)</label>
              <select
                value={prefs?.porcupineKeyword ?? 'Computer'}
                onChange={(e) => savePrefsPatch({ porcupineKeyword: e.target.value as VoicePrefs['porcupineKeyword'] })}
                style={{ ...sel, maxWidth: 240 }}
                disabled={savingPrefs}
              >
                {['Computer','Jarvis','Bumblebee','Picovoice','Porcupine','Alexa','Hey Google','Hey Siri','Okay Google','Terminator','Americano','Blueberry','Grapefruit','Grasshopper'].map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <p style={hint}>Custom keywords need a .ppn file trained on Picovoice Console.</p>
            </div>
          )}
          {prefs?.wakeWordEngine === 'openwakeword' && (
            <div style={{ marginTop: 8 }}>
              <label style={lbl}>openWakeWord keyword (built-in)</label>
              <select
                value={prefs?.openwakewordKeyword ?? 'hey_jarvis'}
                onChange={(e) => savePrefsPatch({ openwakewordKeyword: e.target.value as VoicePrefs['openwakewordKeyword'] })}
                style={{ ...sel, maxWidth: 240 }}
                disabled={savingPrefs}
              >
                {['alexa', 'hey_jarvis', 'hey_mycroft', 'hey_rhasspy', 'ok_nabu', 'weather', 'timer'].map((k) => (
                  <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <p style={hint}>
                Custom "hey operator" needs an ONNX classifier trained via the openWakeWord
                Colab/Kaggle tutorial (~30 min). Drop the .onnx into <code>/public/wake/</code>.
              </p>
            </div>
          )}

          {/* Noise suppression engine: single enum dropdown. */}
          <label style={{ ...lbl, marginTop: 16 }}>Noise suppression</label>
          <select
            value={prefs?.noiseSuppressionEngine ?? 'browser'}
            onChange={(e) => savePrefsPatch({ noiseSuppressionEngine: e.target.value as VoicePrefs['noiseSuppressionEngine'] })}
            style={{ ...sel, maxWidth: 360 }}
            disabled={savingPrefs}
          >
            <option value="off">Off — raw mic input</option>
            <option value="browser">Browser native (WebRTC noiseSuppression)</option>
            <option value="rnnoise">Jitsi RNNoise (BSD, stronger)</option>
            <option value="koala" disabled={!allCreds?.picovoice?.configured}>
              Picovoice Koala (BYO key{!allCreds?.picovoice?.configured ? ' — not configured' : ''})
            </option>
          </select>
          <p style={hint}>
            Removes fan / keyboard / HVAC from the mic input before STT.
            Reduces VAD false positives. <strong>Browser native</strong> is the default and
            works without setup; the others trade higher CPU for stronger suppression.
          </p>
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Speech rate</h2>
        <input
          type="range"
          min={0.5} max={2.0} step={0.1}
          value={config.rate}
          onChange={(e) => onRateUiChange(Number(e.target.value))}
          style={{ width: 240 }}
        />
        <span style={{ marginLeft: 12, fontSize: 13 }}>{config.rate.toFixed(1)}x</span>
      </section>

      {/* Per-role voices — wrapped in LazyDetails so the heavy table
          (21 roles × N voices = many <option>s) only mounts the first
          time the user expands it. Closed by default. */}
      <section style={{ marginBottom: 32 }}>
        <LazyDetails
          summary="Per-role voices"
          summaryStyle={{ fontSize: 16, fontWeight: 600, cursor: 'pointer', marginBottom: 8 }}
        >
          <p style={hint}>
            Voices are keyed on role (worker/validator/orchestrator/system:operator/etc.) — all instances
            of a role share one voice. Per-slug voices are deferred to v1.5.
          </p>
          <RoleVoicesTable
            voices={voices}
            roleVoices={config.roleVoices}
            onAssign={onAssign}
            onTest={onTest}
          />

          {/* Per-slug voice overrides — show any role@slug entries that exist */}
          <PerSlugVoiceTable
            config={config}
            voices={voices}
            onAssign={(key, voice) => {
              assignVoiceToRole(key, voice);
              setConfig(getVoiceConfig());
            }}
            onTest={(key) => speak(`This is the voice for ${key.replace(':', ' ').replace('@', ' at ')}.`, key, 'polite', { force: true })}
          />
        </LazyDetails>
      </section>

      {/* ── PRECEDENCE MATRIX (debugging aid, lazy via <details>) ──── */}
      <section style={{ marginBottom: 32 }}>
        <details>
          <summary style={{ fontSize: 16, fontWeight: 600, cursor: 'pointer', marginBottom: 8 }}>
            Why isn't anything speaking? (precedence matrix)
          </summary>
          <p style={hint}>If voice isn't working, check this top-to-bottom.</p>
          <pre style={{ fontSize: 11, padding: 12, background: 'var(--bg-1)', borderRadius: 4, overflow: 'auto' }}>{`
              global  per-feature  paused   tutorial   leader-tab  result
              voice   toggle                complete   election
              ──────  ───────────  ───────  ─────────  ──────────  ──────────
voice off     off     any          any      any        any         silent
toggle off    on      off          any      any        any         silent for that feature
not leader    on      on           any      any        follower    silent (other tab speaks)
paused        on      on           paused   any        leader      only "pause" nudge speaks
pre-tutorial  on      on           any      false      leader      silent
all clear     on      on           running  true       leader      speaks
`}</pre>
        </details>
      </section>

      {/* ── WEB SPEECH LEAK WARNING MODAL ────────────────────────── */}
      {showLeakWarning && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000,
        }}>
          <div style={{ maxWidth: 480, padding: 24, background: '#1a1a1a', borderRadius: 8, color: '#fff' }}>
            <h3 style={{ margin: '0 0 12px' }}>⚠ Web Speech sends audio to the cloud</h3>
            <p style={{ fontSize: 14, marginBottom: 16 }}>
              Web Speech sends audio to your browser vendor's cloud (Google for Chrome,
              Microsoft for Edge). Use only on machines where that's acceptable.
            </p>
            <p style={{ fontSize: 13, color: '#aaa', marginBottom: 16 }}>
              Voicemode (Whisper, local) is the default — audio never leaves your machine.
              You can re-enable Voicemode any time.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setShowLeakWarning(false)} style={btn}>Cancel</button>
              <button type="button" onClick={ackLeakWarning} style={{ ...btnPrimary, background: '#a04' }}>
                I understand — use Web Speech
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <strong style={{ fontSize: 18 }}>{value}</strong>
    </div>
  );
}

/**
 * Per-slug voice overrides. v1.5 surface for the `role@slug` lookup
 * chain in voice-mode.ts. Lists existing overrides + lets users add
 * new ones with a "role @ slug" composite key.
 */
function PerSlugVoiceTable({
  config, voices, onAssign, onTest,
}: {
  config: { roleVoices: Record<string, string> };
  voices: Array<{ name: string; lang: string }>;
  onAssign: (key: string, voice: string) => void;
  onTest: (key: string) => void;
}) {
  const overrides = Object.keys(config.roleVoices).filter((k) => k.includes('@'));
  const [addRole, setAddRole] = useState('worker');
  const [addSlug, setAddSlug] = useState('');
  const sharedVoiceOptions = React.useMemo(
    () => voices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>),
    [voices],
  );
  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Per-slug voice overrides</h3>
      <p style={hint}>
        Override the role voice for a specific harness instance.
        Useful when you have multiple harnesses from the same template
        and want to distinguish them by ear.
      </p>
      {overrides.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, marginBottom: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '6px 4px', fontSize: 12 }}>Role @ Slug</th>
              <th style={{ padding: '6px 4px', fontSize: 12 }}>Voice</th>
              <th style={{ padding: '6px 4px', fontSize: 12 }}>Test / Remove</th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((key) => (
              <tr key={key} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 4px', fontSize: 12, fontFamily: 'monospace' }}>{key}</td>
                <td style={{ padding: '6px 4px' }}>
                  <select
                    value={config.roleVoices[key] ?? ''}
                    onChange={(e) => onAssign(key, e.target.value)}
                    style={{ padding: '4px 8px', fontSize: 12, minWidth: 220 }}
                  >
                    <option value="">(removed)</option>
                    {sharedVoiceOptions}
                  </select>
                </td>
                <td style={{ padding: '6px 4px', display: 'flex', gap: 4 }}>
                  <button type="button" onClick={() => onTest(key)} style={{ padding: '4px 8px', fontSize: 11 }}>Test</button>
                  <button type="button" onClick={() => onAssign(key, '')} style={{ padding: '4px 8px', fontSize: 11, color: '#fca5a5' }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
        <div>
          <label style={{ ...lbl, fontSize: 11 }}>Role</label>
          <input
            type="text"
            value={addRole}
            onChange={(e) => setAddRole(e.target.value)}
            placeholder="worker"
            style={{ padding: '4px 8px', fontSize: 12, width: 120 }}
          />
        </div>
        <div>
          <label style={{ ...lbl, fontSize: 11 }}>Harness slug</label>
          <input
            type="text"
            value={addSlug}
            onChange={(e) => setAddSlug(e.target.value)}
            placeholder="papercup-coding-foo"
            style={{ padding: '4px 8px', fontSize: 12, width: 200 }}
          />
        </div>
        <button
          type="button"
          disabled={!addRole.trim() || !addSlug.trim() || voices.length === 0}
          onClick={() => {
            const key = `${addRole.trim()}@${addSlug.trim()}`;
            onAssign(key, voices[0]?.name ?? '');
            setAddSlug('');
          }}
          style={{ padding: '6px 12px', fontSize: 12 }}
        >
          Add override
        </button>
      </div>
    </div>
  );
}

interface RoleVoicesTableProps {
  voices: Array<{ name: string; lang: string }>;
  roleVoices: Record<string, string>;
  onAssign: (role: string, voiceName: string) => void;
  onTest: (role: string) => void;
}

const RoleVoicesTable = React.memo(function RoleVoicesTable({
  voices,
  roleVoices,
  onAssign,
  onTest,
}: RoleVoicesTableProps) {
  // Render the option list ONCE per voices change. The previous code
  // iterated voices for each of 21 roles → on Chrome with ~100 system
  // voices that's 2100 React elements per page render. Now we render
  // 100 once and reuse via a `<datalist>`-style shared options block.
  const options = React.useMemo(() => {
    if (!voices.length) return null;
    return voices.map((v) => (
      <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
    ));
  }, [voices]);

  if (voices.length === 0) {
    return <p style={{ fontSize: 13, opacity: 0.7 }}>No voices loaded yet.</p>;
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: '8px 4px', fontSize: 12 }}>Role</th>
          <th style={{ padding: '8px 4px', fontSize: 12 }}>Voice</th>
          <th style={{ padding: '8px 4px', fontSize: 12 }}>Test</th>
        </tr>
      </thead>
      <tbody>
        {KNOWN_ROLES.map((role) => (
          <RoleVoiceRow
            key={role}
            role={role}
            current={roleVoices[role] ?? ''}
            options={options}
            onAssign={onAssign}
            onTest={onTest}
          />
        ))}
      </tbody>
    </table>
  );
});

const RoleVoiceRow = React.memo(function RoleVoiceRow({
  role,
  current,
  options,
  onAssign,
  onTest,
}: {
  role: string;
  current: string;
  options: React.ReactNode;
  onAssign: (role: string, voiceName: string) => void;
  onTest: (role: string) => void;
}) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '8px 4px', fontSize: 13, fontFamily: 'monospace' }}>{role}</td>
      <td style={{ padding: '8px 4px' }}>
        <select
          value={current}
          onChange={(e) => onAssign(role, e.target.value)}
          style={{ padding: '4px 8px', fontSize: 13, minWidth: 240 }}
        >
          <option value="">(auto)</option>
          {options}
        </select>
      </td>
      <td style={{ padding: '8px 4px' }}>
        <button type="button" onClick={() => onTest(role)} style={{ padding: '4px 8px', fontSize: 12 }}>Test</button>
      </td>
    </tr>
  );
});

function WakeWordTestButton({ wakeWord }: { wakeWord: string }) {
  type Stage =
    | 'idle'
    | 'prompting'      // we asked the user to speak; STT is hot
    | 'heard-correct'  // got the right phrase; intent fired
    | 'heard-other'    // STT got something but not what we asked for
    | 'timeout'        // no transcript after window
    | 'error';
  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const phrase = `${wakeWord} open`;

  const run = async () => {
    setStage('prompting');
    setTranscript(null);
    const { onFinalUtterance, setVoiceMode } = await import('../../_components/voice/voice-mode');
    // Force a fresh always-on cycle. setVoiceMode early-returns when the
    // mode hasn't changed, so if the user is already in always-on the
    // capture loop won't re-spin. Toggle off → on to force a fresh start.
    let restoreMode: 'off' | 'push-to-talk' | 'always-on' | null = null;
    try {
      const stMod = await import('../../_components/voice/voice-mode');
      const stCfg = stMod.getVoiceConfig();
      restoreMode = (stCfg.lastMode ?? 'off') as typeof restoreMode;
      setVoiceMode('off');
      // Brief tick so the prior capture tears down before we restart.
      await new Promise(r => setTimeout(r, 200));
      setVoiceMode('always-on');
    } catch { /* best-effort */ }

    let resolved = false;
    const expectedNorm = phrase.trim().toLowerCase();

    const unsub = onFinalUtterance((text) => {
      if (resolved) return;
      const norm = text.trim().toLowerCase();
      setTranscript(text);
      // Loose match: must contain the wake word + "open"
      const containsWake = norm.includes(wakeWord.toLowerCase());
      const containsVerb = /\bopen\b/.test(norm);
      if (containsWake && containsVerb) {
        resolved = true;
        setStage('heard-correct');
        unsub();
      } else if (norm.length > 1) {
        // Got SOMETHING but not the right thing — keep listening for the
        // remainder of the timeout window in case the user retries.
        setStage('heard-other');
      }
    });

    // 15s window
    setTimeout(() => {
      if (!resolved) {
        setStage((s) => (s === 'heard-correct' ? s : 'timeout'));
        unsub();
      }
      // Restore prior voice mode if we changed it.
      if (restoreMode && restoreMode !== 'always-on') {
        setVoiceMode(restoreMode);
      }
    }, 15000);
    void expectedNorm;
  };

  let label = 'Test wake word';
  if (stage === 'prompting') label = 'Listening…';
  else if (stage === 'heard-correct') label = '✓ Working — try again';
  else if (stage === 'heard-other') label = 'Heard something — try again';
  else if (stage === 'timeout') label = 'No audio — try again';
  else if (stage === 'error') label = 'Error — try again';

  return (
    <>
      <button type="button" onClick={run} disabled={stage === 'prompting'} style={stage === 'heard-correct' ? btnPrimary : btn}>
        {label}
      </button>
      {stage === 'prompting' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          Say <strong>"{phrase}"</strong> now. We'll wait up to 15 seconds. The Operator panel should open if the pipeline is healthy.
        </span>
      )}
      {stage === 'heard-correct' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%', color: 'var(--success, #16a34a)' }}>
          Heard: <em>"{transcript}"</em> — the Operator panel should have opened.
        </span>
      )}
      {stage === 'heard-other' && transcript && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          Got: <em>"{transcript}"</em> — that's not "{phrase}". STT is working but didn't catch the wake phrase. Speak more clearly or retry.
        </span>
      )}
      {stage === 'timeout' && (
        <span style={{ ...hint, marginTop: 0, marginLeft: 4, flexBasis: '100%' }}>
          No audio captured in 15s. Check that Voicemode whisper is running, the mic isn't muted, and you've granted browser permission.
        </span>
      )}
    </>
  );
}

function EnginePreview({ engine }: { engine: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const onClick = async () => {
    setError(null);
    setBusy(true);
    try {
      if (engine === 'browser') {
        if (typeof window === 'undefined' || !window.speechSynthesis) {
          setError('Web Speech not available in this browser');
          return;
        }
        const u = new SpeechSynthesisUtterance('This is a sample of the operator voice.');
        u.onend = () => setBusy(false);
        u.onerror = () => { setError('browser TTS errored'); setBusy(false); };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      }
      const r = await fetch('/api/agent-mcp/operator-tts-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      if (!r.ok) {
        if (r.status === 404) setError('No API key configured for this engine');
        else setError(`Preview failed: ${r.status}`);
        setBusy(false);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch {}
        URL.revokeObjectURL(audioRef.current.src);
      }
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { URL.revokeObjectURL(url); setBusy(false); };
      a.onerror = () => { setError('audio playback failed'); setBusy(false); };
      await a.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview errored');
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={onClick} disabled={busy} style={btn}>
        {busy ? '▶ Playing…' : `▶ Preview ${engine}`}
      </button>
      {error && <p style={{ ...hint, color: 'var(--danger, #b91c1c)' }}>{error}</p>}
    </div>
  );
}

function NumField({ label, value, step, onCommit, hint }: { label: string; value: number; step: number; onCommit: (n: number) => void; hint?: string }) {
  const [draft, setDraft] = useState(value.toString());
  useEffect(() => { setDraft(value.toString()); }, [value]);
  return (
    <div>
      <label style={lbl}>{label}</label>
      <input
        type="number"
        step={step}
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n) && n >= 0 && n !== value) onCommit(n);
        }}
        style={{ padding: '6px 10px', width: '100%', fontSize: 13 }}
      />
      {hint && <p style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-mute)' }}>{hint}</p>}
    </div>
  );
}

const lbl: React.CSSProperties = { display: 'block', fontWeight: 700, fontSize: 12, marginBottom: 4 };
const sel: React.CSSProperties = { padding: '6px 10px', width: '100%', fontSize: 13 };
const hint: React.CSSProperties = { fontSize: 12, color: 'var(--fg-mute)', marginTop: 6 };
const btn: React.CSSProperties = { padding: '6px 12px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'inherit' };
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--cta-bg, #1f2937)', color: 'var(--cta-fg, #ffffff)', border: 'none', fontWeight: 600 };
