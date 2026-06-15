'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadRuns, type RunSummary, type RouteRollup } from '../_lib/recorder-channel';
import { getEvents, rateINP, type PerfEvent } from '../_lib/vitals-recorder';

export interface MergedRollup extends RouteRollup {
  liveCount: number;
  liveMaxInp: number;
  liveErrors: number;
}

/**
 * Pure: merge per-route chaos-run rollups with live observer events into a
 * single per-route table — chaos metrics accumulate (clicks/errors) or take the
 * max (p50/p95/max INP), live interactions tally liveCount/liveMaxInp, and live
 * errors bump liveErrors. Sorted by the worst of (chaos p95, live max). Exported
 * for tests.
 */
export function mergeRouteRollups(runs: RunSummary[], live: PerfEvent[]): MergedRollup[] {
  const byRoute: Record<string, MergedRollup> = {};

  for (const run of runs) {
    for (const r of Object.values(run.routes)) {
      const existing = byRoute[r.route] ?? {
        route: r.route, clicks: 0, p50inp: 0, p95inp: 0, maxInp: 0, errors: 0,
        liveCount: 0, liveMaxInp: 0, liveErrors: 0,
      };
      existing.clicks += r.clicks;
      existing.maxInp = Math.max(existing.maxInp, r.maxInp);
      existing.p95inp = Math.max(existing.p95inp, r.p95inp);
      existing.p50inp = Math.max(existing.p50inp, r.p50inp);
      existing.errors += r.errors;
      byRoute[r.route] = existing;
    }
  }

  for (const e of live) {
    const existing = byRoute[e.route] ?? {
      route: e.route, clicks: 0, p50inp: 0, p95inp: 0, maxInp: 0, errors: 0,
      liveCount: 0, liveMaxInp: 0, liveErrors: 0,
    };
    if (e.kind === 'interaction') {
      existing.liveCount++;
      existing.liveMaxInp = Math.max(existing.liveMaxInp, e.duration);
    } else if (e.kind === 'console-error' || e.kind === 'unhandled-error') {
      existing.liveErrors++;
    }
    byRoute[e.route] = existing;
  }

  return Object.values(byRoute).sort(
    (a, b) => Math.max(b.p95inp, b.liveMaxInp) - Math.max(a.p95inp, a.liveMaxInp),
  );
}

export default function RoutesTab() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [live, setLive] = useState<PerfEvent[]>([]);

  useEffect(() => {
    setRuns(loadRuns());
    setLive(getEvents());
  }, []);

  const merged: MergedRollup[] = useMemo(() => mergeRouteRollups(runs, live), [runs, live]);

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Routes</h1>
          <p className="pc-test-tab-intro">
            Per-route roll-up across all chaos runs + live observer events. Highest p95 INP at top
            — that's where to spend your perf budget. "Live max" is the worst interaction caught
            during passive ambient usage.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <table className="pc-test-metric-table">
          <thead>
            <tr>
              <th>Route</th>
              <th style={{ width: 90 }}>Chaos clicks</th>
              <th style={{ width: 90 }}>Chaos p50</th>
              <th style={{ width: 90 }}>Chaos p95</th>
              <th style={{ width: 90 }}>Chaos max</th>
              <th style={{ width: 90 }}>Live count</th>
              <th style={{ width: 90 }}>Live max</th>
              <th style={{ width: 80 }}>Errors</th>
            </tr>
          </thead>
          <tbody>
            {merged.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 16, color: 'var(--fg-mute)' }}>
                No data yet — run a chaos test or use the app to populate.
              </td></tr>
            ) : merged.map((r) => {
              const worst = Math.max(r.p95inp, r.liveMaxInp);
              const rating = rateINP(worst);
              const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
              const totalErrors = r.errors + r.liveErrors;
              return (
                <tr key={r.route}>
                  <td><code>{r.route}</code></td>
                  <td>{r.clicks}</td>
                  <td>{r.p50inp ? `${r.p50inp}ms` : '—'}</td>
                  <td>{r.p95inp ? <span className={`pc-test-badge ${cls}`}>{r.p95inp}ms</span> : '—'}</td>
                  <td>{r.maxInp ? `${r.maxInp}ms` : '—'}</td>
                  <td>{r.liveCount || '—'}</td>
                  <td>{r.liveMaxInp ? `${r.liveMaxInp}ms` : '—'}</td>
                  <td><span className={`pc-test-badge ${totalErrors ? 'is-poor' : 'is-good'}`}>{totalErrors}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
