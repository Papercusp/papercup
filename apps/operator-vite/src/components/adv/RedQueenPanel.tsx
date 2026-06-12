/**
 * RedQueenPanel — the Benchmark view's MTTSH vital sign
 * (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * Renders the Red Queen drill vitals (`learning.redQueen` sync query):
 * per-class mean-time-to-self-heal medians across detect → triage → fix,
 * resolve rate, triage accuracy against planted ground truth, and the
 * zero-leak record. A failed leak check renders a loud alarm chip — a drill
 * artifact visible to an organic consumer is exactly what the provenance
 * rails exist to prevent. Until the frontier arming gate (the plan's P-001)
 * flips the drill cadence's flag the store is empty and the panel renders its
 * no-drills state.
 *
 * Self-contained on purpose (own sync query + pc-rq__* styles, mirroring
 * EkgPanel's idiom) so the LearningTab wiring stays at two lines. Defensive
 * about the snapshot shape — anything but the expected {classes: []} renders
 * the empty state, never a crash.
 */
import { useSyncQuery } from '@papercusp/sync';
import { HeartPulse, RefreshCw } from 'lucide-react';
import type { MttshVitals } from '@papercusp/operator-core/lib/red-queen/mttsh';

function ms(v: number | null): string {
  if (v == null) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v / 60_000)}m`;
}

function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function RedQueenPanel() {
  const sync = useSyncQuery<MttshVitals>({ queryName: 'learning.redQueen', args: {}, staleTime: 30_000 });
  const snap = sync.data?.[0];
  const classes = Array.isArray(snap?.classes) ? snap.classes : [];

  return (
    <section className="pc-rq" aria-label="Red Queen MTTSH vitals">
      <div className="pc-rq__head">
        <h3 className="pc-rq__title">
          <HeartPulse size={14} aria-hidden /> MTTSH
        </h3>
        <span className="pc-rq__sub">mean-time-to-self-heal against planted drills (detect → triage → fix)</span>
        <button
          type="button"
          className="pc-rq__refresh"
          aria-label="Reload the MTTSH vitals"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      {classes.length === 0 ? (
        <p className="pc-rq__empty">
          No drills run yet. The Red Queen plants known frictions in a sandbox and measures how fast the loop
          self-heals — it ships dark until the frontier arming gate flips it on.
        </p>
      ) : (
        <>
          <p className="pc-rq__rollup">
            {snap!.totalResolved}/{snap!.totalRuns} drill{snap!.totalRuns === 1 ? '' : 's'} healed · median{' '}
            {ms(snap!.medianTotalMs)}
            {snap!.leakFailures > 0 ? (
              <span className="pc-rq__leak"> · {snap!.leakFailures} LEAK CHECK FAILURE{snap!.leakFailures === 1 ? '' : 'S'}</span>
            ) : (
              ' · zero leaks'
            )}
            {snap!.lastRunAt ? ` · last drill ${dateShort(snap!.lastRunAt)}` : ''}
          </p>
          <ul className="pc-rq__list">
            {classes.map((c) => (
              <li key={c.drillClass} className="pc-rq__row">
                <span className="pc-rq__class">{c.drillClass}</span>
                <span className="pc-rq__meta">
                  <span title="Healed / total runs">{c.resolved}/{c.runs}</span>
                  <span title="Median detect → triage → fix (resolved runs)">
                    {ms(c.detectMs)} → {ms(c.triageMs)} → {ms(c.fixMs)}
                  </span>
                  <span title="Median total MTTSH">{ms(c.totalMs)}</span>
                  {c.triageJudged > 0 ? (
                    <span title="Triage decisions matching the planted expectation">
                      triage {c.triageMatches}/{c.triageJudged}
                    </span>
                  ) : null}
                  {c.leakFailures > 0 ? <span className="pc-rq__leak">LEAK ×{c.leakFailures}</span> : null}
                  <span className="pc-rq__age" title="Last run">{dateShort(c.lastRunAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{`
        .pc-rq { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-rq__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-rq__title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 650; }
        .pc-rq__sub { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-rq__refresh { display: inline-flex; align-items: center; border: none; background: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 2px; }
        .pc-rq__refresh:disabled { opacity: 0.5; cursor: default; }
        .pc-rq__empty { margin: 8px 0 2px; font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-rq__rollup { margin: 6px 0 4px; font-size: 11px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-rq__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-rq__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-rq__class { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; }
        .pc-rq__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-rq__age { opacity: 0.85; }
        .pc-rq__leak { color: #fb7185; font-weight: 700; }
      `}</style>
    </section>
  );
}

export default RedQueenPanel;
