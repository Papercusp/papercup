'use client';

import { useEffect, useState } from 'react';
import RouteLink from '../RouteLink';

interface BackupSettings {
  enabled: boolean;
  cadenceMode: 'event' | 'interval' | 'both';
  cadenceMinutes: number;
  retentionPreset: 'aggressive' | 'default' | 'conservative' | 'custom';
  retentionCustom: unknown;
  eventTriggers: string[];
  excludedPaths: string[];
}

interface BackupsResponse {
  workspaceId: string;
  settings: BackupSettings;
  stats?: unknown;
}

export function StepBackups() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/backups', { cache: 'no-store' });
        if (!r.ok) throw new Error(`backups: ${r.status}`);
        const j = (await r.json()) as BackupsResponse;
        setSettings(j.settings);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setEnabled = async (enabled: boolean) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    const next = { ...settings, enabled };
    try {
      const r = await fetch('/api/backups', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(`backups: ${r.status}`);
      setSettings(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp uses <strong>Kopia</strong> to take local snapshots of your projects.{' '}
        <strong>Agents shouldn't delete git history</strong> — but if one ever does, this is a layer
        they can't touch. <strong>Enabled by default.</strong>
      </p>
      <ul className="pc-bullets">
        <li>Snapshots run before destructive agent operations and after each harness run.</li>
        <li>Restore from any snapshot via the Backups settings page.</li>
        <li>Storage is local-only by default; no cloud upload unless you configure one.</li>
      </ul>

      <div className="pc-consent" style={{ marginTop: 16 }}>
        {loading && <span>Loading current setting…</span>}
        {!loading && settings && (
          <label className="pc-consent__toggle">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(e) => void setEnabled(e.target.checked)}
            />
            <span>
              {settings.enabled ? 'Backups enabled' : 'Backups disabled'}
              {busy && <em style={{ marginLeft: 8, opacity: 0.7 }}>saving…</em>}
            </span>
          </label>
        )}
        {error && (
          <span className="pc-field__hint pc-field__hint--err" style={{ marginTop: 8 }}>
            ⚠ {error}
          </span>
        )}
      </div>

      <p className="pc-step__hint" style={{ marginTop: 12 }}>
        Default retention keeps 200 latest + 48 hourly + 30 daily + 12 weekly + 12 monthly snapshots.
        Tune cadence, retention, and destination at{' '}
        <RouteLink href="/settings/backups" style={{ color: 'var(--accent)' }}>
          Settings → Backups
        </RouteLink>
        .
      </p>
    </div>
  );
}
