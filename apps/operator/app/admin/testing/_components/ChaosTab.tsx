'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum, parseAsBoolean } from 'nuqs';
import { Button } from '../../../harness/Button';
import { Select } from '../../../harness/Select';
import {
  CHANNEL_NAME,
  type ControllerMsg,
  type RecorderMsg,
  type RunSummary,
  saveRun,
  loadRuns,
  clearRuns,
} from '../_lib/recorder-channel';
import { rateINP } from '../_lib/vitals-recorder';

const DEFAULT_BLOCKLIST = 'delete,remove,reset,sign out,log out,destroy,drop,wipe,format,uninstall,revoke';

type Duration = '30s' | '2m' | '10m';

const DURATIONS: Record<Duration, number> = {
  '30s': 30_000,
  '2m': 120_000,
  '10m': 600_000,
};

export default function ChaosTab() {
  const [route, setRoute] = useQueryState('chaosRoute', parseAsString.withDefault('/'));
  const [duration, setDuration] = useQueryState(
    'chaosDur',
    parseAsStringEnum<Duration>(['30s', '2m', '10m']).withDefault('30s'),
  );
  const [dryRun, setDryRun] = useQueryState('dry', parseAsBoolean.withDefault(false));
  const [blocklist, setBlocklist] = useState(DEFAULT_BLOCKLIST);

  const [runState, setRunState] = useState<'idle' | 'launching' | 'recording' | 'finishing'>('idle');
  const [progress, setProgress] = useState<{ clicks: number; elapsedMs: number }>({ clicks: 0, elapsedMs: 0 });
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const runIdRef = useRef<string | null>(null);
  const recorderWindowRef = useRef<Window | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    setHistory(loadRuns());
  }, []);

  function launch() {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    runIdRef.current = runId;
    setRunState('launching');
    setProgress({ clicks: 0, elapsedMs: 0 });

    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;

    channel.addEventListener('message', (e) => {
      const m = e.data as RecorderMsg;
      if (m.runId && m.runId !== runId && m.type !== 'ready') return;
      if (m.type === 'ready') {
        // Recorder loaded — kick off the run.
        const startMsg: ControllerMsg = {
          type: 'start',
          runId,
          durationMs: DURATIONS[duration],
          blocklist: blocklist.split(',').map((s) => s.trim()).filter(Boolean),
          dryRun,
        };
        channel.postMessage(startMsg);
      } else if (m.type === 'started') {
        setRunState('recording');
      } else if (m.type === 'progress') {
        setProgress({ clicks: m.clicks, elapsedMs: m.elapsedMs });
      } else if (m.type === 'done') {
        setRunState('idle');
        setLastRun(m.summary);
        const next = saveRun(m.summary);
        setHistory(next);
        channel.close();
        channelRef.current = null;
        recorderWindowRef.current?.close();
        recorderWindowRef.current = null;
      }
    });

    const url = new URL(route, window.location.origin);
    url.searchParams.set('perf-recorder', '1');
    recorderWindowRef.current = window.open(url.toString(), 'papercusp-perf-recorder', 'width=1280,height=800');
    if (!recorderWindowRef.current) {
      setRunState('idle');
      alert('Popup blocked — allow popups for this site to run chaos tests.');
    }
  }

  function stopRun() {
    if (!runIdRef.current || !channelRef.current) return;
    setRunState('finishing');
    channelRef.current.postMessage({ type: 'stop', runId: runIdRef.current } as ControllerMsg);
  }

  function exportJson() {
    if (!lastRun) return;
    const blob = new Blob([JSON.stringify(lastRun, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chaos-run-${lastRun.runId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const slowest = lastRun?.events.filter((e) => e.kind === 'click' && typeof e.inp === 'number').sort((a, b) => (b.inp ?? 0) - (a.inp ?? 0)).slice(0, 30) ?? [];
  const errors = lastRun?.events.filter((e) => e.kind === 'console-error' || e.kind === 'unhandled-error') ?? [];
  const longTasks = lastRun?.events.filter((e) => e.kind === 'long-task').length ?? 0;
  const layoutShifts = lastRun?.events.filter((e) => e.kind === 'layout-shift').length ?? 0;

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Chaos</h1>
          <p className="pc-test-tab-intro">
            Opens a recorder window, unleashes Gremlins.js for the chosen duration, records every
            slow interaction / long task / console error. Random clicks → finds pathological states
            no scripted test would hit. Blocklist matches text + aria-label.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Run config</h2>
        <div className="pc-test-card-row">
          <label>
            Start at route{' '}
            <input
              type="text"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              style={{ width: 240 }}
              disabled={runState !== 'idle'}
            />
          </label>
          <label>
            Duration{' '}
            <Select
              value={duration}
              onChange={(v) => setDuration(v as Duration)}
              disabled={runState !== 'idle'}
              ariaLabel="Chaos run duration"
              options={[
                { value: '30s', label: '30 seconds' },
                { value: '2m', label: '2 minutes' },
                { value: '10m', label: '10 minutes' },
              ]}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked || null)}
              disabled={runState !== 'idle'}
            />{' '}
            Dry run (observe only, no clicks)
          </label>
        </div>
        <div className="pc-test-card-row" style={{ alignItems: 'flex-start' }}>
          <label style={{ flex: 1 }}>
            Blocklist (comma-separated, matched against text + aria-label){' '}
            <textarea
              value={blocklist}
              onChange={(e) => setBlocklist(e.target.value)}
              rows={2}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
              disabled={runState !== 'idle'}
            />
          </label>
        </div>
        <div className="pc-test-card-row">
          {runState === 'idle' ? (
            <Button variant="primary" onClick={launch}>Launch recorder window</Button>
          ) : (
            <Button variant="destructive" onClick={stopRun} disabled={runState === 'finishing'}>
              Stop {runState === 'finishing' ? '(finishing…)' : ''}
            </Button>
          )}
          {runState === 'recording' && (
            <span style={{ color: 'var(--fg-mute)' }}>
              {progress.clicks} slow clicks · {Math.round(progress.elapsedMs / 1000)}s elapsed
            </span>
          )}
          {runState === 'launching' && <span style={{ color: 'var(--fg-mute)' }}>Waiting for recorder window…</span>}
        </div>
      </div>

      {lastRun && (
        <div className="pc-test-card">
          <h2 className="pc-test-card-title">
            Last run — {Math.round(lastRun.durationMs / 1000)}s · {lastRun.clicks} slow clicks
          </h2>
          <div className="pc-test-card-row">
            <span className="pc-test-badge is-muted">long tasks {longTasks}</span>
            <span className="pc-test-badge is-muted">layout shifts {layoutShifts}</span>
            <span className={`pc-test-badge ${errors.length ? 'is-poor' : 'is-good'}`}>errors {errors.length}</span>
            <span style={{ marginLeft: 'auto' }}>
              <Button variant="ghost" onClick={exportJson}>Export JSON</Button>
            </span>
          </div>

          <table className="pc-test-metric-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 80 }}>INP</th>
                <th>Route</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {slowest.length === 0 ? (
                <tr><td colSpan={3} style={{ padding: 16, color: 'var(--fg-mute)' }}>No slow clicks captured.</td></tr>
              ) : slowest.map((e, i) => {
                const rating = rateINP(e.inp ?? 0);
                const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
                return (
                  <tr key={i}>
                    <td><span className={`pc-test-badge ${cls}`}>{e.inp}ms</span></td>
                    <td><code>{e.route}</code></td>
                    <td>{e.target}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <div className="pc-test-card">
          <h2 className="pc-test-card-title">History</h2>
          <table className="pc-test-metric-table">
            <thead>
              <tr><th>When</th><th>Duration</th><th>Slow clicks</th><th>Errors</th><th>Run id</th></tr>
            </thead>
            <tbody>
              {history.map((r) => {
                const errs = r.events.filter((e) => e.kind === 'console-error' || e.kind === 'unhandled-error').length;
                return (
                  <tr key={r.runId} onClick={() => setLastRun(r)} style={{ cursor: 'pointer' }}>
                    <td>{new Date(r.startedAt).toLocaleString()}</td>
                    <td>{Math.round(r.durationMs / 1000)}s</td>
                    <td>{r.clicks}</td>
                    <td><span className={`pc-test-badge ${errs ? 'is-poor' : 'is-good'}`}>{errs}</span></td>
                    <td><code style={{ fontSize: 11 }}>{r.runId}</code></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pc-test-card-row" style={{ marginTop: 8 }}>
            <Button variant="ghost" onClick={() => { clearRuns(); setHistory([]); setLastRun(null); }}>Clear history</Button>
          </div>
        </div>
      )}
    </>
  );
}
