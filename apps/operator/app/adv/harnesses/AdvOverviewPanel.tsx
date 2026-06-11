'use client';

// adv:overview — mission-control summary for a harness. Ports the legacy
// RealHarnessOverviewPanel: phase tabs (staging/testing/production),
// alive/escalated/smoke badges, project path, progress bar, status-bucket
// counts, iteration + last-decision + mission cost. Phase lives in the
// panel's params (so two overview panels can show different phases side by
// side) and persists via /harness-phase-last-used. One-shot read + manual
// Refresh — the legacy 5s interval is dropped per the /adv no-polling ethos.

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Tooltip } from '../../harness/Tooltip';
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

// Per-status accent — token-first with hex fallbacks (see AdvAgentsPanel).
const STATUS_ACCENT: Record<string, string> = {
  passed: 'var(--good, #4ade80)',
  todo: 'var(--fg-mute)',
  in_progress: 'var(--accent-strong, #7dd3fc)',
  validating: 'var(--warn, #fbbf24)',
  failing: 'var(--bad, #f87171)',
  blocked: 'var(--bad, #f87171)',
  deprecated: 'color-mix(in oklab, var(--fg-mute), transparent 25%)',
};

export default function AdvOverviewPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const phase = ((params.phase as Phase) ?? 'staging') as Phase;
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [phaseHydrated, setPhaseHydrated] = useState(false);

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

  // Status fetch (re-fires on slug/phase change + refresh()).
  useEffect(() => {
    if (!slug) return;
    let cancel = false;
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=${encodeURIComponent(phase)}`)
      .then((r) => (r.ok ? (r.json() as Promise<StatusResponse>) : Promise.reject(new Error(`status ${r.status}`))))
      .then((j) => {
        if (cancel) return;
        setData(j);
        api.setTitle(`Overview: ${slug} (${phase})`);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug, phase, tick, api]);

  const stats = useMemo(() => {
    if (!data?.counts) return null;
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    const passed = data.counts.passed ?? 0;
    return { total, passed, pct: total > 0 ? Math.round((passed / total) * 100) : 0 };
  }, [data]);

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

  if (!slug) return <div className="pc-adv-ov__empty">No harness slug in params.</div>;

  return (
    <div className="pc-adv-ov">
      {error ? (
        <div className="pc-adv-ov__empty pc-adv-ov__empty--err">Failed: {error}</div>
      ) : !data ? (
        <div className="pc-adv-ov__empty">Loading {slug}…</div>
      ) : (
        <>
          <div className="pc-adv-ov__head">
            <span className="pc-adv-ov__slug">{data.project.slug}</span>
            <span className={`pc-adv-ov__dot${data.alive ? ' is-alive' : ''}`} aria-hidden />
            <span className="pc-adv-ov__alive">{data.alive ? 'alive' : 'idle'}</span>
            {data.escalated ? <span className="pc-adv-ov__badge">ESCALATED</span> : null}
            {data.smokeFail ? <span className="pc-adv-ov__badge">SMOKE-FAIL</span> : null}
            <Tooltip label="Refresh status">
              <button
                type="button"
                className="pc-adv-ov__refresh"
                onClick={() => setTick((t) => t + 1)}
                aria-label="Refresh status"
              >
                <RefreshCw size={12} aria-hidden />
              </button>
            </Tooltip>
          </div>

          <div className="pc-adv-ov__path" title={data.project.path}>
            {data.project.path}
          </div>

          <div className="pc-adv-ov__phases" role="tablist" aria-label="Phase">
            {PHASES.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === phase}
                className="pc-adv-ov__phase"
                onClick={() => switchPhase(p)}
              >
                {p}
              </button>
            ))}
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
                <span
                  className="pc-adv-ov__count-dot"
                  style={{ background: STATUS_ACCENT[k] ?? 'var(--fg-mute)' }}
                  aria-hidden
                />
                <span className="pc-adv-ov__count-label">{k}</span>
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
        </>
      )}

      <style>{`
        .pc-adv-ov {
          display: flex; flex-direction: column; gap: 12px;
          height: 100%; min-height: 0; overflow: auto;
          padding: 12px; font-size: 12px; color: var(--fg);
        }
        .pc-adv-ov__head { display: flex; align-items: center; gap: 8px; }
        .pc-adv-ov__slug { font-weight: 600; font-size: 13px; }
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
          padding: 1px 6px; font-size: 10px; font-weight: 600; border-radius: 3px;
          color: color-mix(in oklab, var(--warn, #fbbf24), white 55%);
          background: color-mix(in oklab, var(--warn, #fbbf24), black 55%);
        }
        .pc-adv-ov__refresh {
          margin-left: auto; display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-ov__refresh:hover { color: var(--fg); background: color-mix(in oklab, var(--fg), transparent 90%); }
        .pc-adv-ov__path {
          color: var(--fg-mute); font-size: 11px; font-family: ui-monospace, monospace;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-adv-ov__phases {
          display: flex; gap: 2px;
          border-bottom: 1px solid color-mix(in oklab, var(--border), transparent 25%);
        }
        .pc-adv-ov__phase {
          padding: 4px 12px; font-size: 11px; background: transparent;
          color: var(--fg-mute); border: 0; border-bottom: 2px solid transparent;
          cursor: pointer; margin-bottom: -1px; text-transform: capitalize;
        }
        .pc-adv-ov__phase[aria-selected="true"] {
          color: var(--fg); border-bottom-color: var(--accent, #38bdf8);
        }
        .pc-adv-ov__progress-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 11px; }
        .pc-adv-ov__muted { color: var(--fg-mute); }
        .pc-adv-ov__bar {
          height: 4px; border-radius: 2px; overflow: hidden;
          background: color-mix(in oklab, var(--border), transparent 25%);
        }
        .pc-adv-ov__bar-fill { height: 100%; width: 100%; background: var(--good, #4ade80); transform-origin: left; transition: transform 0.3s; }
        .pc-adv-ov__counts { display: flex; flex-direction: column; gap: 4px; }
        .pc-adv-ov__count { display: flex; align-items: baseline; gap: 8px; font-size: 11px; }
        .pc-adv-ov__count-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; align-self: center; }
        .pc-adv-ov__count-label { flex: 1; color: var(--fg-mute); text-transform: capitalize; }
        .pc-adv-ov__count-num { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        .pc-adv-ov__misc {
          font-size: 11px; color: var(--fg-mute); padding-top: 8px; display: flex; flex-direction: column; gap: 2px;
          border-top: 1px solid color-mix(in oklab, var(--border), transparent 45%);
        }
        .pc-adv-ov__last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-adv-ov__empty { padding: 16px; font-size: 13px; color: var(--fg-mute); }
        .pc-adv-ov__empty--err { color: var(--bad, #f87171); }
      `}</style>
    </div>
  );
}
