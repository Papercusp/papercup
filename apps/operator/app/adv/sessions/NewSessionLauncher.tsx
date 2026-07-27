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
import { Combobox, type ComboboxEntry, type ComboboxOption } from '@/app/harness/Combobox';
import { useLexicon } from '@/lib/useLexicon';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
// WI-6300: the canonical model/effort vocabulary psu itself launches with. This
// module is deliberately client-safe (no node/server imports) — see its header —
// so the renderer can read it without dragging the PG/fs subtree into the bundle.
import {
  CLOUD_MODEL_MENU,
  MODEL_EFFORT_LEVELS,
} from '@papercusp/operator-core/lib/agent-config-constants';
import {
  formatAbsoluteUpdated,
  formatRelativeUpdated,
} from '@papercusp/operator-core/lib/format/relative-time';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';

export const PLAN_SELECT_PLACEHOLDER = '__select_plan__';
export const MODEL_SELECT_DEFAULT = '__default_model__';

/**
 * The base-model choices, DERIVED from `CLOUD_MODEL_MENU` — the client-safe twin
 * of psu-launcher's own `RESUME_MODEL_MENU`, held to it by a parity test in
 * apps/operator/lib/psu-launcher.test.ts.
 *
 * WI-6300 (owner ask 2026-07-27: "why is the model list missing so many levels?
 * Don't we have a list somewhere in our repo that launching our psu utility
 * uses?"). We did, and this list was NOT it: it was a hand-maintained rival that
 * had fallen four models behind psu (no fable / sol / terra / luna) while still
 * offering `gpt-5.2`, which is not a recognized alias at all — the OpenAI
 * families are the GPT-5.6 sol/terra/luna trio. Derive; never re-declare. The
 * backend tag rides along as `detail` so it is visible WHICH CLI a pick launches
 * (a codex model starts a codex session, not a claude one).
 */
export const OMP_MODEL_OPTIONS: ComboboxOption[] = [
  { value: MODEL_SELECT_DEFAULT, label: 'Default' },
  ...CLOUD_MODEL_MENU.map((m) => ({
    value: m.value,
    label: m.label,
    detail: m.backend === 'codex' ? 'codex CLI' : 'claude CLI',
  })),
];

export const EFFORT_SELECT_DEFAULT = '__default_effort__';

/** Display label + blurb per effort level. Keyed off MODEL_EFFORT_LEVELS so a
    level added to psu still RENDERS (falling back to the raw token) instead of
    silently vanishing from the menu — the failure mode this whole change fixes.
    Labels keep psu's own token recognizable (`xhigh`, not "Extra high"), because
    the value here is exactly what gets sent as `<model>:<effort>`. */
const EFFORT_LABELS: Record<string, { label: string; detail: string }> = {
  low: { label: 'Low', detail: 'Fastest, cheapest — shallow reasoning' },
  medium: { label: 'Medium', detail: 'Balanced reasoning depth vs cost' },
  high: { label: 'High', detail: 'Deep reasoning' },
  xhigh: { label: 'xHigh', detail: 'Deeper still — slower and pricier' },
  max: { label: 'Max', detail: 'Strongest reasoning available' },
};

/**
 * Effort levels (P-008, owner ask 2026-07-26), DERIVED from `MODEL_EFFORT_LEVELS`.
 * These are the reasoning-depth suffixes appended to the model spec — psu has no
 * `--effort` flag; effort rides the spec as `<modelId>[:<effort>]`, so "sonnet" +
 * "high" is sent as "sonnet:high". Kept as its own control rather than exploding
 * the model list into model×effort combinations.
 *
 * WI-6300 (owner ask 2026-07-27: "Some models support an xhigh settins but the
 * effort is only low medium high"). psu accepts five — low|medium|high|xhigh|max
 * — and this list hardcoded three, so xhigh and max were unreachable from the UI
 * even though the launcher would have honoured them. Now derived + parity-tested.
 */
export const EFFORT_OPTIONS: ComboboxOption[] = [
  { value: EFFORT_SELECT_DEFAULT, label: 'Default effort' },
  ...MODEL_EFFORT_LEVELS.map((level) => ({
    value: level,
    label: EFFORT_LABELS[level]?.label ?? level,
    detail: EFFORT_LABELS[level]?.detail,
  })),
];

/**
 * Compose the `--model` spec from the two controls. Effort is meaningless
 * without an explicit model (the default model's effort is the backend's to
 * choose), so it is dropped rather than sent as a bare ":high".
 *
 * Pure — exported for unit-test access.
 */
export function composeModelSpec(model: string, effort: string): string | null {
  const m = model.trim();
  if (!m) return null;
  const e = effort.trim();
  return e ? `${m}:${e}` : m;
}

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
): ComboboxEntry[] {
  // Kept as a real row rather than folded into the Combobox's `placeholder`
  // prop: since P-005 made the plan optional, "no plan" is a legitimate
  // CHOICE, so the list needs a way to get back to it after one is picked.
  const placeholder: ComboboxOption = {
    value: PLAN_SELECT_PLACEHOLDER,
    label: loading ? 'Loading plans…' : 'Select plan…',
    detail: loading ? undefined : 'Launch with no plan bound',
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

  const groups: ComboboxEntry[] = orderedKeys.map((key) => {
    const label = key === NO_HARNESS_KEY ? noHarnessLabel : key;
    return {
      kind: 'group' as const,
      label,
      options: byHarness.get(key)!.map(
        (plan): ComboboxOption => ({
          value: plan.slug,
          label: plan.title?.trim() || plan.slug,
          detail: formatLaunchPlanOptionDetail(plan),
          // The slug is searchable but not shown — titles are what a human
          // scans, slugs are what they half-remember from a plan doc.
          keywords: [plan.slug, plan.harness ?? ''].filter(Boolean),
        }),
      ),
    };
  });

  return [placeholder, ...groups];
}

/**
 * The row's second line: "updated 26 Jul 2026, 14:03 · yesterday".
 *
 * P-007 (owner ask 2026-07-26: "display the full time details not just
 * 'today'"). The absolute stamp leads because that is the information the
 * owner was missing — `formatRelativeUpdated` collapses everything inside
 * 24h to "today", so a plan touched a minute ago and one touched 23 hours
 * ago were indistinguishable. The relative form is kept alongside it as the
 * at-a-glance cue, not as the only answer.
 *
 * Returns undefined (no second line) when the plan has no `updated` field.
 */
function formatLaunchPlanOptionDetail(plan: PlanListRow): string | undefined {
  if (!plan.updated) return undefined;
  const abs = formatAbsoluteUpdated(plan.updated);
  if (!abs) return undefined;
  const rel = formatRelativeUpdated(plan.updated);
  return rel ? `updated ${abs} · ${rel}` : `updated ${abs}`;
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
  const [effort, setEffort] = useState('');
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
    // P-005 (owner ask 2026-07-26): a plan is OPTIONAL. Launching with none
    // selected starts an unbound session — the plan only ever supplied launch
    // CONTEXT, never a requirement, and `launchAgent` already accepts a null
    // planSlug (it takes a null `slug` on this path too).
    if (launching) return;
    setLaunching(true);
    try {
      // P-008: effort rides on the model spec as "<model>:<effort>".
      const chosenModel = composeModelSpec(model, effort);
      const label = selectedPlan
        ? selectedPlan.title?.trim() || selectedPlan.slug
        : 'su session';
      const result = await launchAgent({
        slug: null,
        planSlug: selectedPlan?.slug ?? null,
        label,
        model: chosenModel,
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
  }, [model, effort, launching, selectedPlan, onLaunched]);

  return (
    <div
      className={`pc-new-session-launcher${className ? ` ${className}` : ''}`}
      aria-label="Launch a new agent session"
    >
      {/* Each box shows its DEFAULT as placeholder text (owner ask
          2026-07-26), which is what `emptyValue` buys: while the value is the
          sentinel, the field renders empty with the prompt showing rather than
          echoing the sentinel row's label back as if it were typed. */}
      <Combobox
        triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--plan"
        value={planSlug ?? PLAN_SELECT_PLACEHOLDER}
        emptyValue={PLAN_SELECT_PLACEHOLDER}
        onChange={(value) => setPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
        disabled={planList.loading}
        ariaLabel="Plan for new session"
        placeholder={planList.loading ? 'Loading plans…' : 'Select plan…'}
        emptyLabel="No plans match"
        options={planOptions}
      />
      {/* Owner ask 2026-07-27 (restated): all four controls — plan, model,
          effort, + New session — belong together on ONE row, and that row is the
          one BELOW the HUD tab strip (see .hud__launchrow in hud.css). An
          earlier pass split them across two lines INSIDE the launcher, which was
          a misreading of "the row below": the row in question was the tab
          strip's, not the plan picker's. Flattened back to a single line. */}
      <>
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--model"
          value={model || MODEL_SELECT_DEFAULT}
          emptyValue={MODEL_SELECT_DEFAULT}
          onChange={(value) => setModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
          ariaLabel="Model for new session"
          placeholder="Default"
          emptyLabel="No models match"
          options={OMP_MODEL_OPTIONS}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--effort"
          value={effort || EFFORT_SELECT_DEFAULT}
          emptyValue={EFFORT_SELECT_DEFAULT}
          onChange={(value) => setEffort(value === EFFORT_SELECT_DEFAULT ? '' : value)}
          ariaLabel="Effort level for new session"
          placeholder="Default effort"
          emptyLabel="No effort levels match"
          options={EFFORT_OPTIONS}
        />
        <Button
          variant="primary"
          size="sm"
          className="pc-new-session-launcher__btn"
          onClick={() => void launch()}
          disabled={launching}
        >
          {launching ? 'Launching…' : '+ New session'}
        </Button>
      </>
    </div>
  );
}
