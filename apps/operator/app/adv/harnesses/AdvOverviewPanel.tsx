'use client';

// adv:overview — mission-control summary for a harness. Ports the legacy
// RealHarnessOverviewPanel: phase tabs (staging/testing/production),
// alive/escalated/smoke badges, project path, progress bar, status-bucket
// counts, iteration + last-decision + mission cost. Phase lives in the
// panel's params (so two overview panels can show different phases side by
// side) and persists via /harness-phase-last-used. Status reads through sync
// with manual invalidate for Refresh — no interval or ad-hoc REST data fetch.

import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { RefreshCw } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { Tooltip } from '../../harness/Tooltip';
import { StatusPill } from '../../harness/primitives';
import type { HarnessStatus } from '../../harness/theme';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

const PHASES = ['staging', 'testing', 'production'] as const;
type Phase = (typeof PHASES)[number];

interface StatusResponse {
  project: { slug: string; path: string };
  counts: Record<string, number>;
  iteration: number;
  lastDecision: string | null;
  alive: boolean;
  escalated: boolean;
  pendingCheckpoints: number;
  activeCompetitions: number;
  smokeFail: boolean;
  missionCostUsd: number;
  missionInputTokens: number;
  missionOutputTokens: number;
}

/**
 * Pure progress derivation for the overview's progress bar: total = sum of all
 * status-bucket counts, passed = the `passed` bucket (0 when absent), pct =
 * passed/total rounded (0 when total is 0). Returns null when there are no
 * counts so callers can skip the bar entirely.
 */
export function computeStats(
  counts: Record<string, number> | undefined | null,
): { total: number; passed: number; pct: number } | null {
  if (!counts) return null;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const passed = counts.passed ?? 0;
  return { total, passed, pct: total > 0 ? Math.round((passed / total) * 100) : 0 };
}

export default function AdvOverviewPanel({ params, api }: PanelComponentProps) {
  const t = useLexicon();
  const workspaceId = useWorkspaceId();
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const phase = ((params.phase as Phase) ?? 'staging') as Phase;
  const [phaseHydrated, setPhaseHydrated] = useState(false);
  const statusQuery = useSyncQuery<StatusResponse>({
    queryName: 'harnessStatus.snapshot',
    args: slug ? { harnessSlug: slug, workspaceId, phase } : undefined,
    enabled: !!slug && !!workspaceId,
  });
  const data = statusQuery.data?.[0] ?? null;
  const error = statusQuery.error ? String(statusQuery.error) : null;

  // First-mount: if no explicit phase was seeded, adopt the user's
  // last-used phase for this slug. One-shot.
  useEffect(() => {
    if (phaseHydrated || !slug) return;
    if ((params as { phase?: unknown }).phase != null) {
      setPhaseHydrated(true);
      return;
    }
    let cancel = false;
    fetch(`/api/harness-phase-last-used/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : { phase: null }))
      .then((j: { phase: string | null }) => {
        if (cancel) return;
        if (j.phase && (PHASES as readonly string[]).includes(j.phase) && j.phase !== phase) {
          api.setParams({ ...params, phase: j.phase as Phase });
        }
        setPhaseHydrated(true);
      })
      .catch(() => {
        if (!cancel) setPhaseHydrated(true);
      });
    return () => {
      cancel = true;
    };
    // One-shot first-mount hydration; phase/params intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (slug) api.setTitle(`Overview: ${slug} (${phase})`);
  }, [slug, phase, api]);

  const stats = useMemo(() => computeStats(data?.counts), [data]);

  const switchPhase = (next: Phase) => {
    if (next === phase) return;
    api.setParams({ ...params, phase: next });
    fetch(`/api/harness-phase-last-used/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: next }),
    }).catch(() => {
      /* best-effort */
    });
  };

  if (!slug) return <div className="pc-advpanel__empty">No {t('pot', { lower: true })} slug in params.</div>;

  return (
    <div className="pc-advpanel pc-adv-ov">
      {error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">Failed: {error}</div>
      ) : !data ? (
        <div className="pc-advpanel__empty">Loading {slug}…</div>
      ) : (
        <>
          <div className="pc-advpanel__bar">
            <span className="pc-adv-ov__slug">{data.project.slug}</span>
            <span className={`pc-adv-ov__dot${data.alive ? ' is-alive' : ''}`} aria-hidden />
            <span className="pc-adv-ov__alive">{data.alive ? 'alive' : 'idle'}</span>
            {data.escalated ? <span className="pc-adv-ov__badge">ESCALATED</span> : null}
            {data.smokeFail ? <span className="pc-adv-ov__badge">SMOKE-FAIL</span> : null}
            <Tooltip label="Refresh status">
              <button
                type="button"
                className="pc-advpanel__iconbtn"
                style={{ marginLeft: 'auto' }}
                onClick={() => statusQuery.invalidate?.()}
                aria-label="Refresh status"
              >
                <RefreshCw size={13} aria-hidden />
              </button>
            </Tooltip>
          </div>

          <div className="pc-advpanel__bar" role="tablist" aria-label="Phase">
            {PHASES.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === phase}
                className="pc-advpanel__chip"
                onClick={() => switchPhase(p)}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="pc-adv-ov__body">
            <div className="pc-adv-ov__path" title={data.project.path}>
              {data.project.path}
            </div>

            {stats ? (
              <div className="pc-adv-ov__progress">
                <div className="pc-adv-ov__progress-head">
                  <span>Progress</span>
                  <span className="pc-adv-ov__muted">
                    {stats.passed} / {stats.total} ({stats.pct}%)
                  </span>
                </div>
                <div className="pc-adv-ov__bar">
                  <div className="pc-adv-ov__bar-fill" style={{ transform: `scaleX(${stats.pct / 100})` }} />
                </div>
              </div>
            ) : null}

            <div className="pc-adv-ov__counts">
              {Object.entries(data.counts).map(([k, v]) => (
                <div key={k} className="pc-adv-ov__count">
                  {/* Canonical status chip (theme.ts STATUS table via StatusPill) —
                      the same pill language the Work-items grid speaks; unknown
                      statuses fall back to the table's neutral meta. */}
                  <StatusPill status={k as HarnessStatus} size="xs" variant="chip" />
                  <span className="pc-adv-ov__count-num">{v}</span>
                </div>
              ))}
            </div>

            <div className="pc-adv-ov__misc">
              <div>iteration: {data.iteration}</div>
              {data.lastDecision ? (
                <div className="pc-adv-ov__last" title={data.lastDecision}>
                  last: {data.lastDecision}
                </div>
              ) : null}
              <div>
                cost: ${data.missionCostUsd.toFixed(2)} · in/out:{' '}
                {Math.round(data.missionInputTokens / 1000)}k/{Math.round(data.missionOutputTokens / 1000)}k
              </div>
              {data.pendingCheckpoints > 0 ? <div>checkpoints pending: {data.pendingCheckpoints}</div> : null}
              {data.activeCompetitions > 0 ? <div>active competitions: {data.activeCompetitions}</div> : null}
            </div>
          </div>
        </>
      )}

      <style>{`
        .pc-adv-ov__body {
          flex: 1; min-height: 0; overflow: auto;
          display: flex; flex-direction: column; gap: 12px;
          padding: 12px; font-size: 12px; color: var(--fg);
        }
        .pc-adv-ov__slug { font-weight: 600; font-size: 13px; color: var(--fg); }
        .pc-adv-ov__dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: color-mix(in oklab, var(--fg-mute), transparent 30%);
        }
        .pc-adv-ov__dot.is-alive {
          background: var(--good, #4ade80);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--good, #4ade80), transparent 78%);
        }
        .pc-adv-ov__alive { color: var(--fg-mute); font-size: 11px; }
        .pc-adv-ov__badge {
          padding: 1px 7px; font-size: 10px; font-weight: 700; border-radius: 999px;
          letter-spacing: 0; white-space: nowrap;
          color: color-mix(in oklab, var(--warn, #fbbf24), white 55%);
          background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        }
        .pc-adv-ov__path {
          color: var(--fg-mute); font-size: 11px; font-family: ui-monospace, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-ov__progress-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
        .pc-adv-ov__muted { color: var(--fg-mute); }
        .pc-adv-ov__bar {
          height: 4px; border-radius: 2px; overflow: hidden;
          background: color-mix(in oklab, var(--border), transparent 25%);
        }
        .pc-adv-ov__bar-fill { height: 100%; width: 100%; background: var(--good, #4ade80); transform-origin: left; transition: transform 0.3s; }
        .pc-adv-ov__counts { display: flex; flex-direction: column; gap: 5px; }
        .pc-adv-ov__count {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          font-size: 11px;
        }
        .pc-adv-ov__count-num { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--fg); }
        .pc-adv-ov__misc {
          font-size: 11px; color: var(--fg-mute); padding-top: 8px; display: flex; flex-direction: column; gap: 2px;
          border-top: 1px solid color-mix(in oklab, var(--border), transparent 45%);
        }
        .pc-adv-ov__last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
    </div>
  );
}
