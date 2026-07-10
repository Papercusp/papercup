/**
 * MugWakeEfficiencyPanel — the Benchmark view's Mug per-wake efficiency
 * (queen-brief-cache-assembly-2026-06-13 B-06 / P-010, D-016/D-018).
 *
 * Renders the `learning.queenWakeEfficiency` sync query: the live Mug's
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
import { useSyncQuery } from '@papercusp/sync';
import { Crown, RefreshCw } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import type { QueenWakeEfficiency } from '@papercusp/operator-core/lib/hive/queen-wake-efficiency';

/** A [0,1] ratio → integer percent. */
const pct = (r: number): string => `${Math.round((Number.isFinite(r) ? r : 0) * 100)}%`;
/** Compact token count (e.g. 8000 → 8k, 1_250_000 → 1.2M). */
function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function MugWakeEfficiencyPanel() {
  const t = useLexicon();
  const sync = useSyncQuery<QueenWakeEfficiency>({
    queryName: 'learning.queenWakeEfficiency',
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const wakes = snap?.wakes ?? 0;
  const samples = Array.isArray(snap?.samples) ? snap!.samples : [];
  const recent = samples.slice(0, 8);

  return (
    <section className="pc-qeff" aria-label={`${t('brain')} per-wake efficiency`}>
      <div className="pc-qeff__head">
        <h3 className="pc-qeff__title">
          <Crown size={14} aria-hidden /> {t('brain')} efficiency
        </h3>
        <span className="pc-qeff__sub">per-wake prompt cache (Win-1) + round-trips (Win-2) for the live {t('brain')}</span>
        <button
          type="button"
          className="pc-qeff__refresh"
          aria-label={`Reload ${t('brain')} efficiency`}
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>

      {wakes === 0 ? (
        <p className="pc-qeff__empty">
          No {t('brain')} wakes recorded yet. Per-wake cache + turn efficiency appears once the {t('brain')} runs — the brief-cache
          (frozen prefix + precomputed brief) is what these numbers measure.
        </p>
      ) : (
        <>
          <div className="pc-qeff__stats">
            <div className="pc-qeff__stat" title="cache_read ÷ (cache_read + cache_creation + uncached input)">
              <strong>{pct(snap!.cacheHitRatio)}</strong>
              <span>cache hit</span>
            </div>
            <div className="pc-qeff__stat" title="wakes with a non-zero cache read — the 'cache is real' signal (P-003)">
              <strong>
                {snap!.cachedWakes}/{wakes}
              </strong>
              <span>cached wakes</span>
            </div>
            <div className="pc-qeff__stat" title="mean assistant turns over wakes that reported one (Win-2 round-trips)">
              <strong>{snap!.avgTurns == null ? '—' : snap!.avgTurns.toFixed(1)}</strong>
              <span>turns/wake</span>
            </div>
            <div className="pc-qeff__stat" title="provider-reported cost across these wakes">
              <strong>${snap!.totalCostUsd.toFixed(2)}</strong>
              <span>cost</span>
            </div>
          </div>
          <p className="pc-qeff__rollup">
            {wakes} wake{wakes === 1 ? '' : 's'} · {compact(snap!.totalCacheReadTokens)} cache-read /{' '}
            {compact(snap!.totalCacheCreationTokens)} create / {compact(snap!.totalInputTokens)} uncached prompt tokens
            {snap!.turnsReportedWakes > 0 ? ` · ${snap!.turnsReportedWakes} reported turns` : ' · no turn counts yet'}
          </p>
          {recent.length > 0 ? (
            <ul className="pc-qeff__list" aria-label={`recent ${t('brain')} wakes (newest first)`}>
              {recent.map((s, i) => {
                const prompt = s.cacheReadTokens + s.cacheCreationTokens + s.inputTokens;
                const hit = prompt > 0 ? s.cacheReadTokens / prompt : 0;
                return (
                  <li key={s.runId ?? `wake-${i}`} className="pc-qeff__row">
                    <span className="pc-qeff__cache" title="cache-hit ratio this wake">
                      {pct(hit)}
                    </span>
                    <span className="pc-qeff__bar" aria-hidden>
                      <span className="pc-qeff__barfill" style={{ width: `${Math.round(hit * 100)}%` }} />
                    </span>
                    <span className="pc-qeff__turns" title="assistant turns this wake">
                      {s.turns == null ? '—' : `${s.turns}t`}
                    </span>
                    <span className="pc-qeff__tok" title="prompt tokens this wake">
                      {compact(prompt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
      <style>{`
        .pc-qeff { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 12px; background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
        .pc-qeff__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-qeff__title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px; font-weight: 650; }
        .pc-qeff__sub { flex: 1 1 auto; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-qeff__refresh { display: inline-flex; align-items: center; border: none; background: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 2px; }
        .pc-qeff__refresh:disabled { opacity: 0.5; cursor: default; }
        .pc-qeff__empty { margin: 8px 0 2px; font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-qeff__stats { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0 4px; }
        .pc-qeff__stat { display: flex; flex-direction: column; gap: 1px; }
        .pc-qeff__stat strong { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--fg, #dbeafe); }
        .pc-qeff__stat span { font-size: 10px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
        .pc-qeff__rollup { margin: 4px 0; font-size: 11px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
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
