/**
 * MugWakeEfficiencyPanel — the Benchmark view's Mug per-wake efficiency
 * (queen-brief-cache-assembly-2026-06-13 B-06 / P-010, D-016/D-018).
 *
 * Renders the `learning.mugWakeEfficiency` sync query: the live Mug's
 * per-wake prompt efficiency — the cache-hit ratio (Win-1, the frozen-prefix
 * cache paying off), avg turns/wake (Win-2, the precomputed brief eliminating
 * survey round-trips), the cachedWakes "the cache is real" signal (P-003), and
 * the token/cost totals — plus a compact per-wake recent strip. The same
 * signals the hive-eval efficiency class scores PER eval run (D-016); this is
 * the ad-hoc LIVE-Mug read.
 *
 * Self-contained on purpose (own sync query + pc-qeff__* styles, mirroring
 * EkgPanel/RedQueenPanel) so the LearningTab wiring stays one line. Defensive
 * about the snapshot shape — anything but the expected aggregate renders the
 * no-wakes state, never a crash.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { Coffee, RefreshCw } from "lucide-react";
import { useLexicon } from "@/lib/useLexicon";
import type { MugWakeEfficiency } from "@papercusp/operator-core/lib/pot/mug-wake-efficiency";
import {
  LearningComparisonBars,
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningVisualEmpty,
} from "./LearningVisuals";

/** A [0,1] ratio → integer percent. */
const pct = (r: number): string =>
  `${Math.round((Number.isFinite(r) ? r : 0) * 100)}%`;
/** Compact token count (e.g. 8000 → 8k, 1_250_000 → 1.2M). */
function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function MugWakeEfficiencyPanel({
  onStatus,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
} = {}) {
  const t = useLexicon();
  const sync = useSyncQuery<MugWakeEfficiency>({
    queryName: "learning.mugWakeEfficiency",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const wakes = snap?.wakes ?? 0;
  const samples = Array.isArray(snap?.samples) ? snap!.samples : [];
  const recent = samples.slice(0, 8);
  const visible = recent.slice(0, 4);
  const earlier = recent.slice(4);
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : !snap || wakes === 0
          ? "neutral"
          : snap.cacheHitRatio >= 0.7
            ? "good"
            : "warn",
    );
  }, [onStatus, snap, sync.error, wakes]);

  const renderWake = (s: (typeof recent)[number], i: number) => {
    const prompt = s.cacheReadTokens + s.cacheCreationTokens + s.inputTokens;
    const hit = prompt > 0 ? s.cacheReadTokens / prompt : 0;
    return (
      <li key={s.runId ?? `wake-${i}`} className="pc-qeff__row">
        <span className="pc-qeff__cache" title="cache-hit ratio this wake">
          {pct(hit)}
        </span>
        <span className="pc-qeff__bar" aria-hidden>
          <span
            className="pc-qeff__barfill"
            style={{ width: `${Math.round(hit * 100)}%` }}
          />
        </span>
        <span className="pc-qeff__turns" title="assistant turns this wake">
          {s.turns == null ? "—" : `${s.turns}t`}
        </span>
        <span className="pc-qeff__tok" title="prompt tokens this wake">
          {compact(prompt)}
        </span>
      </li>
    );
  };

  return (
    <section
      className="pc-learning__section pc-qeff"
      aria-label={`${t("brain")} per-wake efficiency`}
    >
      <LearningPageHeader
        icon={Coffee}
        title={`${t("brain")} efficiency`}
        signal={wakes > 0 ? `${wakes} wakes` : undefined}
        tone={snap && snap.cacheHitRatio >= 0.7 ? "good" : "warn"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label={`Reload ${t("brain")} efficiency`}
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        }
      />

      {wakes === 0 ? (
        <LearningVisualEmpty icon={Coffee} title={`No ${t("brain")} wakes`} />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow="Cache hit"
              value={pct(snap!.cacheHitRatio)}
              status={snap!.cacheHitRatio >= 0.7 ? "efficient" : "warming"}
              tone={snap!.cacheHitRatio >= 0.7 ? "good" : "warn"}
            >
              {snap!.cachedWakes}/{wakes} cached wakes
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Prompt composition"
              baselineName="Created / uncached"
              treatmentName="Cache read"
              rows={[
                {
                  label: "Tokens",
                  baseline:
                    snap!.totalCacheCreationTokens + snap!.totalInputTokens,
                  treatment: snap!.totalCacheReadTokens,
                  baselineLabel: compact(
                    snap!.totalCacheCreationTokens + snap!.totalInputTokens,
                  ),
                  treatmentLabel: compact(snap!.totalCacheReadTokens),
                  treatmentWins:
                    snap!.totalCacheReadTokens >=
                    snap!.totalCacheCreationTokens + snap!.totalInputTokens,
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Turns / wake</span>
                  <strong>
                    {snap!.avgTurns == null ? "—" : snap!.avgTurns.toFixed(1)}
                  </strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Cost</span>
                  <strong>${snap!.totalCostUsd.toFixed(2)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Cached</span>
                  <strong>{snap!.cachedWakes}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Reported</span>
                  <strong>{snap!.turnsReportedWakes}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          {recent.length > 0 ? (
            <>
              <div className="pc-learning__sectionhead">
                <h2>Recent wakes</h2>
              </div>
              <ul
                className="pc-qeff__list"
                aria-label={`recent ${t("brain")} wakes (newest first)`}
              >
                {visible.map(renderWake)}
              </ul>
              {earlier.length > 0 ? (
                <LearningDisclosure
                  label="Earlier wakes"
                  count={earlier.length}
                >
                  <ul className="pc-qeff__list">
                    {earlier.map((sample, i) => renderWake(sample, i + 4))}
                  </ul>
                </LearningDisclosure>
              ) : null}
            </>
          ) : null}
        </>
      )}
      <style>{`
        .pc-qeff__list { list-style: none; margin: 4px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-qeff__row { display: flex; align-items: center; gap: 8px; padding: 2px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); font-variant-numeric: tabular-nums; }
        .pc-qeff__cache { flex: none; width: 38px; font-size: 11px; font-weight: 650; color: var(--fg, #dbeafe); text-align: right; }
        .pc-qeff__bar { flex: 1 1 auto; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
        .pc-qeff__barfill { display: block; height: 100%; background: #34d399; border-radius: 3px; }
        .pc-qeff__turns { flex: none; width: 34px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); text-align: right; }
        .pc-qeff__tok { flex: none; width: 46px; font-size: 10.5px; color: var(--fg-dim, #5b7184); text-align: right; }
      `}</style>
    </section>
  );
}

export default MugWakeEfficiencyPanel;
