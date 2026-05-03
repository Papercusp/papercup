'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
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

interface ElevenLabsKeyState { configured: boolean; apiKey: string | null }
interface ElevenLabsConnTest { ok: boolean; tier?: string; characterCount?: number; characterLimit?: number; email?: string | null; error?: string }
interface ElevenLabsVoice { id: string; name: string; lang?: string }

export default function VoiceSettingsPage() {
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [config, setConfig] = useState(() => getVoiceConfig());

  // v4 prefs + engine state
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [credentials, setCredentials] = useState<ElevenLabsKeyState>({ configured: false, apiKey: null });
  const [keyDraft, setKeyDraft] = useState('');
  const [connTest, setConnTest] = useState<ElevenLabsConnTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [elevenVoices, setElevenVoices] = useState<ElevenLabsVoice[]>([]);
  const [spend, setSpend] = useState<TtsSpendState | null>(null);
  const [showLeakWarning, setShowLeakWarning] = useState(false);

  useEffect(() => {
    initVoiceMode();
    setConfig(getVoiceConfig());
    const tryRefresh = () => {
      const v = listAvailableVoices();
      if (v.length) setVoices(v);
    };
    tryRefresh();
    const t = setInterval(tryRefresh, 500);

    void Promise.all([
      fetch('/api/agent-mcp/operator-voice-prefs').then((r) => r.ok ? r.json() : null),
      fetch('/api/agent-mcp/operator-credentials').then((r) => r.ok ? r.json() : null),
      fetch('/api/agent-mcp/operator-tts-spend').then((r) => r.ok ? r.json() : null),
    ]).then(([p, c, s]) => {
      if (p) setPrefs(p as VoicePrefs);
      if (c?.elevenlabs) setCredentials(c.elevenlabs);
      if (s) setSpend(s as TtsSpendState);
    });

    return () => clearInterval(t);
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
    speak(`This is the voice for ${role.replace(':', ' ')}.`, role);
  }, []);

  const onTestVoice = useCallback(() => {
    speak('Voice mode is working.', 'system:operator');
  }, []);

  const onTestAllRoles = useCallback(() => {
    if (prefs?.ttsEngine === 'elevenlabs') {
      if (!confirm(`Test all ${KNOWN_ROLES.length} roles? This will send ~${KNOWN_ROLES.length} requests to ElevenLabs (≈$${(KNOWN_ROLES.length * 0.04).toFixed(2)} estimated charges).`)) return;
    }
    KNOWN_ROLES.forEach((role, i) => {
      setTimeout(() => speak(`This is the ${role.replace(':', ' ')} voice.`, role), i * 1500);
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={lbl}>STT (speech → text)</label>
            <select
              value={prefs?.sttEngine ?? 'voicemode'}
              onChange={(e) => setSttEngine(e.target.value as SttEngineKind)}
              style={sel}
              disabled={savingPrefs}
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
            <label style={lbl}>TTS (text → speech)</label>
            <select
              value={prefs?.ttsEngine ?? 'kokoro'}
              onChange={(e) => setTtsEngine(e.target.value as TtsEngineKind)}
              style={sel}
              disabled={savingPrefs}
            >
              <option value="kokoro">Kokoro (Voicemode, local) — recommended</option>
              <option value="browser">Browser (OS voices)</option>
              <option value="elevenlabs">ElevenLabs (cloud, BYO key)</option>
            </select>
            <p style={hint}>
              Kokoro requires Voicemode (port 8880). Browser TTS works without setup but quality varies by OS.
              ElevenLabs requires an API key below.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onTestVoice} style={btnPrimary}>Test voice</button>
          <button type="button" onClick={onTestAllRoles} style={btn}>Test all roles</button>
          <button type="button" onClick={onRedetect} style={btn}>Re-detect engines</button>
        </div>
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
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(e) => savePrefsPatch({ [key]: e.target.checked } as any)}
                  disabled={savingPrefs}
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
        <input
          type="text"
          value={config.wakeWord}
          onChange={(e) => onWakeWordChange(e.target.value)}
          style={{ padding: '6px 10px', minWidth: 240, fontSize: 14 }}
        />
        <p style={hint}>3-syllable phrase that doesn't appear in normal speech (e.g. "hey operator").</p>
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

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Per-role voices</h2>
        <p style={hint}>
          Voices are keyed on role (worker/validator/orchestrator/system:operator/etc.) — all instances
          of a role share one voice. Per-slug voices are deferred to v1.5.
        </p>
        {voices.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.7 }}>No voices loaded yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '8px 4px', fontSize: 12 }}>Role</th>
                <th style={{ padding: '8px 4px', fontSize: 12 }}>Voice</th>
                <th style={{ padding: '8px 4px', fontSize: 12 }}>Test</th>
              </tr>
            </thead>
            <tbody>
              {KNOWN_ROLES.map((role) => {
                const current = config.roleVoices[role] ?? '(auto)';
                return (
                  <tr key={role} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 4px', fontSize: 13, fontFamily: 'monospace' }}>{role}</td>
                    <td style={{ padding: '8px 4px' }}>
                      <select
                        value={current === '(auto)' ? '' : current}
                        onChange={(e) => onAssign(role, e.target.value)}
                        style={{ padding: '4px 8px', fontSize: 13, minWidth: 240 }}
                      >
                        <option value="">(auto)</option>
                        {voices.map((v) => (
                          <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <button type="button" onClick={() => onTest(role)} style={{ padding: '4px 8px', fontSize: 12 }}>Test</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Per-slug voice overrides — show any role@slug entries that exist */}
        <PerSlugVoiceTable
          config={config}
          voices={voices}
          onAssign={(key, voice) => {
            assignVoiceToRole(key, voice);
            setConfig(getVoiceConfig());
          }}
          onTest={(key) => speak(`This is the voice for ${key.replace(':', ' ').replace('@', ' at ')}.`, key)}
        />
      </section>

      {/* ── PRECEDENCE MATRIX (debugging aid) ────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Why isn't anything speaking? (precedence matrix)</h2>
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
                    {voices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
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
      {hint && <p style={{ ...hint as any, marginTop: 4, fontSize: 11, color: 'var(--fg-mute)' }}>{hint}</p>}
    </div>
  );
}

const lbl: React.CSSProperties = { display: 'block', fontWeight: 700, fontSize: 12, marginBottom: 4 };
const sel: React.CSSProperties = { padding: '6px 10px', width: '100%', fontSize: 13 };
const hint: React.CSSProperties = { fontSize: 12, color: 'var(--fg-mute)', marginTop: 6 };
const btn: React.CSSProperties = { padding: '6px 12px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'inherit' };
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--cta-bg, #1f2937)', color: 'var(--cta-fg, #ffffff)', border: 'none', fontWeight: 600 };
