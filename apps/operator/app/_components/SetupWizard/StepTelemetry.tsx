'use client';

import { useEffect, useState } from 'react';
import { commands } from '@/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

interface FlushResult {
  archived: number;
  forwarded: number;
  forwardFailed: number;
  retentionDeleted: number;
  sinkConfigured: boolean;
}

export function StepTelemetry() {
  const [enabled, setEnabled] = useState(false);
  const [sinkUrl, setSinkUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [tauri, setTauri] = useState(false);
  const [testing, setTesting] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);
  const [lastFlush, setLastFlush] = useState<FlushResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauri());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        const j = await r.json();
        setEnabled(Boolean(j.telemetry_enabled));
        setSinkUrl(j.telemetry_sink_url ?? '');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    await fetch('/api/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const toggle = async (v: boolean) => {
    setEnabled(v);
    await patch({ telemetry_enabled: v });
  };

  const saveSinkUrl = async () => {
    await patch({ telemetry_sink_url: sinkUrl || null });
  };

  const sendTest = async () => {
    setTesting(true);
    setError(null);
    setLastTest(null);
    try {
      let appVersion: string | undefined;
      if (tauri) {
        try { appVersion = await commands.appVersion(); } catch { /* best effort */ }
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
      setError(e?.message ?? String(e));
    } finally {
      setTesting(false);
    }
  };

  const flushNow = async () => {
    setFlushing(true);
    setError(null);
    try {
      const res = await fetch('/api/desktop/telemetry-flush', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as FlushResult;
      setLastFlush(result);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFlushing(false);
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
        <>
          <label className="pc-field">
            <span className="pc-field__label">Sink URL (optional)</span>
            <div className="pc-field__row">
              <input
                type="url"
                className="pc-input"
                placeholder="https://your-crash-sink.example.com/report"
                value={sinkUrl}
                onChange={(e) => setSinkUrl(e.target.value)}
              />
              <button type="button" className="pc-btn" onClick={() => void saveSinkUrl()}>
                Save
              </button>
            </div>
            <span className="pc-field__hint">
              Reports are archived locally regardless. When this is set, the flush worker also POSTs
              each report to the URL (with optional <code>PAPERCUSP_TELEMETRY_SINK_TOKEN</code> as a
              bearer token). Leave blank for local-only.
            </span>
          </label>

          <div className="pc-step__actions">
            <button
              type="button"
              className="pc-btn"
              onClick={() => void sendTest()}
              disabled={testing}
            >
              {testing ? 'Sending…' : 'Send test report'}
            </button>
            <button
              type="button"
              className="pc-btn"
              onClick={() => void flushNow()}
              disabled={flushing}
            >
              {flushing ? 'Flushing…' : 'Flush now'}
            </button>
            {lastTest && (
              <span className="pc-step__saved">
                Test sent at {new Date(lastTest).toLocaleTimeString()}
              </span>
            )}
          </div>

          {lastFlush && (
            <div className="pc-step__progress" data-status="ok">
              <div className="pc-step__progress-dot" />
              <div className="pc-step__progress-text">
                <strong>Flushed.</strong>
                <span>
                  archived={lastFlush.archived} forwarded={lastFlush.forwarded} failed=
                  {lastFlush.forwardFailed} retention-deleted={lastFlush.retentionDeleted}{' '}
                  sink-configured={lastFlush.sinkConfigured ? 'yes' : 'no'}
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="pc-step__progress" data-status="error">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Failed.</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      <p className="pc-step__hint">
        Reports are archived in <code>harness_shared.telemetry_reports_archive</code> with a default
        retention of 30 days (<code>PAPERCUSP_TELEMETRY_RETENTION_DAYS</code>). A background worker
        flushes hourly. Opt-out at any time and the API returns 403 immediately.
      </p>
    </div>
  );
}
