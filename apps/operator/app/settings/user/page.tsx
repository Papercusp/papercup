'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { DraftNumberInput } from '@/lib/forms';
import RouteLink from '@/app/_components/RouteLink';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

/**
 * Override-eligible voice/operator pref keys. Must stay in sync with
 * VOICE_USER_OVERRIDE_KEYS in lib/user-preferences.ts and the underlying
 * VoicePrefs schema in lib/voice-prefs.ts.
 *
 * Each entry describes how to render + parse the value:
 *   - kind 'bool' → checkbox, default false
 *   - kind 'number' → number input, optional min/max
 *   - kind 'string' → text input
 *   - kind 'enum' → select dropdown
 */
type OverrideSpec =
  | { key: string; label: string; help: string; kind: 'bool' }
  | { key: string; label: string; help: string; kind: 'number'; min?: number; max?: number; step?: number }
  | { key: string; label: string; help: string; kind: 'string' }
  | { key: string; label: string; help: string; kind: 'enum'; options: { value: string; label: string }[] };

const OVERRIDES: readonly OverrideSpec[] = [
  { key: 'agentLanguage', kind: 'enum', label: 'Agent language pin',
    help: 'Force the operator to reply in this language regardless of what the workspace default says.',
    options: [
      { value: 'en', label: 'English (en)' },
      { value: 'es', label: 'Spanish (es)' },
      { value: 'fr', label: 'French (fr)' },
      { value: 'de', label: 'German (de)' },
      { value: 'it', label: 'Italian (it)' },
      { value: 'pt', label: 'Portuguese (pt)' },
      { value: 'pl', label: 'Polish (pl)' },
      { value: 'tr', label: 'Turkish (tr)' },
      { value: 'ru', label: 'Russian (ru)' },
      { value: 'nl', label: 'Dutch (nl)' },
      { value: 'cs', label: 'Czech (cs)' },
      { value: 'ar', label: 'Arabic (ar)' },
      { value: 'zh', label: 'Chinese (zh)' },
    ] },
  { key: 'elevenlabsVoiceId', kind: 'string', label: 'EL voice id',
    help: 'ElevenLabs voice id (overrides workspace default).' },
  { key: 'wakeWordKeyword', kind: 'string', label: 'Wake word',
    help: 'The word that activates voice mode when Porcupine/openwakeword is enabled.' },
  { key: 'voiceMaxSpokenWords', kind: 'number', min: 5, max: 200, step: 1, label: 'Max spoken words per reply',
    help: 'Cap on TTS length per operator turn.' },
  { key: 'fullAgentIdleTimeoutMin', kind: 'number', min: 0, max: 60, step: 1, label: 'Idle timeout (min)',
    help: 'Auto-disconnect voice session after this many minutes of user silence. 0 = never.' },
  { key: 'fullAgentSessionMaxMin', kind: 'number', min: 0, max: 240, step: 5, label: 'Session max (min)',
    help: 'Hard session-duration cap. 0 = no max.' },
  { key: 'operatorHistoryTokenBudget', kind: 'number', min: 5000, max: 150000, step: 1000, label: 'Papercup history budget (tokens)',
    help: 'How much chat history the Papercup brain sees per turn. Higher = better recall, more cost.' },
  { key: 'operatorContextMode', kind: 'enum', label: 'Papercup long-conversation memory',
    help: 'Compaction keeps recent turns verbatim plus a rolling summary of everything older, so Papercup remembers the whole conversation at bounded cost. Window is the legacy escape hatch: verbatim budget only, older turns are forgotten.',
    options: [
      { value: 'compaction', label: 'Compaction (recommended) — window + rolling summary' },
      { value: 'window', label: 'Window only — forget turns past the budget' },
    ] },
  { key: 'operatorActiveOnStartup', kind: 'bool', label: 'Papercup active on startup',
    help: 'When a new chat opens, start in active mode (Papercup initiates) vs passive.' },
  { key: 'voicePrivacyMode', kind: 'enum', label: 'Voice privacy mode',
    help: 'Always-on streams the mic continuously; wake-word-gated only streams after the wake word.',
    options: [
      { value: 'always-on', label: 'Always on' },
      { value: 'wake-word-gated', label: 'Wake-word gated' },
      { value: 'ptt', label: 'Push-to-talk' },
    ] },
  { key: 'speakSuggestions', kind: 'bool', label: 'Speak suggestions out loud',
    help: 'When the operator surfaces suggestions, also speak them via TTS.' },
  { key: 'speakReceivingFlips', kind: 'bool', label: 'Speak mode flips',
    help: 'Announce active/passive mode changes via TTS.' },
  { key: 'speakCadenceStatus', kind: 'bool', label: 'Speak cadence status',
    help: 'Announce silence-nudge events via TTS.' },
  { key: 'operatorBackstoryEnabled', kind: 'bool', label: 'Papercup backstory enabled',
    help: 'Include the Papercup persona backstory in the system prompt.' },
  { key: 'memoryEmbedderMode', kind: 'enum', label: 'Memory embedder',
    help: 'How mem0 embeds memories for retrieval. Auto prefers OpenAI if you have a key, else local. Local uses ~400MB RAM. Disabled turns memory off entirely.',
    options: [
      { value: 'auto', label: 'Auto (recommended) — OpenAI if key, else local' },
      { value: 'openai', label: 'OpenAI text-embedding-3-small (needs key)' },
      { value: 'local', label: 'Local @huggingface/transformers (~400MB RAM)' },
      { value: 'disabled', label: 'Disabled — turn off persistent memory' },
    ] },
] as const;

interface EffectivePrefs {
  workspace: Record<string, unknown>;
  user: Record<string, unknown>;
}

export default function UserSettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [effective, setEffective] = useState<EffectivePrefs>({ workspace: {}, user: {} });
  const [loading, setLoading] = useState(true);

  // Display name edit
  const [displayName, setDisplayName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Password change UI
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [me, prefsJson, workspaceJson] = await Promise.all([
        fetch('/api/auth/me').then((r) => r.json()),
        fetch('/api/user/preferences').then((r) => r.ok ? r.json() : { payload: {} }),
        // ?layer=workspace returns workspace-only prefs (no user merge),
        // so we can show the true fallback value alongside the override.
        fetch('/api/agent-mcp/operator-voice-prefs?layer=workspace')
          .then((r) => r.ok ? r.json() : null)
          .catch(() => null),
      ]);
      setUser(me.user);
      setDisplayName(me.user?.display_name ?? '');
      const userPrefs = prefsJson.payload ?? {};
      const workspace: Record<string, unknown> = workspaceJson ?? {};
      setEffective({ workspace, user: userPrefs });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const setOverride = useCallback(async (key: string, value: unknown) => {
    const r = await fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    if (!r.ok) {
      toast.error(`Failed to set ${key}`);
      return;
    }
    setEffective((p) => ({ ...p, user: { ...p.user, [key]: value } }));
    toast.success(`Override saved for ${key}`);
  }, []);

  const clearOverride = useCallback(async (key: string) => {
    const r = await fetch(`/api/user/preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!r.ok) {
      toast.error(`Failed to clear ${key}`);
      return;
    }
    setEffective((p) => { const u = { ...p.user }; delete u[key]; return { ...p, user: u }; });
    toast.success(`Cleared override for ${key}`);
  }, []);

  const saveDisplayName = useCallback(async () => {
    setSavingName(true);
    try {
      const r = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });
      if (!r.ok) {
        toast.error('Failed to save display name');
        return;
      }
      toast.success('Display name updated');
    } finally {
      setSavingName(false);
    }
  }, [displayName]);

  const onSetPassword = useCallback(async () => {
    setPwBusy(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          current: user?.has_password ? currentPw : null,
          next: nextPw || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json();
        toast.error(`Password change failed: ${j.error}`);
        return;
      }
      toast.success(nextPw ? 'Password updated' : 'Password removed');
      setCurrentPw(''); setNextPw('');
      await refresh();
    } finally {
      setPwBusy(false);
    }
  }, [user?.has_password, currentPw, nextPw, refresh]);

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;
  if (!user) {
    return (
      <div style={{ padding: 32 }}>
        <p>Not signed in. <a href="/login">Sign in</a></p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1>User preferences</h1>
        <p className="pc-settings-intro">
          Settings here override workspace defaults just for {user.display_name}.
        </p>
      </header>

      <section className="pc-settings-section">
        <h2>Identity</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label>Username: <code>{user.username}</code> (immutable)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
              <span>Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
              />
            </label>
            <button type="button" onClick={saveDisplayName} disabled={savingName || displayName.trim() === user.display_name}>
              {savingName ? '…' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Password</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {user.has_password && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Current password</span>
              <input
                type="password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
              />
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>New password (leave blank to remove)</span>
            <input
              type="password"
              value={nextPw}
              onChange={(e) => setNextPw(e.target.value)}
              style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
            />
          </label>
          <button type="button" onClick={onSetPassword} disabled={pwBusy}>
            {pwBusy ? '…' : nextPw ? 'Update password' : (user.has_password ? 'Remove password' : 'Add password')}
          </button>
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Overrides</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginBottom: 12 }}>
          Set a value here to override the workspace default for your account.
          Leave a row empty (or click Clear) to fall back to the workspace.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {OVERRIDES.map((spec) => {
            const overridden = spec.key in effective.user;
            const value = overridden ? effective.user[spec.key] : effective.workspace[spec.key];
            const workspaceValue = effective.workspace[spec.key];
            return (
              <div
                key={spec.key}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: 12, borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: overridden ? 'color-mix(in srgb, var(--accent), transparent 95%)' : 'transparent',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14 }}>{spec.label}</strong>
                    {overridden && (
                      <>
                        <span style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 10, fontWeight: 600 }}>OVERRIDE</span>
                        <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                          workspace: <code>{formatValue(workspaceValue)}</code>
                        </span>
                      </>
                    )}
                  </div>
                  <p style={{ color: 'var(--fg-mute)', fontSize: 12, margin: '0 0 8px' }}>{spec.help}</p>
                  <OverrideInput
                    spec={spec}
                    value={value}
                    onChange={(v) => setOverride(spec.key, v)}
                  />
                </div>
                {overridden && (
                  <button
                    type="button"
                    onClick={() => clearOverride(spec.key)}
                    style={{ flexShrink: 0, padding: '4px 10px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    Clear
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="pc-settings-section">
        <h2>Memory</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          The operator stores things it learns about you (preferences, corrections, etc).
          Inspect and delete per entry at <RouteLink href="/settings/user/memory" style={{ color: 'var(--accent)' }}>/settings/user/memory</RouteLink>.
          Search across memories + workspace prose at <RouteLink href="/settings/user/search" style={{ color: 'var(--accent)' }}>/settings/user/search</RouteLink>.
        </p>
      </section>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '(unset)';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  return String(v);
}

function OverrideInput({ spec, value, onChange }: {
  spec: OverrideSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // String + number commit on blur (never one PATCH per keystroke). Numbers
  // go through DraftNumberInput, which gates on the spec's declared min/max
  // before persisting — the HTML min/max attributes are UI hints only.
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  const focusedRef = useRef(false);
  // Adopt external value changes only while idle — a slow PATCH echo or a
  // peer field's save must not eat in-progress keystrokes.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  if (spec.kind === 'bool') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Checkbox
          checked={value === true}
          onChange={(v) => onChange(v)}
          ariaLabel="bool"
        />
        <span>{value === true ? 'On' : 'Off'}</span>
      </label>
    );
  }
  if (spec.kind === 'enum') {
    return (
      <Select
        value={((value as string) ?? '') || '_default'}
        onChange={(v) => onChange(v === '_default' ? '' : v)}
        options={[
          { value: '_default', label: '(use workspace default)' },
          ...spec.options.map((o) => ({ value: o.value, label: o.label })),
        ]}
        ariaLabel={spec.label}
      />
    );
  }
  if (spec.kind === 'number') {
    return (
      <DraftNumberInput
        aria-label={spec.label}
        value={typeof value === 'number' ? value : null}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        // An empty draft is "nothing entered", not an error — overrides are
        // optional (the workspace default applies when unset).
        emptyDraft="ignore"
        onCommit={(n) => onChange(n)}
        wrapperStyle={{ display: 'inline-flex' }}
        style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4, width: 140 }}
      />
    );
  }
  // string
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => { focusedRef.current = false; if (draft !== String(value ?? '')) onChange(draft.trim()); }}
      onKeyDown={(e) => { if (e.key === 'Escape') setDraft(value == null ? '' : String(value)); }}
      style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4, minWidth: 240 }}
    />
  );
}
