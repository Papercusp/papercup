'use client';
/**
 * Compare — a per-task A/B score-delta table with inline delta bars
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * Lifted + generalized from the gym dashboard's `compare` tab (the original
 * task/A/B/Δ table). Two consumers:
 *   • the Evaluation surface's "Report" subtab — `papercusp` (treatment) vs each
 *     baseline A/B/C, per task, so the system-value delta (D-001) reads per
 *     instance with a headline mean-Δ + win/tie/loss line;
 *   • the gym `compare` tab, which now renders this shared component.
 *
 * Δ = treatment − baseline: positive (green) = the treatment won that row.
 * Purely presentational — the caller owns data fetch, the arm/variant pickers,
 * and the loading/error/unavailable states. `baseline`/`treatment` are arm ids
 * from the locked vocab (`arms.ts`); unknown ids fall back to the raw string.
 *
 * Idiom mirrors BenchmarkTrend / Frontier: an exported pure core
 * (`summarizeDeltas`) for tests + self-carried `pc-compare__*` styles.
 */
import { useMemo } from 'react';
import { armLabel } from './arms';

export interface ComparePerTaskRow {
  /** Row label — a task / instance id. */
  label: string;
  /** Baseline-arm score; null when that arm has no scored run for this row. */
  baseline: number | null;
  /** Treatment-arm score; null when that arm has no scored run for this row. */
  treatment: number | null;
}

export interface CompareSummary {
  /** Rows where BOTH scores are present (the comparable set). */
  n: number;
  meanBaseline: number | null;
  meanTreatment: number | null;
  meanDelta: number | null;
  wins: number; // treatment > baseline
  losses: number; // treatment < baseline
  ties: number; // equal
}

export interface CompareProps {
  /** Baseline arm id (column header via armLabel). */
  baseline: string;
  /** Treatment arm id (column header via armLabel). */
  treatment: string;
  perTask: ComparePerTaskRow[];
  format?: (n: number | null | undefined) => string;
  caption?: string;
  /** Render the mean-Δ + win/tie/loss footer (default true). */
  summary?: boolean;
  emptyHint?: string;
}

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : (Math.round(n * 100) / 100).toString();

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Per-arm means + win/tie/loss over the COMPARABLE rows (both scores present).
 * Δ = treatment − baseline. Exported for tests.
 */
export function summarizeDeltas(rows: readonly ComparePerTaskRow[]): CompareSummary {
  const both = rows.filter(
    (r): r is ComparePerTaskRow & { baseline: number; treatment: number } =>
      r.baseline != null && r.treatment != null,
  );
  let wins = 0, losses = 0, ties = 0;
  for (const r of both) {
    if (r.treatment > r.baseline) wins++;
    else if (r.treatment < r.baseline) losses++;
    else ties++;
  }
  const meanBaseline = mean(both.map((r) => r.baseline));
  const meanTreatment = mean(both.map((r) => r.treatment));
  return {
    n: both.length,
    meanBaseline,
    meanTreatment,
    meanDelta: meanBaseline != null && meanTreatment != null ? meanTreatment - meanBaseline : null,
    wins,
    losses,
    ties,
  };
}

function deltaOf(r: ComparePerTaskRow): number | null {
  return r.baseline != null && r.treatment != null ? r.treatment - r.baseline : null;
}

function deltaClass(d: number | null): string {
  if (d == null || d === 0) return 'pc-compare__delta';
  return d > 0 ? 'pc-compare__delta pc-compare__delta--up' : 'pc-compare__delta pc-compare__delta--down';
}

function deltaText(d: number | null, format: (n: number | null | undefined) => string): string {
  if (d == null) return '—';
  return `${d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''}${format(d)}`;
}

export function Compare({
  baseline,
  treatment,
  perTask,
  format = fmt,
  caption,
  summary = true,
  emptyHint = 'No rows to compare.',
}: CompareProps) {
  const sum = useMemo(() => summarizeDeltas(perTask), [perTask]);
  const maxAbs = useMemo(
    () => Math.max(1e-9, ...perTask.map((r) => Math.abs(deltaOf(r) ?? 0))),
    [perTask],
  );
  const baseHdr = armLabel(baseline);
  const treatHdr = armLabel(treatment);

  return (
    <figure className="pc-compare" aria-label={caption ?? `Score delta of ${treatHdr} versus ${baseHdr} across ${perTask.length} tasks`}>
      {caption && <figcaption className="pc-compare__caption">{caption}</figcaption>}
      <table className="pc-compare__table">
        <thead>
          <tr>
            <th className="pc-compare__th">task</th>
            <th className="pc-compare__th pc-compare__num">{baseHdr}</th>
            <th className="pc-compare__th pc-compare__num">{treatHdr}</th>
            <th className="pc-compare__th pc-compare__num">Δ</th>
            <th className="pc-compare__th" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {perTask.map((r) => {
            const d = deltaOf(r);
            const w = d == null ? 0 : (Math.abs(d) / maxAbs) * 100;
            return (
              <tr key={r.label} data-testid="compare-row">
                <td className="pc-compare__task" title={r.label}>{r.label}</td>
                <td className="pc-compare__num">{format(r.baseline)}</td>
                <td className="pc-compare__num">{format(r.treatment)}</td>
                <td className={`pc-compare__num ${deltaClass(d)}`}>{deltaText(d, format)}</td>
                <td className="pc-compare__barcell">
                  <span
                    className={d != null && d < 0 ? 'pc-compare__bar pc-compare__bar--down' : 'pc-compare__bar pc-compare__bar--up'}
                    style={{ width: `${w}%` }}
                    aria-hidden="true"
                  />
                </td>
              </tr>
            );
          })}
          {perTask.length === 0 && (
            <tr><td colSpan={5} className="pc-compare__empty" data-testid="compare-empty">{emptyHint}</td></tr>
          )}
        </tbody>
        {summary && perTask.length > 0 && (
          <tfoot>
            <tr className="pc-compare__summary" data-testid="compare-summary">
              <td>mean ({sum.n})</td>
              <td className="pc-compare__num">{format(sum.meanBaseline)}</td>
              <td className="pc-compare__num">{format(sum.meanTreatment)}</td>
              <td className={`pc-compare__num ${deltaClass(sum.meanDelta)}`}>{deltaText(sum.meanDelta, format)}</td>
              <td className="pc-compare__wl">
                <span className="pc-compare__delta--up">{sum.wins}W</span>·{sum.ties}T·<span className="pc-compare__delta--down">{sum.losses}L</span>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      <CompareStyles />
    </figure>
  );
}

function CompareStyles() {
  return (
    <style>{`
      .pc-compare { margin: 0; padding: 0; }
      .pc-compare__caption { margin: 0 0 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-compare__table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--fg-dim, #b9d4e8); }
      .pc-compare__th { text-align: left; padding: 4px 8px; font-size: 10.5px; font-weight: 600; color: var(--fg-mute, #7f9bb4); border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18)); }
      .pc-compare__num { text-align: right; padding: 4px 8px; white-space: nowrap; }
      .pc-compare__table tbody tr { border-top: 1px solid var(--border, rgba(125, 211, 252, 0.1)); }
      .pc-compare__task { padding: 4px 8px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-compare__delta--up { color: var(--good, #34d399); }
      .pc-compare__delta--down { color: var(--bad, #fb7185); }
      .pc-compare__barcell { width: 90px; padding: 4px 8px 4px 0; }
      .pc-compare__bar { display: block; height: 6px; border-radius: 3px; min-width: 1px; }
      .pc-compare__bar--up { background: var(--good, #34d399); }
      .pc-compare__bar--down { background: var(--bad, #fb7185); }
      .pc-compare__empty { padding: 12px 8px; color: var(--fg-mute, #7f9bb4); opacity: 0.8; }
      .pc-compare__summary td { padding: 6px 8px; border-top: 2px solid var(--border-strong, rgba(125, 211, 252, 0.3)); font-weight: 650; color: var(--fg, #e7f7ff); }
      .pc-compare__wl { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
    `}</style>
  );
}
