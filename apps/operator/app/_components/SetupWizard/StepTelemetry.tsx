'use client';

import { useEffect, useState } from 'react';
import { commands } from '@/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

export function StepTelemetry() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tauri, setTauri] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauri());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        const j = await r.json();
        setEnabled(Boolean(j.telemetry_enabled));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const toggle = async (v: boolean) => {
    setEnabled(v);
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telemetry_enabled: v }),
      });
    } catch {
      // ignore — local state is still updated
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestError(null);
    setLastTest(null);
    try {
      let appVersion: string | undefined;
      if (tauri) {
        try {
          appVersion = await commands.appVersion();
        } catch {
          // best effort
        }
      }
      const res = await fetch('/api/desktop/telemetry-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'test',
          app_version: appVersion,
          os: typeof navigator !== 'undefined' ? navigator.platform : undefined,
          payload: { source: 'setup-wizard', triggered_at: new Date().toISOString() },
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setLastTest(new Date().toISOString());
    } catch (e: any) {
      setTestError(e?.message ?? String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Help us find bugs in alpha. If you opt in, Papercusp will send anonymized crash reports and
        performance metrics — no source code, no prompts, no API keys, no personally identifiable
        information.
      </p>
      <label className="pc-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void toggle(e.target.checked)}
          disabled={!loaded}
        />
        <span>Send anonymous crash reports and diagnostics</span>
      </label>

      {enabled && (
        <div className="pc-step__actions">
          <button
            type="button"
            className="pc-btn"
            onClick={() => void sendTest()}
            disabled={testing}
          >
            {testing ? 'Sending…' : 'Send test report'}
          </button>
          {lastTest && <span className="pc-step__saved">Sent at {new Date(lastTest).toLocaleTimeString()}</span>}
        </div>
      )}

      {testError && (
        <div className="pc-step__progress" data-status="error">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Send failed.</strong>
            <span>{testError}</span>
          </div>
        </div>
      )}

      <p className="pc-step__hint">
        Stored locally in your embedded Postgres (key <code>telemetry_reports</code>, bounded to the
        last 100 reports). A remote retention pipeline is a follow-up — when it lands, reports will
        also be forwarded to our crash sink. Opt-out at any time and we stop accepting reports
        immediately (the API returns 403 when this toggle is off).
      </p>
    </div>
  );
}
