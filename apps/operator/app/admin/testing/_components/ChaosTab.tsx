'use client';

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum, parseAsBoolean } from 'nuqs';
import { useState } from 'react';
import { Button } from '../../../harness/Button';
import { Select } from '../../../harness/Select';
import {
  CHANNEL_NAME,
  type ControllerMsg,
  type RecorderMsg,
  type RecorderEvent,
  type RunSummary,
  clearRuns,
  rollupRoutes,
} from '../_lib/recorder-channel';
import {
  clearHistory as storeClearHistory,
  finalizeRun,
  getChaosSnapshot,
  idleReset,
  pushLiveEvent,
  resetForNewRun,
  setProgress as storeSetProgress,
  setRunState as storeSetRunState,
  subscribeChaos,
} from '../_lib/chaos-store';
import { rateINP } from '../_lib/vitals-recorder';

const DEFAULT_BLOCKLIST = 'delete,remove,reset,sign out,log out,destroy,drop,wipe,format,uninstall,revoke';

type Duration = '10s' | '30s' | '2m' | '10m';

const DURATIONS: Record<Duration, number> = {
  '10s': 10_000,
  '30s': 30_000,
  '2m': 120_000,
  '10m': 600_000,
};

interface TargetAggregate {
  key: string;
  route: string;
  target: string;
  count: number;
  medianInp: number;
  p95Inp: number;
  maxInp: number;
  worstSample: RecorderEvent;
}

function aggregateBySlowTarget(events: RecorderEvent[]): TargetAggregate[] {
  const groups = new Map<string, RecorderEvent[]>();
  for (const e of events) {
    if (e.kind !== 'click' || typeof e.inp !== 'number') continue;
    const key = `${e.route}\u0000${e.target}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out: TargetAggregate[] = [];
  for (const [key, list] of groups) {
    const inps = list.map((e) => e.inp!).sort((a, b) => a - b);
    const med = inps[Math.floor(inps.length / 2)];
    const p95 = inps[Math.min(inps.length - 1, Math.floor(inps.length * 0.95))];
    const max = inps[inps.length - 1];
    const worst = list.reduce((acc, e) => ((e.inp ?? 0) > (acc.inp ?? 0) ? e : acc), list[0]);
    const [route, target] = key.split('\u0000');
    out.push({ key, route, target, count: list.length, medianInp: med, p95Inp: p95, maxInp: max, worstSample: worst });
  }
  return out.sort((a, b) => b.maxInp - a.maxInp);
}

// Module-scope run state (survives ChaosTab remounts).
interface ActiveRunResources {
  runId: string;
  controllerStartedAt: number;
  durationMs: number;
  channel: BroadcastChannel | null;
  unlistenTauri: (() => void) | null;
  emitTauri: ((msg: ControllerMsg) => void) | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  recorderWindowLabel: string | null;
  liveEvents: RecorderEvent[];
  progress: { clicks: number; elapsedMs: number };
}
let activeRun: ActiveRunResources | null = null;

async function closeAllRecorderWindows() {
  const api = (window as unknown as {
    __TAURI__?: { webviewWindow?: { getAllWebviewWindows?: () => Promise<Array<{ label: string; close: () => Promise<void> }>> } };
  }).__TAURI__?.webviewWindow;
  const getAll = api?.getAllWebviewWindows;
  if (!getAll) return;
  try {
    const windows = await getAll();
    await Promise.allSettled(
      windows.filter((w) => w.label.startsWith('papercusp-perf-recorder-')).map((w) => w.close()),
    );
  } catch { /* best effort */ }
}

function cleanupActiveRun(closeRecorders: boolean) {
  if (!activeRun) return;
  if (activeRun.stopTimer) clearTimeout(activeRun.stopTimer);
  if (activeRun.finalizeTimer) clearTimeout(activeRun.finalizeTimer);
  activeRun.unlistenTauri?.();
  activeRun.channel?.close();
  if (closeRecorders) void closeAllRecorderWindows();
  activeRun = null;
}

async function startChaosRun(opts: {
  route: string;
  duration: Duration;
  dryRun: boolean;
  blocklist: string[];
}): Promise<void> {
  // Drop anything from a prior run.
  cleanupActiveRun(true);

  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inTauri = Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (inTauri) await closeAllRecorderWindows();

  const controllerStartedAt = Date.now();
  const durationMs = DURATIONS[opts.duration];
  const startMsg: ControllerMsg = {
    type: 'start',
    runId,
    durationMs,
    blocklist: opts.blocklist,
    dryRun: opts.dryRun,
  };

  resetForNewRun(runId);

  const run: ActiveRunResources = {
    runId,
    controllerStartedAt,
    durationMs,
    channel: null,
    unlistenTauri: null,
    emitTauri: null,
    stopTimer: null,
    finalizeTimer: null,
    recorderWindowLabel: null,
    liveEvents: [],
    progress: { clicks: 0, elapsedMs: 0 },
  };
  activeRun = run;

  const finalizeFromController = () => {
    if (!activeRun || activeRun.runId !== runId) return;
    const summary: RunSummary = {
      runId,
      startedAt: controllerStartedAt,
      endedAt: Date.now(),
      durationMs: Math.max(activeRun.progress.elapsedMs, Date.now() - controllerStartedAt),
      clicks: activeRun.progress.clicks,
      events: activeRun.liveEvents,
      routes: rollupRoutes(activeRun.liveEvents),
    };
    cleanupActiveRun(true);
    finalizeRun(summary);
  };

  const handleRecorderMsg = (m: RecorderMsg) => {
    if (!activeRun || activeRun.runId !== runId) return;
    if (m.runId && m.runId !== runId) return;
    if (m.type === 'ready') {
      activeRun.emitTauri?.(startMsg);
      activeRun.channel?.postMessage(startMsg);
    } else if (m.type === 'started') {
      storeSetRunState('recording');
      if (activeRun.stopTimer) clearTimeout(activeRun.stopTimer);
      activeRun.stopTimer = setTimeout(() => {
        const msg = { type: 'stop', runId } as ControllerMsg;
        activeRun?.emitTauri?.(msg);
        activeRun?.channel?.postMessage(msg);
      }, durationMs + 2_000);
      if (activeRun.finalizeTimer) clearTimeout(activeRun.finalizeTimer);
      activeRun.finalizeTimer = setTimeout(finalizeFromController, durationMs + 6_000);
    } else if (m.type === 'progress') {
      activeRun.progress = { clicks: m.clicks, elapsedMs: m.elapsedMs };
      storeSetProgress(activeRun.progress);
    } else if (m.type === 'event') {
      activeRun.liveEvents = [...activeRun.liveEvents, m.event];
      pushLiveEvent(m.event);
    } else if (m.type === 'done') {
      const summary = m.summary && Array.isArray(m.summary.events) && m.summary.events.length === 0
        // recorder sends a lite summary (events: []) — backfill from our live capture
        ? { ...m.summary, events: activeRun.liveEvents, routes: rollupRoutes(activeRun.liveEvents) }
        : (m.summary ?? {
            runId,
            startedAt: controllerStartedAt,
            endedAt: Date.now(),
            durationMs: Math.max(activeRun.progress.elapsedMs, Date.now() - controllerStartedAt),
            clicks: activeRun.progress.clicks,
            events: activeRun.liveEvents,
            routes: rollupRoutes(activeRun.liveEvents),
          });
      cleanupActiveRun(true);
      finalizeRun(summary);
    }
  };

  // Set up transports
  if (inTauri) {
    const eventApi = (window as unknown as {
      __TAURI__?: { event?: { emit?: (name: string, payload: unknown) => Promise<void>; listen?: (name: string, cb: (event: { payload: unknown }) => void) => Promise<() => void> } };
    }).__TAURI__?.event;
    if (eventApi?.listen && eventApi?.emit) {
      try {
        const off = await eventApi.listen(CHANNEL_NAME, (event) => {
          handleRecorderMsg(event.payload as RecorderMsg);
        });
        run.unlistenTauri = off;
        run.emitTauri = (msg) => { void eventApi.emit!(CHANNEL_NAME, msg); };
      } catch {
        // capability denied; fall through to channel only
      }
    }
  } else {
    run.channel = new BroadcastChannel(CHANNEL_NAME);
    run.channel.addEventListener('message', (e) => {
      handleRecorderMsg(e.data as RecorderMsg);
    });
  }

  // Open recorder window
  const url = new URL(opts.route, window.location.origin);
  url.searchParams.set('perf-recorder', '1');
  url.searchParams.set('perf-run-id', runId);
  url.searchParams.set('perf-duration-ms', String(durationMs));
  url.searchParams.set('perf-dry-run', opts.dryRun ? '1' : '0');
  opts.blocklist.forEach((item) => url.searchParams.append('perf-block', item));
  const urlStr = url.toString();

  if (inTauri) {
    try {
      const WebviewWindow = (window as unknown as {
        __TAURI__?: { webviewWindow?: { WebviewWindow?: new (label: string, opts: { url: string; title: string; width: number; height: number }) => { close: () => Promise<void>; setFocus?: () => Promise<void> } } };
      }).__TAURI__?.webviewWindow?.WebviewWindow;
      if (!WebviewWindow) throw new Error('window.__TAURI__.webviewWindow.WebviewWindow is unavailable');
      const label = `papercusp-perf-recorder-${runId}`;
      const recorderWindow = new WebviewWindow(label, {
        url: urlStr,
        title: 'Papercusp perf recorder',
        width: 1280,
        height: 800,
      });
      run.recorderWindowLabel = label;
      void recorderWindow.setFocus?.().catch(() => {});
      // Send start kicks until recorder has signaled started.
      let attempts = 0;
      const kick = () => {
        if (!activeRun || activeRun.runId !== runId) return;
        if (getChaosSnapshot().runState === 'recording') return;
        run.emitTauri?.(startMsg);
        attempts += 1;
        if (attempts < 12) setTimeout(kick, 1000);
      };
      setTimeout(kick, 250);
    } catch (err) {
      cleanupActiveRun(true);
      storeSetRunState('idle');
      alert(`Could not open recorder window: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const popup = window.open(urlStr, 'papercusp-perf-recorder', 'width=1280,height=800');
  if (!popup) {
    cleanupActiveRun(false);
    storeSetRunState('idle');
    alert('Popup blocked — allow popups for this site to run chaos tests.');
  }
}

function stopChaosRun() {
  if (!activeRun) return;
  storeSetRunState('finishing');
  const msg = { type: 'stop', runId: activeRun.runId } as ControllerMsg;
  activeRun.emitTauri?.(msg);
  activeRun.channel?.postMessage(msg);
}

export default function ChaosTab() {
  const [route, setRoute] = useQueryState('chaosRoute', parseAsString.withDefault('/'));
  const [duration, setDuration] = useQueryState(
    'chaosDur',
    parseAsStringEnum<Duration>(['10s', '30s', '2m', '10m']).withDefault('30s'),
  );
  const [dryRun, setDryRun] = useQueryState('dry', parseAsBoolean.withDefault(false));
  const [blocklist, setBlocklist] = useState(DEFAULT_BLOCKLIST);
  const snap = useSyncExternalStore(subscribeChaos, getChaosSnapshot, getChaosSnapshot);

  const [historicalRunId, setHistoricalRunId] = useState<string | null>(null);

  // Install escape hatches so the automated test runner can reset a stuck
  // chaos run and read the same in-memory snapshot that drives the UI.
  useEffect(() => {
    (window as {
      __papercuspChaosIdleReset?: () => void;
      __papercuspGetChaosSnapshot?: () => ReturnType<typeof getChaosSnapshot>;
    }).__papercuspChaosIdleReset = () => {
      cleanupActiveRun(true);
      idleReset();
    };
    (window as {
      __papercuspChaosIdleReset?: () => void;
      __papercuspGetChaosSnapshot?: () => ReturnType<typeof getChaosSnapshot>;
    }).__papercuspGetChaosSnapshot = () => getChaosSnapshot();
    return () => {
      delete (window as { __papercuspChaosIdleReset?: () => void }).__papercuspChaosIdleReset;
      delete (window as { __papercuspGetChaosSnapshot?: () => ReturnType<typeof getChaosSnapshot> }).__papercuspGetChaosSnapshot;
    };
  }, []);

  const viewing = useMemo(() => {
    if (historicalRunId) {
      const h = snap.history.find((r) => r.runId === historicalRunId);
      if (h) return { source: 'history' as const, events: h.events, summary: h };
    }
    if (snap.runState !== 'idle') return { source: 'live' as const, events: snap.liveEvents, summary: null };
    if (snap.lastSummary) return { source: 'summary' as const, events: snap.lastSummary.events, summary: snap.lastSummary };
    return { source: 'empty' as const, events: [] as RecorderEvent[], summary: null };
  }, [historicalRunId, snap.history, snap.runState, snap.liveEvents, snap.lastSummary]);

  const events = viewing.events;
  const slowTargets = useMemo(() => aggregateBySlowTarget(events), [events]);
  const routeRollup = useMemo(() => Object.values(rollupRoutes(events)).sort((a, b) => b.maxInp - a.maxInp), [events]);
  const errors = useMemo(() => events.filter((e) => e.kind === 'console-error' || e.kind === 'unhandled-error'), [events]);
  const longTasks = useMemo(() => events.filter((e) => e.kind === 'long-task').sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)), [events]);
  const layoutShifts = useMemo(() => events.filter((e) => e.kind === 'layout-shift'), [events]);
  const recentSlowClicks = useMemo(() => {
    const clicks = events.filter((e) => e.kind === 'click' && typeof e.inp === 'number');
    return clicks.slice(-15).reverse();
  }, [events]);

  const launch = useCallback(() => {
    void startChaosRun({
      route,
      duration,
      dryRun,
      blocklist: blocklist.split(',').map((s) => s.trim()).filter(Boolean),
    });
  }, [route, duration, dryRun, blocklist]);

  const exportJson = () => {
    const summary = viewing.summary ?? { events, runId: 'live', startedAt: Date.now(), endedAt: Date.now(), durationMs: snap.progress.elapsedMs, clicks: snap.progress.clicks, routes: rollupRoutes(events) };
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chaos-run-${summary.runId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const isRunning = snap.runState !== 'idle';

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Chaos</h1>
          <p className="pc-test-tab-intro">
            Random monkey clicks for the chosen duration. Live tables update as the run progresses —
            you don't have to wait for it to finish. Sort by max INP at the top to find your worst
            offenders; the worst-target table groups by element so repeated clicks roll up into one row.
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
              disabled={isRunning}
            />
          </label>
          <label>
            Duration{' '}
            <Select
              value={duration}
              onChange={(v) => setDuration(v as Duration)}
              disabled={isRunning}
              ariaLabel="Chaos run duration"
              options={[
                { value: '10s', label: '10 seconds' },
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
              disabled={isRunning}
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
              disabled={isRunning}
            />
          </label>
        </div>
        <div className="pc-test-card-row">
          {snap.runState === 'idle' ? (
            <Button variant="primary" onClick={launch}>Launch recorder window</Button>
          ) : (
            <Button variant="destructive" onClick={stopChaosRun} disabled={snap.runState === 'finishing'}>
              Stop {snap.runState === 'finishing' ? '(finishing…)' : ''}
            </Button>
          )}
          {snap.runState === 'recording' && (
            <span style={{ color: 'var(--fg-mute)' }}>
              {snap.progress.clicks} slow clicks · {Math.round(snap.progress.elapsedMs / 1000)}s elapsed
              {' · '}
              {events.length} events
            </span>
          )}
          {snap.runState === 'launching' && <span style={{ color: 'var(--fg-mute)' }}>Waiting for recorder window…</span>}
        </div>
      </div>

      {viewing.source !== 'empty' && (
        <>
          <div className="pc-test-card">
            <h2 className="pc-test-card-title">
              {viewing.source === 'live' && <>Live · </>}
              {viewing.source === 'summary' && viewing.summary && <>Last run · {Math.round(viewing.summary.durationMs / 1000)}s · </>}
              {viewing.source === 'history' && viewing.summary && <>History run · {Math.round(viewing.summary.durationMs / 1000)}s · </>}
              {slowTargets.length} unique slow targets across {routeRollup.length} routes
            </h2>
            <div className="pc-test-card-row">
              <span className={`pc-test-badge ${slowTargets.some((t) => t.maxInp > 500) ? 'is-poor' : slowTargets.some((t) => t.maxInp > 200) ? 'is-needs' : 'is-good'}`}>
                worst INP {slowTargets[0]?.maxInp ?? 0}ms
              </span>
              <span className="pc-test-badge is-muted">long tasks {longTasks.length}</span>
              <span className="pc-test-badge is-muted">layout shifts {layoutShifts.length}</span>
              <span className={`pc-test-badge ${errors.length ? 'is-poor' : 'is-good'}`}>errors {errors.length}</span>
              <span style={{ marginLeft: 'auto' }}>
                <Button variant="ghost" onClick={exportJson}>Export JSON</Button>
              </span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '4px 0 0' }}>
              <strong>INP</strong> rating: ≤200ms good · ≤500ms needs improvement · &gt;500ms poor.
              {' '}<strong>Long tasks</strong> &gt;50ms blocked the main thread.
              {' '}<strong>Layout shifts</strong> are unexpected visual movement (CLS).
            </p>
          </div>

          {slowTargets.length > 0 && (
            <div className="pc-test-card">
              <h2 className="pc-test-card-title">Worst slow targets (grouped)</h2>
              <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '0 0 8px' }}>
                Same element clicked N times rolled into one row. Sort key = max INP. Each row points at a single
                element + route — that's where the perf work is.
              </p>
              <table className="pc-test-metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>Max INP</th>
                    <th style={{ width: 80 }}>p95</th>
                    <th style={{ width: 80 }}>Median</th>
                    <th style={{ width: 60 }}>Hits</th>
                    <th>Route</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {slowTargets.slice(0, 30).map((t) => {
                    const rating = rateINP(t.maxInp);
                    const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
                    return (
                      <tr key={t.key}>
                        <td><span className={`pc-test-badge ${cls}`}>{t.maxInp}ms</span></td>
                        <td>{t.p95Inp}ms</td>
                        <td>{t.medianInp}ms</td>
                        <td>{t.count}</td>
                        <td><code>{t.route}</code></td>
                        <td>{t.target}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {errors.length > 0 && (
            <div className="pc-test-card">
              <h2 className="pc-test-card-title">Errors caught ({errors.length})</h2>
              <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '0 0 8px' }}>
                Console errors and unhandled exceptions captured during the run. These almost always
                represent real bugs — a button that throws, a fetch that 500s, a React render that errors.
              </p>
              <table className="pc-test-metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Kind</th>
                    <th>Route</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.slice(0, 40).map((e, i) => (
                    <tr key={`err-${i}`}>
                      <td><span className="pc-test-badge is-poor">{e.kind}</span></td>
                      <td><code style={{ fontSize: 11 }}>{e.route}</code></td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{e.detail ?? e.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {longTasks.length > 0 && (
            <div className="pc-test-card">
              <h2 className="pc-test-card-title">Long tasks ({longTasks.length})</h2>
              <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '0 0 8px' }}>
                Single JS tasks that blocked the main thread &gt;50ms. Each long task is a missed frame.
                For attribution, run with Chrome DevTools Performance recorder during a chaos session and
                cross-reference timestamps.
              </p>
              <table className="pc-test-metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>Duration</th>
                    <th>Route</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {longTasks.slice(0, 20).map((e, i) => {
                    const ms = e.duration ?? 0;
                    const cls = ms > 200 ? 'is-poor' : ms > 100 ? 'is-needs' : 'is-muted';
                    return (
                      <tr key={`lt-${i}`}>
                        <td><span className={`pc-test-badge ${cls}`}>{ms}ms</span></td>
                        <td><code style={{ fontSize: 11 }}>{e.route}</code></td>
                        <td style={{ color: 'var(--fg-mute)' }}>{new Date(e.ts).toLocaleTimeString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {routeRollup.length > 0 && (
            <div className="pc-test-card">
              <h2 className="pc-test-card-title">By route</h2>
              <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '0 0 8px' }}>
                Routes visited during the chaos run, ranked by worst INP. p95 is a more honest signal
                than max — one outlier doesn't drag it.
              </p>
              <table className="pc-test-metric-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th style={{ width: 80 }}>Clicks</th>
                    <th style={{ width: 90 }}>p50</th>
                    <th style={{ width: 90 }}>p95</th>
                    <th style={{ width: 90 }}>Max</th>
                    <th style={{ width: 80 }}>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {routeRollup.map((r) => {
                    const rating = rateINP(r.p95inp);
                    const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
                    return (
                      <tr key={r.route}>
                        <td><code>{r.route}</code></td>
                        <td>{r.clicks}</td>
                        <td>{r.p50inp || '—'}{r.p50inp ? 'ms' : ''}</td>
                        <td>{r.p95inp ? <span className={`pc-test-badge ${cls}`}>{r.p95inp}ms</span> : '—'}</td>
                        <td>{r.maxInp || '—'}{r.maxInp ? 'ms' : ''}</td>
                        <td><span className={`pc-test-badge ${r.errors ? 'is-poor' : 'is-good'}`}>{r.errors}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {viewing.source === 'live' && recentSlowClicks.length > 0 && (
            <div className="pc-test-card">
              <h2 className="pc-test-card-title">Latest slow clicks</h2>
              <table className="pc-test-metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>INP</th>
                    <th style={{ width: 100 }}>When</th>
                    <th>Route</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSlowClicks.map((e, i) => {
                    const rating = rateINP(e.inp ?? 0);
                    const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
                    return (
                      <tr key={`recent-${i}`}>
                        <td><span className={`pc-test-badge ${cls}`}>{e.inp}ms</span></td>
                        <td style={{ color: 'var(--fg-mute)' }}>{Math.round((Date.now() - e.ts) / 1000)}s ago</td>
                        <td><code>{e.route}</code></td>
                        <td>{e.target}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {snap.history.length > 0 && (
        <div className="pc-test-card">
          <h2 className="pc-test-card-title">History (click a row to inspect)</h2>
          <table className="pc-test-metric-table">
            <thead>
              <tr><th>When</th><th>Duration</th><th>Slow clicks</th><th>Errors</th><th>Run id</th></tr>
            </thead>
            <tbody>
              {snap.history.map((r) => {
                const errs = r.events.filter((e) => e.kind === 'console-error' || e.kind === 'unhandled-error').length;
                const isSelected = r.runId === historicalRunId;
                return (
                  <tr key={r.runId} onClick={() => setHistoricalRunId(isSelected ? null : r.runId)} style={{ cursor: 'pointer', background: isSelected ? 'var(--bg-3)' : undefined }}>
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
            <Button variant="ghost" onClick={() => { clearRuns(); storeClearHistory(); setHistoricalRunId(null); }}>Clear history</Button>
          </div>
        </div>
      )}
    </>
  );
}
