/**
 * BenchmarkTrend — the Benchmark panel's generation trend line
 * (self-improvement-consume-edges-2026-06-12 P-033 / B-12).
 *
 * One dependency-free SVG polyline of the mean judge composite per benchmark
 * generation (beekeeper instance), oldest → newest, fed by the same
 * `learning.apiary` snapshot the Benchmark view already holds — the at-a-glance
 * answer to "is the system actually getting better" that the per-row Δs can't
 * give. Generations are ordinal on the x-axis (one point per measured code
 * SHA — the monthly cadence routine adds one per new generation); unscored
 * generations (e.g. dry-runs) are skipped rather than breaking the line.
 *
 * Renders nothing until two scored generations exist — a single point is not a
 * trend, and the empty/loading states stay owned by the parent view. Styles are
 * self-carried (pc-benchtrend__*), mirroring LearningTab's inline-style idiom,
 * so the hotspot file's wiring stays at two lines.
 */
import { useMemo } from "react";

export interface BenchmarkTrendInstance {
  instanceId: string;
  codeSha: string;
  createdAt: string;
  totalRuns: number;
  successfulRuns: number;
  meanComposite: number | null;
}

// A wide canvas keeps this evidence strip compact in the desktop's broad
// workspace instead of letting the responsive SVG grow into a second hero.
const W = 1000;
const H = 132;
const PAD = { top: 12, right: 14, bottom: 26, left: 40 };

const shortSha = (s: string): string => (s ? s.slice(0, 7) : "—");
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface TrendPoint {
  x: number;
  y: number;
  composite: number;
  inst: BenchmarkTrendInstance;
}

/** Scored generations oldest→newest, projected into the plot box. Exported for tests. */
export function computeTrendPoints(
  instances: BenchmarkTrendInstance[],
): TrendPoint[] {
  // The apiary read is newest-first; the trend reads left→right in time.
  const scored = [...instances]
    .reverse()
    .filter(
      (i): i is BenchmarkTrendInstance & { meanComposite: number } =>
        i.meanComposite != null,
    );
  if (scored.length < 2) return [];
  const lo0 = Math.min(...scored.map((i) => i.meanComposite));
  const hi0 = Math.max(...scored.map((i) => i.meanComposite));
  // Pad the domain so a flat-ish trend doesn't fill the box with noise. Scale-free on
  // purpose: the LIVE judge composite is 0..10 (gym rubric), while older fixtures used
  // 0..1 — only the floor is clamped (scores are non-negative), never a unit ceiling.
  const pad = Math.max(0.05, (hi0 - lo0) * 0.25);
  const lo = Math.max(0, lo0 - pad);
  const hi = hi0 + pad;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  return scored.map((inst, i) => ({
    x:
      PAD.left +
      (scored.length === 1 ? plotW / 2 : (i / (scored.length - 1)) * plotW),
    y: PAD.top + (1 - (inst.meanComposite - lo) / (hi - lo)) * plotH,
    composite: inst.meanComposite,
    inst,
  }));
}

export function BenchmarkTrend({
  instances,
}: {
  instances: BenchmarkTrendInstance[];
}) {
  const points = useMemo(() => computeTrendPoints(instances), [instances]);
  if (points.length < 2) return null;

  const composites = points.map((p) => p.composite);
  const lo = Math.min(...composites);
  const hi = Math.max(...composites);
  const first = points[0];
  const last = points[points.length - 1];
  const showAllShas = points.length <= 6;
  const labelled = showAllShas ? points : [first, last];

  return (
    <figure
      className="pc-benchtrend"
      aria-label={`Benchmark composite trend across ${points.length} generations, from ${first.composite.toFixed(3)} (${dateLabel(first.inst.createdAt)}) to ${last.composite.toFixed(3)} (${dateLabel(last.inst.createdAt)})`}
    >
      <figcaption className="pc-benchtrend__caption">
        Composite per generation <em>oldest → newest</em>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* y reference lines at the scored min/max */}
        {[hi, lo].map((v) => {
          const y = points[composites.indexOf(v)].y;
          return (
            <g key={`ref-${v}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                className="pc-benchtrend__grid"
              />
              <text
                x={PAD.left - 6}
                y={y + 3.5}
                textAnchor="end"
                className="pc-benchtrend__axis"
              >
                {v.toFixed(3)}
              </text>
            </g>
          );
        })}
        <polyline
          className="pc-benchtrend__line"
          points={points
            .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(" ")}
          fill="none"
        />
        {points.map((p) => (
          <circle
            key={p.inst.instanceId}
            cx={p.x}
            cy={p.y}
            r={3.5}
            className="pc-benchtrend__dot"
          >
            <title>
              {`${shortSha(p.inst.codeSha)} · ${dateLabel(p.inst.createdAt)} · composite ${p.composite.toFixed(3)} · ${p.inst.successfulRuns}/${p.inst.totalRuns} solved`}
            </title>
          </circle>
        ))}
        {labelled.map((p) => (
          <text
            key={`sha-${p.inst.instanceId}`}
            x={p.x}
            y={H - 8}
            textAnchor="middle"
            className="pc-benchtrend__axis"
          >
            {shortSha(p.inst.codeSha)}
          </text>
        ))}
      </svg>
      <style>{`
        .pc-benchtrend { margin: 0 0 4px; padding: 10px 12px 6px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-benchtrend__caption { margin: 0 0 4px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
        .pc-benchtrend__caption em { font-style: normal; font-weight: 500; opacity: 0.8; }
        .pc-benchtrend svg { display: block; width: 100%; height: auto; }
        .pc-benchtrend__grid { stroke: rgba(255, 255, 255, 0.08); stroke-width: 1; stroke-dasharray: 3 4; }
        .pc-benchtrend__axis { fill: var(--fg-mute, #7f9bb4); font-size: 9.5px; font-variant-numeric: tabular-nums; }
        .pc-benchtrend__line { stroke: #34d399; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
        .pc-benchtrend__dot { fill: #34d399; stroke: rgba(6, 18, 26, 0.9); stroke-width: 1.5; }
      `}</style>
    </figure>
  );
}
