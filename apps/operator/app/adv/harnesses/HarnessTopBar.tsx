'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Coins, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { StatCard } from '@restart/ui-primitives';
import HealthBadge from '../../harness/HealthBadge';
import type { AdvProjectEntry } from './HarnessesWorkspace';

interface StatusPayload {
  iteration: number;
  alive: boolean;
  counts?: Record<string, number>;
  missionCostUsd?: number;
}

interface LanesPayload {
  lanes: Array<{ featureId: string; elapsedSeconds: number; alive: boolean }>;
  max: number;
}

interface Props {
  slug: string;
  projects: AdvProjectEntry[];
  projectsError: string | null;
  onSlugChange: (next: string) => void;
}

/**
 * /adv/harnesses top bar — pulse, lanes, passed/total, $ spent, health,
 * start/stop. Mirrors the legacy /harness header data shape but built
 * fresh as a single component (legacy version is fused into the 5270-line
 * HarnessDashboard around L4080).
 */
export default function HarnessTopBar({ slug, projects, projectsError, onSlugChange }: Props) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [lanes, setLanes] = useState<LanesPayload | null>(null);

  const activeProject = useMemo(
    () => projects.find((p) => p.slug === slug) ?? null,
    [projects, slug],
  );

  useEffect(() => {
    if (!slug) {
      setStatus(null);
      setLanes(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      Promise.all([
        fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=staging`).then((r) =>
          r.ok ? (r.json() as Promise<StatusPayload>) : null,
        ),
        fetch(`/api/harness/${encodeURIComponent(slug)}/lanes?phase=staging`).then((r) =>
          r.ok ? (r.json() as Promise<LanesPayload>) : null,
        ),
      ]).then(([s, l]) => {
        if (cancelled) return;
        setStatus(s);
        setLanes(l);
      });
    };
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [slug]);

  const passedCount = status?.counts?.passed ?? 0;
  const todoCount = status?.counts?.todo ?? 0;
  const blockedCount = status?.counts?.blocked ?? 0;
  const totalCount = useMemo(
    () => Object.values(status?.counts ?? {}).reduce((acc, n) => acc + (n ?? 0), 0),
    [status?.counts],
  );
  const progressPct = totalCount > 0 ? Math.floor((passedCount / totalCount) * 100) : 0;
  const activeLanes = useMemo(() => (lanes?.lanes ?? []).filter((l) => l.alive), [lanes]);

  const launchHarness = useCallback(async () => {
    if (!slug) return;
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/launch?phase=staging`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = (await res.json()) as { logPath?: string };
      toast.success('Harness launched', { description: d.logPath });
    } catch (e) {
      toast.error('Launch failed', { description: String(e) });
    }
  }, [slug]);

  const stopHarness = useCallback(async () => {
    if (!slug) return;
    if (!window.confirm(`Stop harness ${slug}? In-flight work will be interrupted.`)) return;
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/stop?phase=staging`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = (await res.json()) as { killed?: unknown[] };
      toast.success(`Stopped ${d.killed?.length ?? 0} process(es)`);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [slug]);

  return (
    <div className="pc-adv-topbar">
      <div className="pc-adv-topbar__left">
        <label className="pc-adv-topbar__selector-label">
          <span>Harness</span>
          <select
            className="pc-adv-topbar__selector"
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.length === 0 && (
              <option value="">{projectsError ? '(load failed)' : '(none)'}</option>
            )}
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
                {p.hasState ? '' : ' (no state)'}
              </option>
            ))}
          </select>
        </label>
        <div className="pc-adv-topbar__meta">
          <span className="pc-adv-topbar__path" title={activeProject?.path ?? ''}>
            {activeProject?.path ?? '—'}
          </span>
          {status && totalCount > 0 && (
            <span className="pc-adv-topbar__progress">
              <span>{progressPct}% complete</span>
              <span>
                <strong>{todoCount}</strong> todo
              </span>
              <span>
                <strong>{blockedCount}</strong> blocked
              </span>
              <span>
                <strong>{passedCount}</strong> passed
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="pc-adv-topbar__right">
        {status && (
          <>
            <div title={`Total pulses: ${status.iteration}`}>
              <StatCard label="pulse" value={`#${status.iteration}`} icon={<Activity size={13} />} />
            </div>
            {lanes && (
              <div
                title={
                  activeLanes.length > 0
                    ? `Active lanes:\n${activeLanes
                        .map((l) => `  ${l.featureId} · ${l.elapsedSeconds}s`)
                        .join('\n')}`
                    : 'No active lanes — adjust max in the Settings tab.'
                }
              >
                <StatCard label="Lanes" value={`${activeLanes.length}/${lanes.max}`} />
              </div>
            )}
            <div title={`${passedCount} passed out of ${totalCount} features`}>
              <StatCard
                label="passed"
                value={`${passedCount}/${totalCount}`}
                tone={totalCount > 0 && progressPct === 100 ? 'good' : undefined}
                icon={<CheckCircle2 size={13} />}
              />
            </div>
            {typeof status.missionCostUsd === 'number' && status.missionCostUsd > 0 && (
              <div title="$ spent on this harness">
                <StatCard
                  label="$ spent"
                  value={status.missionCostUsd.toFixed(2)}
                  icon={<Coins size={13} />}
                />
              </div>
            )}
            {slug && <HealthBadge slug={slug} />}
            {status.alive ? (
              <button
                type="button"
                className="pc-adv-topbar__action pc-adv-topbar__action--stop"
                onClick={stopHarness}
                title="Stop harness (SIGTERM)"
              >
                <Square size={12} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="pc-adv-topbar__action pc-adv-topbar__action--start"
                onClick={launchHarness}
                title="Start the harness"
              >
                <Play size={12} />
                Start the harness
              </button>
            )}
          </>
        )}
        {!status && slug && (
          <span className="pc-adv-topbar__loading">loading…</span>
        )}
      </div>

      <style>{`
        .pc-adv-topbar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 10px 18px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.16);
          background: linear-gradient(180deg, rgba(11, 13, 28, 0.92), rgba(8, 11, 24, 0.92));
          min-height: 56px;
        }
        .pc-adv-topbar__left {
          display: flex;
          align-items: center;
          gap: 16px;
          min-width: 0;
          flex: 1;
        }
        .pc-adv-topbar__selector-label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 10px;
          letter-spacing: 0.11em;
          text-transform: uppercase;
          font-weight: 760;
          color: rgba(199, 188, 252, 0.66);
        }
        .pc-adv-topbar__selector {
          padding: 6px 8px;
          font-size: 13px;
          font-weight: 650;
          background: rgba(20, 18, 38, 0.96);
          color: #f7f5ff;
          border: 1px solid rgba(167, 139, 250, 0.32);
          border-radius: 6px;
          min-width: 180px;
        }
        .pc-adv-topbar__meta {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          flex: 1;
        }
        .pc-adv-topbar__path {
          font-size: 12px;
          color: rgba(220, 214, 248, 0.66);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pc-adv-topbar__progress {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: rgba(220, 214, 248, 0.74);
        }
        .pc-adv-topbar__progress strong {
          color: #f7f5ff;
          font-weight: 700;
        }
        .pc-adv-topbar__right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .pc-adv-topbar__action {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 700;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          letter-spacing: 0.02em;
        }
        .pc-adv-topbar__action--start {
          background: rgba(34, 197, 94, 0.16);
          color: #86efac;
          border-color: rgba(34, 197, 94, 0.38);
        }
        .pc-adv-topbar__action--start:hover {
          background: rgba(34, 197, 94, 0.24);
        }
        .pc-adv-topbar__action--stop {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.34);
        }
        .pc-adv-topbar__action--stop:hover {
          background: rgba(239, 68, 68, 0.2);
        }
        .pc-adv-topbar__loading {
          color: rgba(220, 214, 248, 0.5);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </div>
  );
}
