'use client';
/**
 * ParetoFrontier — a dependency-free SVG cost/accuracy Pareto scatter
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * The headline visual of the Evaluation surface (D-007): one point per arm
 * (Papercusp + Baseline A/B/C), X = cost (lower is better), Y = accuracy /
 * resolved (higher is better). The Pareto-optimal arms — the set no other arm
 * beats on BOTH cost and accuracy — are highlighted and joined by the frontier
 * line, so "we are on a strictly better cost/accuracy point" reads at a glance
 * (the plan's load-bearing fairness claim).
 *
 * Purely presentational: it takes plotted `points` and reads NO data itself —
 * the Evaluation scaffold (P-020) owns the @papercusp/sync read and feeds this.
 * That keeps it reusable as a generic 2D Pareto scatter for any cost/score
 * comparison. (Distinct from the gym's `frontier`, which is an N-dimensional
 * vector Pareto over train tasks and renders as a list, not a 2D plane.)
 *
 * Idiom mirrors BenchmarkTrend: an exported pure projection (`projectFrontier`)
 * + Pareto core (`paretoOptimalIds`) for tests, self-carried `pc-frontier__*`
 * styles with CSS-var fallbacks, aria-label + per-point <title> tooltips.
 */
import { useMemo } from 'react';

export interface FrontierPoint {
  /** Stable id (e.g. the arm id) — used for React keys + highlight matching. */
  id: string;
  /** Human label rendered next to the point and in the tooltip (e.g. "Papercusp"). */
  label: string;
  /** X axis — lower is better (e.g. USD or tokens spent). */
  cost: number;
  /** Y axis — higher is better (e.g. resolved fraction / pass@1). */
  score: number;
}

export interface ParetoFrontierProps {
  points: FrontierPoint[];
  xLabel?: string;
  yLabel?: string;
  /** Tick + tooltip formatter for the cost axis. Default: 2-dp. */
  formatX?: (n: number) => string;
  /** Tick + tooltip formatter for the score axis. Default: 2-dp. */
  formatY?: (n: number) => string;
  /** Ring this point id (e.g. the Papercusp arm) so the eye lands on it. */
  highlightId?: string;
  width?: number;
  height?: number;
  caption?: string;
  /** Hint shown when there are no points yet (the surface may also gate this). */
  emptyHint?: string;
}

interface PlottedPoint extends FrontierPoint {
  x: number;
  y: number;
  onFrontier: boolean;
}

const DEFAULT_W = 520;
const DEFAULT_H = 320;
const PAD = { top: 16, right: 70, bottom: 34, left: 52 };

const fmt2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * The 2D Pareto set: ids of points that no OTHER point beats on both axes
 * (lower cost AND higher score). A point P dominates Q iff P.cost ≤ Q.cost and
 * P.score ≥ Q.score with at least one strict — Q is then dominated and dropped.
 * Identical points don't dominate each other, so genuine ties both survive.
 * Exported for tests.
 */
export function paretoOptimalIds(points: readonly FrontierPoint[]): string[] {
  return points
    .filter((p) =>
      !points.some(
        (q) =>
          q !== p &&
          q.cost <= p.cost &&
          q.score >= p.score &&
          (q.cost < p.cost || q.score > p.score),
      ),
    )
    .map((p) => p.id);
}

/**
 * Project points into the plot box (scale-free, padded domains) and flag the
 * Pareto-optimal set. SVG y grows downward, so a higher score maps to a smaller
 * y. Domains are padded so a tight cluster doesn't fill the box; a degenerate
 * (single value / all-equal) axis is centred rather than dividing by zero.
 * Exported for tests.
 */
export function projectFrontier(
  points: readonly FrontierPoint[],
  dims: { width?: number; height?: number } = {},
): { points: PlottedPoint[]; frontierPath: string } {
  const W = dims.width ?? DEFAULT_W;
  const H = dims.height ?? DEFAULT_H;
  if (points.length === 0) return { points: [], frontierPath: '' };

  const costs = points.map((p) => p.cost);
  const scores = points.map((p) => p.score);
  let xlo = Math.min(...costs);
  let xhi = Math.max(...costs);
  let ylo = Math.min(...scores);
  let yhi = Math.max(...scores);
  // Pad ~8% of span (or a unit when degenerate) so points don't sit on the axes.
  const xpad = (xhi - xlo) * 0.08 || Math.max(Math.abs(xhi) * 0.1, 1);
  const ypad = (yhi - ylo) * 0.08 || Math.max(Math.abs(yhi) * 0.1, 1);
  xlo -= xpad; xhi += xpad;
  ylo = Math.max(0, ylo - ypad); yhi += ypad; // scores are non-negative; never a unit ceiling
  const xspan = xhi - xlo || 1;
  const yspan = yhi - ylo || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const optimal = new Set(paretoOptimalIds(points));

  const plotted: PlottedPoint[] = points.map((p) => ({
    ...p,
    x: PAD.left + ((p.cost - xlo) / xspan) * plotW,
    y: PAD.top + (1 - (p.score - ylo) / yspan) * plotH,
    onFrontier: optimal.has(p.id),
  }));

  // Frontier line: the optimal points, left→right by cost (ties: higher score first).
  const frontier = plotted
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.cost - b.cost || b.score - a.score);
  const frontierPath = frontier.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return { points: plotted, frontierPath };
}

export function ParetoFrontier({
  points,
  xLabel = 'cost ($)',
  yLabel = 'resolved',
  formatX = fmt2,
  formatY = fmt2,
  highlightId,
  width = DEFAULT_W,
  height = DEFAULT_H,
  caption,
  emptyHint = 'No runs to compare yet.',
}: ParetoFrontierProps) {
  const { points: plotted, frontierPath } = useMemo(
    () => projectFrontier(points, { width, height }),
    [points, width, height],
  );

  if (plotted.length === 0) {
    return (
      <figure className="pc-frontier pc-frontier--empty" aria-label={emptyHint}>
        {caption && <figcaption className="pc-frontier__caption">{caption}</figcaption>}
        <div className="pc-frontier__empty" data-testid="frontier-empty">{emptyHint}</div>
        <FrontierStyles />
      </figure>
    );
  }

  const costs = points.map((p) => p.cost);
  const scores = points.map((p) => p.score);
  const xExtent = `${formatX(Math.min(...costs))}–${formatX(Math.max(...costs))}`;
  const yExtent = `${formatY(Math.min(...scores))}–${formatY(Math.max(...scores))}`;
  const nOptimal = plotted.filter((p) => p.onFrontier).length;

  return (
    <figure
      className="pc-frontier"
      aria-label={`Cost/accuracy Pareto scatter of ${plotted.length} arms (${xLabel} ${xExtent}, ${yLabel} ${yExtent}); ${nOptimal} on the frontier`}
    >
      {caption && <figcaption className="pc-frontier__caption">{caption}</figcaption>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
        {/* axes */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={height - PAD.bottom} className="pc-frontier__axisline" />
        <line x1={PAD.left} x2={width - PAD.right} y1={height - PAD.bottom} y2={height - PAD.bottom} className="pc-frontier__axisline" />
        <text x={PAD.left} y={height - PAD.bottom + 22} textAnchor="start" className="pc-frontier__axis">{formatX(Math.min(...costs))}</text>
        <text x={width - PAD.right} y={height - PAD.bottom + 22} textAnchor="end" className="pc-frontier__axis">{formatX(Math.max(...costs))}</text>
        <text x={(PAD.left + width - PAD.right) / 2} y={height - 6} textAnchor="middle" className="pc-frontier__axislabel">{xLabel} →</text>
        <text x={PAD.left - 8} y={PAD.top + 4} textAnchor="end" className="pc-frontier__axis">{formatY(Math.max(...scores))}</text>
        <text x={PAD.left - 8} y={height - PAD.bottom} textAnchor="end" className="pc-frontier__axis">{formatY(Math.min(...scores))}</text>
        <text transform={`translate(14 ${(PAD.top + height - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" className="pc-frontier__axislabel">↑ {yLabel}</text>

        {/* the frontier line (upper-left envelope) */}
        {frontierPath.includes(' ') && (
          <polyline className="pc-frontier__line" points={frontierPath} fill="none" />
        )}

        {/* points: dominated dim, Pareto-optimal accented, highlight ringed */}
        {plotted.map((p) => (
          <g key={p.id} data-testid="frontier-point" data-arm={p.id} data-frontier={p.onFrontier ? '1' : '0'}>
            {highlightId === p.id && <circle cx={p.x} cy={p.y} r={9} className="pc-frontier__ring" fill="none" />}
            <circle
              cx={p.x}
              cy={p.y}
              r={p.onFrontier ? 5.5 : 4}
              className={p.onFrontier ? 'pc-frontier__dot pc-frontier__dot--opt' : 'pc-frontier__dot'}
            >
              <title>{`${p.label} · ${xLabel} ${formatX(p.cost)} · ${yLabel} ${formatY(p.score)}${p.onFrontier ? ' · Pareto-optimal' : ''}`}</title>
            </circle>
            <text x={p.x + 8} y={p.y + 3.5} className={p.onFrontier ? 'pc-frontier__plabel pc-frontier__plabel--opt' : 'pc-frontier__plabel'}>{p.label}</text>
          </g>
        ))}
      </svg>
      <FrontierStyles />
    </figure>
  );
}

function FrontierStyles() {
  return (
    <style>{`
      .pc-frontier { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
      .pc-frontier__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier svg { display: block; width: 100%; height: auto; }
      .pc-frontier__empty { padding: 28px 8px; text-align: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__axisline { stroke: var(--border-strong, rgba(125, 211, 252, 0.3)); stroke-width: 1; }
      .pc-frontier__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-frontier__axislabel { fill: var(--fg-mute, #7f9bb4); font-size: 10px; font-weight: 600; }
      .pc-frontier__line { stroke: var(--accent, #38bdf8); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 5 4; opacity: 0.85; }
      .pc-frontier__dot { fill: var(--fg-mute, #7f9bb4); stroke: var(--bg-1, rgba(6, 18, 26, 0.9)); stroke-width: 1.5; opacity: 0.65; }
      .pc-frontier__dot--opt { fill: var(--accent, #38bdf8); opacity: 1; }
      .pc-frontier__ring { stroke: var(--good, #34d399); stroke-width: 2; }
      .pc-frontier__plabel { fill: var(--fg-dim, #b9d4e8); font-size: 10px; }
      .pc-frontier__plabel--opt { fill: var(--fg, #e7f7ff); font-weight: 600; }
    `}</style>
  );
}
