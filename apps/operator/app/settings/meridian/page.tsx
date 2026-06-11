'use client';

import { useEffect, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';

const MERIDIAN_BASE = 'http://127.0.0.1:3456';

type Tab = 'settings' | 'telemetry' | 'profiles';

const TABS: Array<{ id: Tab; label: string; path: string }> = [
  { id: 'settings', label: 'Settings', path: '/settings' },
  { id: 'telemetry', label: 'Telemetry', path: '/telemetry' },
  { id: 'profiles', label: 'Profiles', path: '/profiles' },
];

export default function MeridianSettingsPage() {
  const [tab, setTab] = useQueryState(
    'meridianTab',
    parseAsStringEnum<Tab>(['settings', 'telemetry', 'profiles']).withDefault('settings'),
  );
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${MERIDIAN_BASE}/`, { mode: 'cors', cache: 'no-store' })
      .then((r) => { if (!cancelled) setReachable(r.ok); })
      .catch(() => { if (!cancelled) setReachable(false); });
    return () => { cancelled = true; };
  }, []);

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 600 }}>
      <header style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <h1>Meridian</h1>
        <p className="pc-settings-intro" style={{ marginBottom: 0 }}>
          Routes omp through your Claude Max subscription. Meridian&apos;s web UI is embedded below; changes are saved by Meridian directly to <code>~/.config/meridian/</code>.
        </p>
      </header>
      <nav style={{ display: 'flex', gap: 4, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              padding: '6px 12px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: t.id === tab ? 'var(--accent)' : 'transparent',
              color: t.id === tab ? 'var(--accent-soft)' : 'var(--fg)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <a
          href={`${MERIDIAN_BASE}${active.path}`}
          target="_blank"
          rel="noreferrer"
          style={{ padding: '6px 12px', fontSize: 12, color: 'var(--fg-mute)' }}
        >
          Open in browser ↗
        </a>
      </nav>
      <div style={{ flex: 1, marginTop: 8 }}>
        {reachable === null ? (
          <p className="pc-settings-loading">Checking Meridian…</p>
        ) : reachable === false ? (
          <div style={{ padding: 16, color: 'var(--bad)', fontSize: 13 }}>
            Meridian is not reachable at <code>{MERIDIAN_BASE}</code>. Start it with <code>meridian</code> in a terminal, or install via <code>npm install -g @rynfar/meridian</code>.
            <br />
            <button
              type="button"
              onClick={() => { setReachable(null); setTimeout(() => location.reload(), 0); }}
              style={{ marginTop: 8, padding: '4px 12px', fontSize: 12 }}
            >
              Retry
            </button>
          </div>
        ) : (
          <iframe
            key={active.id}
            src={`${MERIDIAN_BASE}${active.path}`}
            style={{ width: '100%', height: '100%', minHeight: 540, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)' }}
            title={`Meridian ${active.label}`}
          />
        )}
      </div>
    </div>
  );
}
