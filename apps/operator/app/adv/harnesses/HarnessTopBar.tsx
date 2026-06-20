'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Activity, CheckCircle2, Coins, LayoutGrid, Network } from 'lucide-react';
import { AddPanelCatalog } from '../../harness/dock/AddPanelCatalog';
import { resetLayout } from '../../harness/dock/dock-actions';
import { Tooltip } from '../../harness/Tooltip';
import { toast } from 'sonner';
import { StatCard } from '@papercusp/ui-primitives';
import { useLexicon } from '@/lib/useLexicon';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import HealthBadge from '../../harness/HealthBadge';
import HarnessWorkspacesButton from './HarnessWorkspacesButton';

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
}

/**
 * /adv/harnesses top bar — color-accented stat cards (pulse, lanes,
 * passed/total, $ spent, health) on the left, panel/layout actions on
 * the right.
 *
 * The harness selector + Start/Stop + running-agents-thinking pills now
 * live in the AdvShell header (one global instance shared across every
 * /adv tab), so they are intentionally absent here.
 */
export default function HarnessTopBar({ slug }: Props) {
  const t = useLexicon();
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [lanes, setLanes] = useState<LanesPayload | null>(null);

  // Push triggers replacing the legacy 4s poll (audit P-058): the /status +
  // /lanes REST aggregates have no single sync row, so refetch them whenever
  // the consolidated feature feed (counts/progress) or agent-run feed (lane
  // starts/stops, alive) pushes. Server-side dedupe bounds the refetch rate.
  const { data: featureRows } = useSyncQuery<unknown>({
    queryName: 'featuresConsolidated.bySlug',
    args: slug ? { harnessSlug: slug, workspaceId } : undefined,
    enabled: !!slug,
  });
  const { data: runRows } = useSyncQuery<unknown>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });

  useEffect(() => {
    if (!slug) {
      setStatus(null);
      setLanes(null);
      return;
    }
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
    // featureRows/runRows identity changes on each sync push → refetch.
  }, [slug, featureRows, runRows]);

  const passedCount = status?.counts?.passed ?? 0;
  const totalCount = useMemo(
    () => Object.values(status?.counts ?? {}).reduce((acc, n) => acc + (n ?? 0), 0),
    [status?.counts],
  );
  const progressPct = totalCount > 0 ? Math.floor((passedCount / totalCount) * 100) : 0;
  const activeLanes = useMemo(() => (lanes?.lanes ?? []).filter((l) => l.alive), [lanes]);

  return (
    <div className="pc-adv-topbar">
      <div className="pc-adv-topbar__stats">
        {status && (
          <>
            <div className="pc-adv-stat pc-adv-stat--pulse" title={`Total pulses: ${status.iteration}`}>
              <StatCard label="pulse" value={`#${status.iteration}`} icon={<Activity size={13} />} />
            </div>
            {lanes && (
              <div
                className="pc-adv-stat pc-adv-stat--lanes"
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
            <div className="pc-adv-stat pc-adv-stat--passed" title={`${passedCount} passed out of ${totalCount} features`}>
              <StatCard
                label="passed"
                value={`${passedCount}/${totalCount}`}
                tone={totalCount > 0 && progressPct === 100 ? 'good' : undefined}
                icon={<CheckCircle2 size={13} />}
              />
            </div>
            {typeof status.missionCostUsd === 'number' && status.missionCostUsd > 0 && (
              <div className="pc-adv-stat pc-adv-stat--cost" title="$ spent on this harness">
                <StatCard
                  label="$ spent"
                  value={status.missionCostUsd.toFixed(2)}
                  icon={<Coins size={13} />}
                />
              </div>
            )}
            {slug && (
              <div className="pc-adv-stat pc-adv-stat--health">
                <HealthBadge slug={slug} />
              </div>
            )}
          </>
        )}
        {!status && slug && <span className="pc-adv-topbar__loading">loading…</span>}
      </div>

      <div className="pc-adv-topbar__actions">
        {slug && <HarnessWorkspacesButton slug={slug} />}
        {slug && <RegisterSubsButton slug={slug} />}
        {slug && (
          <AddPanelCatalog
            defaultSlug={slug}
            allowedTypes={['adv:work-items', 'adv:detail', 'adv:overview', 'adv:agents', 'adv:logs', 'adv:contributors', 'adv:insights', 'adv:chat']}
            className="pc-adv-topbar__add-panel"
          />
        )}
        {slug && (
          <Tooltip label={`Reset this ${t('pot', { lower: true })}'s panel layout to the default Work items / Detail split`}>
            <button
              type="button"
              className="pc-adv-topbar__reset-layout"
              onClick={() => resetLayout()}
              aria-label="Reset layout"
            >
              <LayoutGrid size={13} aria-hidden /> Reset layout
            </button>
          </Tooltip>
        )}
      </div>

      <style>{`
        .pc-adv-topbar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 10px 18px;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          min-height: 48px;
        }
        .pc-adv-topbar__stats {
          display: flex;
          align-items: stretch;
          gap: 8px;
          min-width: 0;
          flex-wrap: wrap;
        }
        .pc-adv-topbar__actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          margin-left: auto;
        }

        /* Color-accented stat cards. Each card carries its own --stat-accent;
           the shared shell tints the border + background, colors the label and
           icon, and colors the value unless a semantic tone class already owns
           it (passed/health use .good/.warn/.bad). */
        .pc-adv-stat {
          --stat-accent: var(--accent, #38bdf8);
          border: 1px solid color-mix(in oklab, var(--stat-accent), transparent 62%);
          background: color-mix(in oklab, var(--stat-accent), transparent 88%);
          border-radius: 8px;
          display: flex;
          align-items: center;
        }
        .pc-adv-stat .h-stat {
          border-left: none;
          min-width: 52px;
          padding: 4px 12px;
        }
        .pc-adv-stat .h-stat-label {
          color: color-mix(in oklab, var(--stat-accent), var(--fg-dim, #b9d4e8) 45%);
        }
        .pc-adv-stat .h-stat-value svg {
          color: var(--stat-accent);
        }
        .pc-adv-stat .h-stat-value:not(.good):not(.warn):not(.bad):not(.info) {
          color: var(--stat-accent);
        }
        /* Per-stat accents: passed/cost carry real status semantics → the
           --good/--warn tokens; lanes/health are decorative category colors
           (no semantic token exists — same exemption as the tab-strip accents). */
        .pc-adv-stat--pulse  { --stat-accent: var(--accent, #38bdf8); }
        .pc-adv-stat--lanes  { --stat-accent: #a855f7; }
        .pc-adv-stat--passed { --stat-accent: var(--good, #34d399); }
        .pc-adv-stat--cost   { --stat-accent: var(--warn, #fbbf24); }
        .pc-adv-stat--health { --stat-accent: #f472b6; }

        .pc-adv-topbar__loading {
          color: var(--fg-mute, #7f9bb4);
          font-size: 12px;
          font-style: italic;
        }
        .pc-adv-topbar__add-panel {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: var(--accent-strong, #7dd3fc);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .pc-adv-topbar__add-panel:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 72%);
          color: var(--fg, #e7f7ff);
        }
        .pc-adv-topbar__reset-layout {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 600;
          color: var(--fg-dim, #b9d4e8);
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-radius: 999px;
          cursor: pointer;
        }
        .pc-adv-topbar__reset-layout:hover {
          color: var(--fg, #e7f7ff);
          border-color: var(--accent, #38bdf8);
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
  const t = useLexicon();
  const [pending, setPending] = useState(false);
  return (
    <Tooltip label={`Scan this ${t('pot')} for git submodules and register them as sub-${t('pot', { plural: true, lower: true })}`}>
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
            | { ok?: boolean; discovered?: number; membership?: { kind: 'hive_slug' | 'parent_slug'; value: string } | null; registered?: unknown[]; reconciled?: unknown[]; hiveReconciled?: string[]; errors?: Array<{ slug: string; error: string }>; error?: string }
            | null;
          if (!r.ok || !data?.ok) {
            toast.error(`register-subs failed: ${data?.error ?? `HTTP ${r.status}`}`);
            return;
          }
          const newCount = (data.registered ?? []).length;
          const fixedCount = (data.reconciled ?? []).length + (data.hiveReconciled ?? []).length;
          const errCount = (data.errors ?? []).length;
          const hiveNote =
            data.membership?.kind === 'hive_slug' ? ` Members of hive '${data.membership.value}'.` : '';
          const msg = `Discovered ${data.discovered ?? 0} submodules — ${newCount} new, ${fixedCount} reconciled${errCount ? `, ${errCount} errors` : ''}.${hiveNote}`;
          if (errCount > 0) toast.error(msg);
          else if (newCount + fixedCount === 0) toast.success(`No new sub-${t('pot', { plural: true, lower: true })} (registry up-to-date).`, { duration: 2500 });
          else toast.success(msg, { duration: 3000 });
        } catch (e) {
          toast.error(`register-subs failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setPending(false);
        }
      }}
      disabled={pending}
    >
      <Network size={13} aria-hidden />
      {pending ? 'Scanning…' : `Register sub-${t('pot', { plural: true, lower: true })}`}
      <style>{`
        .pc-adv-topbar__register-subs {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: var(--fg, #e7f7ff);
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
    </Tooltip>
  );
}
