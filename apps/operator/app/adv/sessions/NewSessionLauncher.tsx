'use client';

/**
 * NewSessionLauncher — the "+ New session" launch control, lifted out of
 * AdvSessionsClient.tsx (hud-consolidation-2026-07-26 P-001) so a second
 * surface (the HUD board header) can offer the same "launch from plan
 * context" affordance without hand-rolling a second launcher.
 *
 * AdvSessionsClient.tsx itself is NOT currently mounted by any live route
 * (the Sessions tab was folded into the Create dock under WI-3045, which
 * uses SessionsRosterView instead) — importing FROM it would drag its whole
 * page bundle (Radix Tabs/Collapsible, @tauri-apps/api/core, the full
 * sessions-history UI) into whatever imports this module, i.e. it would not
 * "import cleanly" per the plan's own escape hatch. So the reusable pieces
 * (the plan-option builder + its constants) are LIFTED here instead, and
 * AdvSessionsClient imports them back from this module — one canonical
 * implementation, not two.
 *
 * This component is fully self-contained (own plan list fetch, own
 * plan/model selection state, own launch call via `launchAgent` — the same
 * single launch entry point every backend goes through, per launch-agent.ts).
 * Selection state is local `useState`, not nuqs: it is a mid-edit draft (the
 * in-progress choice before a session is actually created), not a durable or
 * shareable "current view" concept — see the repo's nuqs-vs-useState split.
 */
import { useCallback, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Select, type SelectEntry } from '@/app/harness/Select';
import { useLexicon } from '@/lib/useLexicon';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { formatRelativeUpdated } from '@papercusp/operator-core/lib/format/relative-time';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';

export const PLAN_SELECT_PLACEHOLDER = '__select_plan__';
export const MODEL_SELECT_DEFAULT = '__default_model__';

export const OMP_MODEL_OPTIONS = [
  { value: MODEL_SELECT_DEFAULT, label: 'Default' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
];

/**
 * Build the grouped + sorted option tree for the "Start from plan
 * context" picker. Per `plans-newbutton-and-subharness-scope-2026-05-25`
 * P-026 / D-011.
 *
 * Pure — exported for unit-test access.
 */
export function buildLaunchPlanOptions(
  plans: PlanListRow[],
  activeHarness: string | null | undefined,
  loading: boolean,
  noHarnessLabel = '(unassigned)',
): SelectEntry[] {
  const placeholder = {
    value: PLAN_SELECT_PLACEHOLDER,
    label: loading ? 'Loading plans…' : 'Select plan…',
  };
  if (plans.length === 0) return [placeholder];

  const NO_HARNESS_KEY = '__no-harness__';
  const byHarness = new Map<string, PlanListRow[]>();
  for (const p of plans) {
    const key = p.harness?.trim() || NO_HARNESS_KEY;
    let bucket = byHarness.get(key);
    if (!bucket) {
      bucket = [];
      byHarness.set(key, bucket);
    }
    bucket.push(p);
  }

  // Sort plans within each harness by updated DESC (newest first).
  const updatedMs = (p: PlanListRow): number => {
    if (!p.updated) return 0;
    const t = Date.parse(p.updated);
    return Number.isFinite(t) ? t : 0;
  };
  for (const list of byHarness.values()) {
    list.sort((a, b) => updatedMs(b) - updatedMs(a));
  }

  const allKeys = [...byHarness.keys()];
  const active = activeHarness?.trim() || null;
  const activeFirst = active && byHarness.has(active) ? [active] : [];
  const restKeys = allKeys
    .filter((k) => k !== active && k !== NO_HARNESS_KEY)
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys = [
    ...activeFirst,
    ...restKeys,
    ...(byHarness.has(NO_HARNESS_KEY) ? [NO_HARNESS_KEY] : []),
  ];

  const groups: SelectEntry[] = orderedKeys.map((key) => {
    const label = key === NO_HARNESS_KEY ? noHarnessLabel : key;
    return {
      kind: 'group' as const,
      label,
      options: byHarness.get(key)!.map((plan) => ({
        value: plan.slug,
        label: formatLaunchPlanOptionLabel(plan),
      })),
    };
  });

  return [placeholder, ...groups];
}

/** "<title> · updated 5d ago" or just "<title>" when no updated field. */
function formatLaunchPlanOptionLabel(plan: PlanListRow): string {
  const title = plan.title?.trim() || plan.slug;
  if (!plan.updated) return title;
  const rel = formatRelativeUpdated(plan.updated);
  return rel ? `${title} · updated ${rel}` : title;
}

export interface NewSessionLauncherProps {
  className?: string;
  /** Called after a successful launch — callers whose session list isn't
   *  already sync-driven (e.g. AdvSessionsClient's polled list) can use this
   *  to force a refresh. The HUD board needs no such hook: its roster read
   *  (`advRoster.list`) is SSE-invalidated on any `adv_sessions` write, so
   *  the new session appears on its own. */
  onLaunched?: () => void;
}

/**
 * The "+ New session" control: a plan picker, a model picker, and a button —
 * reusing the exact `launchAgent` call AdvSessionsClient's own "Create new
 * session" button makes. Self-contained so it can be dropped into any header
 * (HUD board, Sessions panel, …) with no props beyond an optional
 * post-launch hook.
 */
export default function NewSessionLauncher({ className, onLaunched }: NewSessionLauncherProps) {
  const t = useLexicon();
  // The AdvShell-active harness slug — read directly rather than threaded as
  // a prop so this stays a drop-in control. Shared with AdvSessionsClient's
  // own picker via the same `slug` nuqs key (that param is global, not
  // owned by any one tab).
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [planSlug, setPlanSlug] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [launching, setLaunching] = useState(false);

  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const selectedPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === planSlug) ?? null,
    [planSlug, planList.data],
  );
  const planOptions = useMemo(
    () =>
      buildLaunchPlanOptions(
        planList.data?.plans ?? [],
        activeHarnessSlug,
        planList.loading,
        `(no ${t('pot', { lower: true })})`,
      ),
    [planList.data, planList.loading, activeHarnessSlug, t],
  );

  const launch = useCallback(async () => {
    if (!selectedPlan) {
      toast.error('Choose a plan before launching a session.');
      return;
    }
    if (launching) return;
    setLaunching(true);
    try {
      const chosenModel = model.trim();
      const label = selectedPlan.title?.trim() || selectedPlan.slug;
      const result = await launchAgent({
        slug: null,
        planSlug: selectedPlan.slug,
        label,
        model: chosenModel || null,
      });
      if (result.ok && result.warning) {
        // EI-18696184925888288: launch-su's spawn call succeeded but the
        // terminal process exited almost immediately — a likely silent
        // no-op. Say so instead of a flat success toast.
        toast.warning(
          `Agent launch for ${label}${chosenModel ? ` (${chosenModel})` : ''} may not have opened a window.`,
          { description: result.warning, duration: 8000 },
        );
        onLaunched?.();
      } else if (result.ok) {
        toast.success(
          `Agent launched for ${label}${chosenModel ? ` (${chosenModel})` : ''}.`,
          { duration: 3000 },
        );
        onLaunched?.();
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [model, launching, selectedPlan, onLaunched]);

  return (
    <div
      className={`pc-new-session-launcher${className ? ` ${className}` : ''}`}
      aria-label="Launch a new agent session"
    >
      <Select
        triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--plan"
        value={planSlug ?? PLAN_SELECT_PLACEHOLDER}
        onChange={(value) => setPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
        disabled={planList.loading}
        ariaLabel="Plan for new session"
        options={planOptions}
      />
      <Select
        triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--model"
        value={model || MODEL_SELECT_DEFAULT}
        onChange={(value) => setModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
        ariaLabel="Model for new session"
        options={OMP_MODEL_OPTIONS}
      />
      <Button
        variant="primary"
        size="sm"
        className="pc-new-session-launcher__btn"
        onClick={() => void launch()}
        disabled={launching || !selectedPlan}
      >
        {launching ? 'Launching…' : '+ New session'}
      </Button>
    </div>
  );
}
