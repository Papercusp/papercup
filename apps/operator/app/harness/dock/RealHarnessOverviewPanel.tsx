/**
 * RealHarnessOverviewPanel — absorbs the .h-header block from the classic
 * HarnessDashboard. Phase tabs + alive/idle status + project path +
 * progress percentage + status-bucket counts.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.4
 *
 * Each panel instance carries its own `params.phase` so two overview
 * panels for the same slug but different phases can sit side by side.
 * On phase change, panel writes back via api.setParams AND PUTs
 * /api/harness-phase-last-used/:slug so next reopen defaults to it.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { PanelComponentProps } from './panel-registry';

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

const PHASES = ['staging', 'testing', 'production'] as const;
type Phase = (typeof PHASES)[number];

const STATUS_COLORS: Record<string, string> = {
  passed: 'var(--good)',
  todo: 'var(--fg-mute)',
  failing: 'var(--bad)',
  validating: 'var(--warn)',
  deprecated: '#71717a',
};

export function RealHarnessOverviewPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const phase = ((params.phase as Phase) ?? 'staging') as Phase;
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [phaseHydrated, setPhaseHydrated] = useState(false);

  // On first mount, if the panel doesn't have an explicit phase in
  // params (which means it was seeded with the default 'staging'),
  // fetch the user's last-used phase for this slug and switch to it.
  // One-shot; subsequent renders trust params.phase.
  useEffect(() => {
    if (phaseHydrated || !slug) return;
    // Only auto-hydrate when params.phase wasn't explicitly set.
    // Panels created via openPanel({ params: { phase: 'testing' } })
    // already have their phase — respect that.
    const hadExplicitPhase = (params as { phase?: unknown }).phase != null;
    if (hadExplicitPhase) {
      setPhaseHydrated(true);
      return;
    }
    let cancel = false;
    fetch(`/api/harness-phase-last-used/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : { phase: null }))
      .then((j: { phase: string | null }) => {
        if (cancel) return;
        if (
          j.phase &&
          (PHASES as readonly string[]).includes(j.phase) &&
          j.phase !== phase
        ) {
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
    // We intentionally omit `phase` and `params` from deps — this is a
    // one-shot first-mount hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Push triggers: the REST /status aggregate has no single sync row, so
  // subscribe to the two consolidated feeds whose changes move this panel —
  // features (counts/progress) and agent runs (alive) — and re-pull REST
  // when either pushes. Replaces the legacy 5s fetch poll (audit P-058);
  // SSE invalidations are dedupe-windowed server-side so the refetch rate
  // stays bounded.
  const { data: featureRows } = useSyncQuery<unknown>({
    queryName: 'featuresConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });
  const { data: runRows } = useSyncQuery<unknown>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });

  useEffect(() => {
    if (!slug) return;
    setError(null);
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/status?phase=${encodeURIComponent(phase)}`,
        );
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: StatusResponse = await r.json();
        if (cancel) return;
        setData(j);
        api.setTitle(`Overview: ${slug} (${phase})`);
      } catch (e) {
        if (cancel) return;
        setError(e as Error);
      }
    };
    load();
    return () => {
      cancel = true;
    };
    // featureRows/runRows identity changes on each sync push → refetch.
  }, [slug, phase, api, featureRows, runRows]);

  // Total + done percentage
  const stats = useMemo(() => {
    if (!data?.counts) return null;
    const counts = data.counts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const passed = counts.passed ?? 0;
    const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
    return { total, passed, pct };
  }, [data]);

  const switchPhase = async (next: Phase) => {
    if (next === phase) return;
    api.setParams({ ...params, phase: next });
    // Update last-used so reopens default to this.
    try {
      await fetch(`/api/harness-phase-last-used/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: next }),
      });
    } catch {
      // Best-effort.
    }
  };

  if (!slug)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug.
      </div>
    );
  if (error)
    return <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>Failed: {error.message}</div>;
  if (!data)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Loading…
      </div>
    );

  return (
    <div
      style={{
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: '100%',
        overflow: 'auto',
        fontSize: 12,
        color: 'var(--fg)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Slug + alive */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{data.project.slug}</span>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: data.alive ? 'var(--good)' : '#666',
            display: 'inline-block',
          }}
          title={data.alive ? 'alive' : 'idle'}
        />
        <span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>
          {data.alive ? 'alive' : 'idle'}
        </span>
        {data.escalated && (
          <span
            style={{
              padding: '1px 5px',
              fontSize: 10,
              background: '#7c2d12',
              color: '#fed7aa',
              borderRadius: 2,
            }}
          >
            ESCALATED
          </span>
        )}
        {data.smokeFail && (
          <span
            style={{
              padding: '1px 5px',
              fontSize: 10,
              background: '#7c2d12',
              color: '#fed7aa',
              borderRadius: 2,
            }}
          >
            SMOKE-FAIL
          </span>
        )}
      </div>

      {/* Project path */}
      <div
        style={{
          color: 'var(--fg-mute)',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={data.project.path}
      >
        {data.project.path}
      </div>

      {/* Phase tabs */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border,#333)' }}>
        {PHASES.map((p) => {
          const active = p === phase;
          return (
            <button
              key={p}
              type="button"
              onClick={() => void switchPhase(p)}
              style={{
                padding: '4px 12px',
                fontSize: 11,
                background: 'transparent',
                color: active ? 'var(--fg)' : 'var(--fg-mute)',
                border: 0,
                borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent',
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {p}
            </button>
          );
        })}
      </div>

      {/* Progress */}
      {stats && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 11 }}>Progress</span>
            <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
              {stats.passed} / {stats.total} ({stats.pct}%)
            </span>
          </div>
          <div
            style={{
              height: 4,
              background: 'var(--border,#333)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            {/* scaleX, not width — width transitions force layout+paint per frame (perf rule 4) */}
            <div
              style={{
                height: '100%',
                width: '100%',
                background: 'var(--good)',
                transform: `scaleX(${stats.pct / 100})`,
                transformOrigin: 'left',
                transition: 'transform 0.3s',
              }}
            />
          </div>
        </div>
      )}

      {/* Status counts */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(data.counts).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: STATUS_COLORS[k] ?? '#666',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, color: 'var(--fg-mute)' }}>{k}</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Misc activity */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-mute)',
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div>iteration: {data.iteration}</div>
        {data.lastDecision && (
          <div title={data.lastDecision} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            last: {data.lastDecision}
          </div>
        )}
        <div>
          cost: ${data.missionCostUsd.toFixed(2)} · in/out:{' '}
          {Math.round(data.missionInputTokens / 1000)}k/{Math.round(data.missionOutputTokens / 1000)}k
        </div>
        {data.pendingCheckpoints > 0 && <div>checkpoints pending: {data.pendingCheckpoints}</div>}
        {data.activeCompetitions > 0 && <div>active competitions: {data.activeCompetitions}</div>}
      </div>
    </div>
  );
}
