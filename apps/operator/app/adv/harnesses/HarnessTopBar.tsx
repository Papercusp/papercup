'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Coins, Network } from 'lucide-react';
import { AddPanelCatalog } from '../../harness/dock/AddPanelCatalog';
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
}

/**
 * /adv/harnesses top bar — pulse, lanes, passed/total, $ spent, health,
 * plus the working-directory path + progress chips on the left.
 *
 * The harness selector + Start/Stop + running-agents-thinking pills now
 * live in the AdvShell header (one global instance shared across every
 * /adv tab), so they are intentionally absent here.
 */
export default function HarnessTopBar({ slug, projects }: Props) {
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

  return (
    <div className="pc-adv-topbar">
      <div className="pc-adv-topbar__left">
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
          </>
        )}
        {!status && slug && <span className="pc-adv-topbar__loading">loading…</span>}
        {slug && <RegisterSubsButton slug={slug} />}
        {slug && (
          <AddPanelCatalog
            defaultSlug={slug}
            allowedTypes={['adv:features', 'adv:issues', 'adv:detail']}
            className="pc-adv-topbar__add-panel"
          />
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
          min-height: 48px;
        }
        .pc-adv-topbar__left {
          display: flex;
          align-items: center;
          gap: 16px;
          min-width: 0;
          flex: 1;
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
        .pc-adv-topbar__loading {
          color: rgba(220, 214, 248, 0.5);
          font-size: 12px;
          font-style: italic;
        }
        .pc-adv-topbar__add-panel {
          background: rgba(167, 139, 250, 0.14);
          color: #c4b5fd;
          border: 1px solid rgba(167, 139, 250, 0.38);
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .pc-adv-topbar__add-panel:hover {
          background: rgba(167, 139, 250, 0.26);
          color: #e7f7ff;
        }
      `}</style>
    </div>
  );
}

/**
 * P-019 — one-click "register sub-harnesses" action. POSTs to
 * `/api/harness/projects/register-subs`, surfaces the discovered +
 * newly-registered count via toast. Idempotent — re-clicking after a
 * `git submodule add` picks up the new one.
 *
 * Lives on the Harness top bar so it's always reachable for the
 * currently selected root harness.
 */
function RegisterSubsButton({ slug }: { slug: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="pc-adv-topbar__register-subs"
      onClick={async () => {
        if (pending) return;
        setPending(true);
        try {
          const r = await fetch('/api/harness/projects/register-subs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootSlug: slug }),
          });
          const data = (await r.json().catch(() => null)) as
            | { ok?: boolean; discovered?: number; registered?: unknown[]; reconciled?: unknown[]; errors?: Array<{ slug: string; error: string }>; error?: string }
            | null;
          if (!r.ok || !data?.ok) {
            toast.error(`register-subs failed: ${data?.error ?? `HTTP ${r.status}`}`);
            return;
          }
          const newCount = (data.registered ?? []).length;
          const fixedCount = (data.reconciled ?? []).length;
          const errCount = (data.errors ?? []).length;
          const msg = `Discovered ${data.discovered ?? 0} submodules — ${newCount} new, ${fixedCount} reconciled${errCount ? `, ${errCount} errors` : ''}.`;
          if (errCount > 0) toast.error(msg);
          else if (newCount + fixedCount === 0) toast.success(`No new sub-harnesses (registry up-to-date).`, { duration: 2500 });
          else toast.success(msg, { duration: 3000 });
        } catch (e) {
          toast.error(`register-subs failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setPending(false);
        }
      }}
      title="Scan this harness for git submodules and register them as sub-harnesses"
      disabled={pending}
    >
      <Network size={13} aria-hidden />
      {pending ? 'Scanning…' : 'Register sub-harnesses'}
      <style>{`
        .pc-adv-topbar__register-subs {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: #e7f7ff;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
          cursor: pointer;
        }
        .pc-adv-topbar__register-subs:hover:not(:disabled) {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
        }
        .pc-adv-topbar__register-subs:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </button>
  );
}
