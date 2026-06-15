'use client';
/**
 * ScoreDelta — a per-row A/B score-delta table with inline delta bars
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * Lifted + generalized from the gym dashboard's `compare` tab (the original
 * task/A/B/Δ table). Two consumers:
 *   • the Evaluation surface's Report subtab — Papercusp (B) vs each baseline
 *     A/B/C (A), per task, so the system-value delta (D-001) reads per instance;
 *   • the gym `compare` tab, which now renders this shared component.
 *
 * Δ = treatment (B) − baseline (A): positive (green) = the B column won that
 * row. A summary footer (mean Δ + win/tie/loss over scored rows) gives the
 * headline a single line. Purely presentational — the caller owns data fetch,
 * the variant/arm pickers, and the loading/error/unavailable states.
 *
 * Idiom mirrors BenchmarkTrend / ParetoFrontier: an exported pure core
 * (`summarizeDeltas`) for tests + self-carried `pc-scoredelta__*` styles.
 */
import { useMemo } from 'react';

export interface ScoreDeltaRow {
  /** Row label — a task / instance id. */
  label: string;
  /** Baseline (A) score; null when that arm has no scored run for this row. */
  a: number | null;
  /** Treatment (B) score; null when that arm has no scored run for this row. */
  b: number | null;
}

export interface ScoreDeltaSummary {
  /** Rows where BOTH a and b are present (the comparable set). */
  n: number;
  meanA: number | null;
  meanB: number | null;
  meanDelta: number | null;
  wins: number; // b > a
  losses: number; // b < a
  ties: number; // b === a
}

export interface ScoreDeltaProps {
  rows: ScoreDeltaRow[];
  /** Header for the baseline column (e.g. "Baseline B" / a variant id). */
  aLabel?: string;
  /** Header for the treatment column (e.g. "Papercusp" / a variant id). */
  bLabel?: string;
  format?: (n: number | null | undefined) => string;
  caption?: string;
  /** Render the mean-Δ + win/tie/loss footer (default true). */
  summary?: boolean;
  emptyHint?: string;
}

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 100) / 100).toString();

/** Mean over present numbers, or null when none are present. */
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Per-arm means + win/tie/loss over the COMPARABLE rows (both a and b present).
 * Δ = b − a. Exported for tests.
 */
export function summarizeDeltas(rows: readonly ScoreDeltaRow[]): ScoreDeltaSummary {
  const both = rows.filter((r): r is ScoreDeltaRow & { a: number; b: number } => r.a != null && r.b != null);
  let wins = 0, losses = 0, ties = 0;
  for (const r of both) {
    if (r.b > r.a) wins++;
    else if (r.b < r.a) losses++;
    else ties++;
  }
  const meanA = mean(both.map((r) => r.a));
  const meanB = mean(both.map((r) => r.b));
  return {
    n: both.length,
    meanA,
    meanB,
    meanDelta: meanA != null && meanB != null ? meanB - meanA : null,
    wins,
    losses,
    ties,
  };
}

function deltaOf(r: ScoreDeltaRow): number | null {
  return r.a != null && r.b != null ? r.b - r.a : null;
}

function deltaClass(d: number | null): string {
  if (d == null || d === 0) return 'pc-scoredelta__delta';
  return d > 0 ? 'pc-scoredelta__delta pc-scoredelta__delta--up' : 'pc-scoredelta__delta pc-scoredelta__delta--down';
}

export function ScoreDelta({
  rows,
  aLabel = 'A',
  bLabel = 'B',
  format = fmt,
  caption,
  summary = true,
  emptyHint = 'No rows to compare.',
}: ScoreDeltaProps) {
  const sum = useMemo(() => summarizeDeltas(rows), [rows]);
  // Largest |Δ| for scaling the inline bar; guard against 0 / no comparable rows.
  const maxAbs = useMemo(
    () => Math.max(1e-9, ...rows.map((r) => Math.abs(deltaOf(r) ?? 0))),
    [rows],
  );

  return (
    <figure className="pc-scoredelta" aria-label={caption ?? `Score delta of ${bLabel} versus ${aLabel} across ${rows.length} rows`}>
      {caption && <figcaption className="pc-scoredelta__caption">{caption}</figcaption>}
      <table className="pc-scoredelta__table">
        <thead>
          <tr>
            <th className="pc-scoredelta__th">task</th>
            <th className="pc-scoredelta__th pc-scoredelta__num">{aLabel}</th>
            <th className="pc-scoredelta__th pc-scoredelta__num">{bLabel}</th>
            <th className="pc-scoredelta__th pc-scoredelta__num">Δ</th>
            <th className="pc-scoredelta__th" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = deltaOf(r);
            const w = d == null ? 0 : (Math.abs(d) / maxAbs) * 100;
            return (
              <tr key={r.label} data-testid="scoredelta-row">
                <td className="pc-scoredelta__task" title={r.label}>{r.label}</td>
                <td className="pc-scoredelta__num">{format(r.a)}</td>
                <td className="pc-scoredelta__num">{format(r.b)}</td>
                <td className={`pc-scoredelta__num ${deltaClass(d)}`}>
                  {d == null ? '—' : `${d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''}${format(d)}`}
                </td>
                <td className="pc-scoredelta__barcell">
                  <span
                    className={d != null && d < 0 ? 'pc-scoredelta__bar pc-scoredelta__bar--down' : 'pc-scoredelta__bar pc-scoredelta__bar--up'}
                    style={{ width: `${w}%` }}
                    aria-hidden="true"
                  />
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="pc-scoredelta__empty" data-testid="scoredelta-empty">{emptyHint}</td></tr>
          )}
        </tbody>
        {summary && rows.length > 0 && (
          <tfoot>
            <tr className="pc-scoredelta__summary" data-testid="scoredelta-summary">
              <td>mean ({sum.n})</td>
              <td className="pc-scoredelta__num">{format(sum.meanA)}</td>
              <td className="pc-scoredelta__num">{format(sum.meanB)}</td>
              <td className={`pc-scoredelta__num ${deltaClass(sum.meanDelta)}`}>
                {sum.meanDelta == null ? '—' : `${sum.meanDelta > 0 ? '▲ ' : sum.meanDelta < 0 ? '▼ ' : ''}${format(sum.meanDelta)}`}
              </td>
              <td className="pc-scoredelta__wl">
                <span className="pc-scoredelta__delta--up">{sum.wins}W</span>·{sum.ties}T·<span className="pc-scoredelta__delta--down">{sum.losses}L</span>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      <ScoreDeltaStyles />
    </figure>
  );
}

function ScoreDeltaStyles() {
  return (
    <style>{`
      .pc-scoredelta { margin: 0; padding: 0; }
      .pc-scoredelta__caption { margin: 0 0 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-scoredelta__table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8); }
      .pc-scoredelta__th { text-align: left; padding: 4px 8px; font-size: 10.5px; font-weight: 600; color: var(--fg-mute, #7f9bb4); border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18)); }
      .pc-scoredelta__num { text-align: right; padding: 4px 8px; white-space: nowrap; }
      .pc-scoredelta__table tbody tr { border-top: 1px solid var(--border, rgba(125, 211, 252, 0.1)); }
      .pc-scoredelta__task { padding: 4px 8px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-scoredelta__delta--up { color: var(--good, #34d399); }
      .pc-scoredelta__delta--down { color: var(--bad, #fb7185); }
      .pc-scoredelta__barcell { width: 90px; padding: 4px 8px 4px 0; }
      .pc-scoredelta__bar { display: block; height: 6px; border-radius: 3px; min-width: 1px; }
      .pc-scoredelta__bar--up { background: var(--good, #34d399); }
      .pc-scoredelta__bar--down { background: var(--bad, #fb7185); }
      .pc-scoredelta__empty { padding: 12px 8px; color: var(--fg-mute, #7f9bb4); opacity: 0.8; }
      .pc-scoredelta__summary td { padding: 6px 8px; border-top: 2px solid var(--border-strong, rgba(125, 211, 252, 0.3)); font-weight: 650; color: var(--fg, #e7f7ff); }
      .pc-scoredelta__wl { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
    `}</style>
  );
}
