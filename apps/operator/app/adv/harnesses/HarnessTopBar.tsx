'use client';

import { useState } from 'react';
import { LayoutGrid, Network } from 'lucide-react';
import { FLAGS } from '@papercusp/flags';
import { AddPanelCatalog } from '../../harness/dock/AddPanelCatalog';
import { resetLayout } from '../../harness/dock/dock-actions';
import { Tooltip } from '../../harness/Tooltip';
import { toast } from 'sonner';
import { useFlag } from '../../../lib/flag-hooks';
import { useLexicon } from '../../../lib/useLexicon';
import HarnessWorkspacesButton from './HarnessWorkspacesButton';

interface Props {
  slug: string;
}

/**
 * /adv/harnesses top bar — Hive-level actions: workspaces, register
 * sub-hives, add panel, reset layout.
 *
 * The legacy coding-pipeline stat cards (pulse / lanes / passed/total /
 * $ spent / health) were removed 2026-06-30. They read the superseded
 * per-harness orchestrator-status model (`harnessStatus.snapshot` /
 * `harnessLanes.snapshot`), which the Queen/bee placement model replaced —
 * so they sat frozen/zero. The underlying `harness_status` / `harness_lanes`
 * tables, their sync resolvers, and the `/orchestrator/status` endpoint are
 * KEPT: `harness_lanes` is the live agent-lane occupancy tracker (PID-swept
 * every ~30s) and both `harness_status` / `harness_lanes` are read by the
 * device-harnesses / device-feeds surfaces — so the tables stay.
 *
 * The harness selector + Start/Stop + running-agents-thinking pills now
 * live in the AdvShell header (one global instance shared across every
 * /adv tab), so they are intentionally absent here.
 */
export default function HarnessTopBar({ slug }: Props) {
  const t = useLexicon();
  // WI-259 P-006 — cross-member browse: the "Hive content" rollup panel is
  // registered always but only offered in the Add-panel catalog when the Hive
  // umbrella flag is on (inert outside a hive, so the gate is mostly a courtesy).
  const crossMemberBrowse = useFlag(FLAGS.THE_HIVE);

  return (
    <div className="pc-adv-topbar">
      <div className="pc-adv-topbar__actions">
        {slug && <HarnessWorkspacesButton slug={slug} />}
        {slug && <RegisterSubsButton slug={slug} />}
        {slug && (
          <AddPanelCatalog
            defaultSlug={slug}
            allowedTypes={[
              'adv:work-items',
              'adv:detail',
              'adv:agents',
              'adv:logs',
              'adv:contributors',
              'adv:insights',
              ...(crossMemberBrowse ? ['adv:hive-content'] : []),
              'adv:chat',
            ]}
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
        .pc-adv-topbar__actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .pc-adv-topbar__add-panel {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          color: var(--accent-strong, #7dd3fc);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0;
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
          letter-spacing: 0;
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
