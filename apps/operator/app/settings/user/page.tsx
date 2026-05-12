'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

const VOICE_USER_OVERRIDE_KEYS = [
  { key: 'agentLanguage', label: 'Agent language pin' },
  { key: 'elevenlabsVoiceId', label: 'EL voice id' },
  { key: 'wakeWordKeyword', label: 'Wake word' },
  { key: 'voiceMaxSpokenWords', label: 'Max spoken words' },
  { key: 'fullAgentIdleTimeoutMin', label: 'Idle timeout (min)' },
  { key: 'fullAgentSessionMaxMin', label: 'Session max (min)' },
  { key: 'operatorHistoryTokenBudget', label: 'Operator history budget (tokens)' },
  { key: 'operatorActiveOnStartup', label: 'Operator active on startup' },
  { key: 'voicePrivacyMode', label: 'Voice privacy mode' },
  { key: 'speakSuggestions', label: 'Speak suggestions' },
  { key: 'speakReceivingFlips', label: 'Speak receiving flips' },
  { key: 'speakCadenceStatus', label: 'Speak cadence status' },
  { key: 'operatorBackstoryEnabled', label: 'Operator backstory enabled' },
] as const;

export default function UserSettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  // Password change UI
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  // Display name
  const [displayName, setDisplayName] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [me, p] = await Promise.all([
        fetch('/api/auth/me').then((r) => r.json()),
        fetch('/api/user/preferences').then((r) => r.ok ? r.json() : { payload: {} }),
      ]);
      setUser(me.user);
      setDisplayName(me.user?.display_name ?? '');
      setPrefs(p.payload ?? {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const clearOverride = useCallback(async (key: string) => {
    await fetch(`/api/user/preferences?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    setPrefs((p) => { const out = { ...p }; delete out[key]; return out; });
    toast.success(`Cleared override for ${key}`);
  }, []);

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

  const activeOverrides = Object.keys(prefs).filter((k) =>
    VOICE_USER_OVERRIDE_KEYS.some((v) => v.key === k),
  );

  return (
    <div style={{ padding: 32, maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1 style={{ marginBottom: 8 }}>User preferences</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Settings here override workspace settings just for {user.display_name}.
        </p>
      </header>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Identity</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label>Username: <code>{user.username}</code> (immutable)</label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ padding: 6, border: '1px solid var(--border)', borderRadius: 4 }}
            />
          </label>
          {/* Display-name save endpoint TBD — skipping in v1 since
              the field is read-only on the user table for now.
              Users can rename via signup (next user). */}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Password</h2>
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

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Active preference overrides</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          User-scoped values overriding workspace defaults. Edit these from <a href="/settings/voice">/settings/voice</a> or
          <a href="/settings/operator"> /settings/operator</a> while logged in as this user; clear to fall back to workspace.
        </p>
        {activeOverrides.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No user-specific overrides set.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {activeOverrides.map((k) => {
              const label = VOICE_USER_OVERRIDE_KEYS.find((v) => v.key === k)?.label ?? k;
              return (
                <li
                  key={k}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 10px', borderRadius: 4,
                    border: '1px solid var(--border)',
                  }}
                >
                  <span>
                    {label}: <code>{JSON.stringify(prefs[k])}</code>
                  </span>
                  <button type="button" onClick={() => clearOverride(k)} style={{ fontSize: 12 }}>
                    Clear
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Memory</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          The operator stores things it learns about you (preferences, corrections, etc).
          Inspect and delete per entry at <a href="/settings/user/memory" style={{ color: 'var(--accent)' }}>/settings/user/memory</a>.
        </p>
      </section>
    </div>
  );
}
