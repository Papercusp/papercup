/**
 * ExperimentsPanel — the Benchmark view's experiment scoreboard
 * (experiment-registry-invocation-api-2026-06-14 P-051).
 *
 * Renders the experiment_runs ledger (`learning.experiments` sync query): each
 * `experiment:run` — its test + tier, the compared arms with their judge scores
 * (winner highlighted), total spend, and the decision (a winner is a proposal until
 * the apply path graduates it, D-006). Until an experiment is run the ledger is empty
 * and the panel renders its nothing-run state.
 *
 * Self-contained on purpose (own sync query + pc-experiments__* styles, mirroring
 * DemandPanel) so the LearningTab wiring stays one line. Defensive about the row
 * shape — anything unexpected renders the empty state, never a crash.
 */
import { useSyncQuery } from '@papercusp/sync';
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { ExperimentRunSummary } from '@papercusp/operator-core/lib/experiment/ledger';

const TIER_TONE: Record<string, string> = {
  offline: '#7dd3fc',
  shadow: '#c4b5fd',
  live: '#fbbf24',
};

const DECISION_TONE: Record<string, string> = {
  proposed: '#fbbf24',
  applied: '#34d399',
  rejected: '#f87171',
};

function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function scoreLabel(n: number | null): string {
  return n === null || Number.isNaN(n) ? '—' : n.toFixed(1);
}

export function ExperimentsPanel() {
  const sync = useSyncQuery<ExperimentRunSummary>({ queryName: 'learning.experiments', args: {}, staleTime: 30_000 });
  const runs = Array.isArray(sync.data) ? sync.data.filter((r) => r && typeof r.batteryId === 'string') : [];

  return (
    <section className="pc-experiments" aria-label="Experiment scoreboard">
      <div className="pc-experiments__head">
        <h3 className="pc-experiments__title">
          <FlaskConical size={14} aria-hidden /> Experiments
        </h3>
        <span className="pc-experiments__sub">A/B results from experiment:run — how each varied arm scored vs the baseline</span>
        <button
          type="button"
          className="pc-experiments__refresh"
          aria-label="Reload the experiment scoreboard"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="pc-experiments__empty">
          No experiments run yet. <code>experiment:run</code> A/B-tests a knob change on the offline replay tier and records the
          result here — it rides the frontier:replay-harness budget, so it stays quiet until that loop is armed.
        </p>
      ) : (
        <ul className="pc-experiments__list">
          {runs.map((r) => {
            const arms = Array.isArray(r.arms) ? r.arms : [];
            return (
              <li key={`${r.batteryId}`} className="pc-experiments__row" title={r.batteryId}>
                <span className="pc-experiments__test">{r.testId}</span>
                <span className="pc-experiments__tier" style={{ color: TIER_TONE[r.tier] ?? '#7f9bb4' }}>
                  {r.tier}
                </span>
                <span className="pc-experiments__arms">
                  {arms.map((a) => (
                    <span
                      key={a.id}
                      className={a.id === r.winner ? 'pc-experiments__arm pc-experiments__arm--win' : 'pc-experiments__arm'}
                      title={a.label}
                    >
                      {a.id} {scoreLabel(a.meanScore)}
                    </span>
                  ))}
                </span>
                <span className="pc-experiments__meta">
                  <span className="pc-experiments__winner" title="Winning arm">
                    {r.winner ? `▲ ${r.winner}` : 'no winner'}
                  </span>
                  <span title="Total spend">${r.totalCostUsd.toFixed(3)}</span>
                  <span
                    className="pc-experiments__decision"
                    style={{ color: DECISION_TONE[r.decision] ?? '#7f9bb4' }}
                    title="A winner is a proposal until the apply path graduates it"
                  >
                    {r.decision}
                  </span>
                  <span className="pc-experiments__age">{dateShort(r.createdAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <style>{`
        .pc-experiments { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-experiments__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-experiments__title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 650; }
        .pc-experiments__sub { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-experiments__refresh { display: inline-flex; align-items: center; border: none; background: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 2px; }
        .pc-experiments__refresh:disabled { opacity: 0.5; cursor: default; }
        .pc-experiments__empty { margin: 8px 0 2px; font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-experiments__empty code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
        .pc-experiments__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-experiments__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-experiments__test { flex: none; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #06121a; background: #7dd3fc; border-radius: 4px; padding: 1px 5px; }
        .pc-experiments__tier { flex: none; font-size: 10.5px; font-weight: 600; }
        .pc-experiments__arms { flex: 1 1 auto; min-width: 0; display: inline-flex; flex-wrap: wrap; gap: 6px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
        .pc-experiments__arm { color: var(--fg-mute, #7f9bb4); }
        .pc-experiments__arm--win { color: #34d399; font-weight: 650; }
        .pc-experiments__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-experiments__winner { color: var(--fg, #cfe6ff); }
        .pc-experiments__age { opacity: 0.85; }
      `}</style>
    </section>
  );
}

export default ExperimentsPanel;
