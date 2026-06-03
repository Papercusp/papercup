'use client';

/**
 * AdvCreateDock — the /adv "Create" tab (?tab=plans), rebuilt as a dockview
 * dock with EXTERNAL navigation. Unlike the Git/Harness docks (which expose
 * dockview's own tabs + an Add-Panel catalog), the Create dock is a FIXED
 * two-region split used purely for its resizability:
 *
 *   ┌──────────┬─────────────────────────┐
 *   │ Inbox    │                         │
 *   │ Plans    │  preview / FULL PLAN    │   ← right region; the plan editor
 *   │ Sessions │  (right region)         │     swaps in full-width on demand
 *   │ (left)   │                         │
 *   └──────────┴─────────────────────────┘
 *
 * The top bar's buttons drive the dock — Inbox/Plans/Sessions setActive the
 * matching panel in the LEFT region; "New plan" launches an agent (mirrors
 * PlansClient.onNewPlan). dockview's per-group tab headers are hidden (CSS,
 * adv-dock.css `.pc-adv-create`) since the buttons replace them, and every
 * group is locked so the split can't be drag-rearranged — only sash-resized.
 *
 * Opening a plan (PreviewPanel.openPlanEditor) drops the editor into the
 * RIGHT region; this component widens that region (narrows the left group)
 * while an editor is open and restores on close — the old "plan takes the
 * full width of the right side → 2-pane" behavior.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { ClipboardList, Inbox, Plus, Terminal } from 'lucide-react';
import { wsLocalKey } from '@/lib/browser-workspace';
import { launchAgent } from '@/lib/launch-agent';
import { HarnessDock } from '../../harness/dock/HarnessDock';
import { panelRegistry } from '../../harness/dock/panel-registry';
import { focusPanel, listPanels, onDockApiBind } from '../../harness/dock/dock-actions';
import InboxPanel from './InboxPanel';
import PreviewPanel from './PreviewPanel';
import PlansListPanel from './PlansListPanel';
import SessionsPanel from './SessionsPanel';
import PlanEditorPanel from './PlanEditorPanel';
import '../harnesses/adv-dock.css';

/** localStorage key AdvShell uses for the fallback active-harness slug. */
const ACTIVE_HARNESS_KEY = 'harness.activeProject';
const EDITOR_TYPE = 'create:plan-editor';

/** Seed panel ids for the left region (see defaultAdvCreateLayout). */
const LEFT_INBOX = 'p-create-inbox';
const LEFT_PLANS = 'p-create-plans';
const LEFT_SESSIONS = 'p-create-sessions';

/** Left-region width (px): narrow while a plan is open, comfortable otherwise. */
const LEFT_WIDTH_PLAN_OPEN = 340;
const LEFT_WIDTH_BROWSING = 460;

let registered = false;
export function ensureCreatePanelsRegistered(): void {
  if (registered) return;
  panelRegistry.register('create:inbox', InboxPanel, { title: 'Inbox' });
  panelRegistry.register('create:preview', PreviewPanel, { title: 'Detail' });
  panelRegistry.register('create:plans-list', PlansListPanel, { title: 'Plans' });
  // keepAlive: sessions keeps polling its roster; the editor keeps its
  // unsaved-edit state when its tab is inactive.
  panelRegistry.register('create:sessions', SessionsPanel, { title: 'Sessions', keepAlive: true });
  panelRegistry.register('create:plan-editor', PlanEditorPanel, { title: 'Plan', keepAlive: true });
  registered = true;
}

/** setActive the first panel of `type` (the left-region nav buttons). */
function focusType(type: string): void {
  const p = listPanels().find((x) => x.type === type);
  if (p) focusPanel(p.id);
}

export default function AdvCreateDock() {
  useEffect(() => {
    ensureCreatePanelsRegistered();
  }, []);

  // Which left-region panel is active — drives the button highlight.
  const [activeLeft, setActiveLeft] = useState<string>('create:inbox');

  // ── New-plan launch (mirrors PlansClient.onNewPlan) ──
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [fallbackSlug, setFallbackSlug] = useState<string | null>(null);
  useEffect(() => {
    if (activeHarnessSlug) return;
    if (typeof window === 'undefined') return;
    try {
      setFallbackSlug(window.localStorage.getItem(wsLocalKey(ACTIVE_HARNESS_KEY)));
    } catch {
      /* ignore */
    }
  }, [activeHarnessSlug]);
  const resolvedSlug = activeHarnessSlug ?? fallbackSlug;
  const [launching, setLaunching] = useState(false);
  const onNewPlan = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: resolvedSlug ?? null,
        planSlug: null,
        label: resolvedSlug ? `new-plan · ${resolvedSlug}` : 'new-plan',
        kickoff: { kind: 'new-plan' },
      });
      if (result.ok) {
        toast.success('Agent launched to draft a new plan.', { duration: 3000 });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [launching, resolvedSlug]);

  // ── Dock management: lock the split, track the active left panel, and
  //    widen the right region while a plan editor is open. ──
  useEffect(() => {
    let disposers: Array<{ dispose: () => void }> = [];
    // null until the first observation, so we only resize on a real
    // open↔close TRANSITION (never stomping a persisted/manual width on load).
    let lastHasEditor: boolean | null = null;

    const leftGroup = (dv: DockviewApi) =>
      dv.getPanel(LEFT_INBOX)?.group ??
      dv.getPanel(LEFT_PLANS)?.group ??
      dv.getPanel(LEFT_SESSIONS)?.group ??
      null;

    const unbind = onDockApiBind((dv) => {
      for (const d of disposers) d.dispose();
      disposers = [];
      lastHasEditor = null;
      if (!dv) return;

      const lockAll = () => {
        for (const g of dv.groups) g.locked = true;
      };
      const recomputeActive = () => {
        const activeId = leftGroup(dv)?.activePanel?.id;
        if (activeId === LEFT_INBOX) setActiveLeft('create:inbox');
        else if (activeId === LEFT_PLANS) setActiveLeft('create:plans-list');
        else if (activeId === LEFT_SESSIONS) setActiveLeft('create:sessions');
      };
      const syncWidth = () => {
        const hasEditor = listPanels().some((p) => p.type === EDITOR_TYPE);
        if (lastHasEditor === null) {
          lastHasEditor = hasEditor; // initial observation: respect persisted width
          return;
        }
        if (hasEditor === lastHasEditor) return;
        lastHasEditor = hasEditor;
        const lg = leftGroup(dv);
        if (lg) lg.api.setSize({ width: hasEditor ? LEFT_WIDTH_PLAN_OPEN : LEFT_WIDTH_BROWSING });
      };

      lockAll();
      recomputeActive();
      syncWidth();

      disposers.push(
        dv.onDidAddGroup((g) => {
          g.locked = true;
        }),
        dv.onDidActivePanelChange(() => recomputeActive()),
        dv.onDidAddPanel(() => {
          syncWidth();
          recomputeActive();
        }),
        dv.onDidRemovePanel(() => {
          syncWidth();
          recomputeActive();
        }),
      );
    });

    return () => {
      for (const d of disposers) d.dispose();
      unbind();
    };
  }, []);

  return (
    <div className="pc-adv-create pc-adv-dock">
      <div className="pc-adv-create__bar" role="toolbar" aria-label="Create actions">
        <button
          type="button"
          className="pc-plans__new-plan"
          onClick={onNewPlan}
          disabled={launching}
          title={
            resolvedSlug
              ? `Launch an agent session to draft a new plan in ${resolvedSlug}`
              : 'Launch an agent session to draft a new plan (no active harness — agent will ask)'
          }
        >
          <Plus size={14} aria-hidden />
          {launching ? 'Launching…' : 'New plan'}
        </button>
        <button
          type="button"
          className={`pc-plans__plans-btn${activeLeft === 'create:plans-list' ? ' is-active' : ''}`}
          onClick={() => focusType('create:plans-list')}
          title="Browse plans — open one to view/edit it full-width on the right."
        >
          <ClipboardList size={14} aria-hidden />
          Plans
        </button>
        <button
          type="button"
          className={`pc-plans__inbox-btn${activeLeft === 'create:inbox' ? ' is-active' : ''}`}
          onClick={() => focusType('create:inbox')}
          title="Open the Inbox — every item & attention surface across plans."
        >
          <Inbox size={14} aria-hidden />
          <span className="pc-plans__inbox-btn-label">Inbox</span>
        </button>
        <button
          type="button"
          className={`pc-plans__sessions-btn${activeLeft === 'create:sessions' ? ' is-active' : ''}`}
          onClick={() => focusType('create:sessions')}
          title="Live agent roster — who's active across plans, what they're doing."
        >
          <Terminal size={14} aria-hidden />
          <span className="pc-plans__inbox-btn-label">Sessions</span>
        </button>
      </div>

      <div className="pc-adv-create__dock">
        <HarnessDock layoutName="adv-create" className="dockview-theme-dark" />
      </div>

      <style>{`
        .pc-adv-create {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
        }
        .pc-adv-create__bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          flex-shrink: 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-create__dock {
          flex: 1;
          min-height: 0;
          position: relative;
        }
      `}</style>
    </div>
  );
}
