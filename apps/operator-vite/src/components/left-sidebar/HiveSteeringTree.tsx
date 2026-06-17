/**
 * HiveSteeringTree — the nested hive→plan steering picker
 * (steering-nested-hive-plan-tree-2026-06-17, P-002).
 *
 * The owner's two steering axes — Eligible HIVES (the placement scope) and
 * Eligible PLANS (the plan allow-list) — are actually a TREE: a plan belongs to
 * a hive. The old two FLAT lists let you express a contradiction (an eligible
 * plan under an excluded hive — a dead no-op the survey silently drops). This
 * renders them AS the hierarchy: hives at top, their plans nested beneath, a
 * plan checkable ONLY under a checked hive — so the illegal state can't be typed.
 *
 * Purely presentational: it renders a {@link SteeringTree} (built by
 * buildSteeringTree from the unchanged persisted pair) and reports clicks back as
 * the pure toggle intents. QueenTab owns the (eligibleHives, eligiblePlans) state
 * + the serialized optimistic write. Reuses the parent's `.pc-queen__*` tokens.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { Checkbox } from '@/app/harness/Checkbox';
import type { SteeringTree, TreeHive, TreePlan } from './hive-steering-tree';

export interface HiveSteeringTreeProps {
  tree: SteeringTree;
  /** Count of dead eligible-plan entries detected (their hive is excluded) — surfaced. */
  illegalCount: number;
  busy: boolean;
  loading: boolean;
  onToggleHive: (hiveSlug: string) => void;
  onTogglePlan: (hiveSlug: string, planSlug: string) => void;
  onSetHivePlans: (hiveSlug: string, on: boolean) => void;
  onSetAllHives: (on: boolean) => void;
}

/** A checkbox that renders the tri-state `some` as the native indeterminate dash. */
function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <Checkbox
      className="pc-queen__check"
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      onChange={onChange}
      ariaLabel={ariaLabel}
    />
  );
}

function PlanRow({ plan, hiveSlug, busy, onTogglePlan }: { plan: TreePlan; hiveSlug: string; busy: boolean; onTogglePlan: HiveSteeringTreeProps['onTogglePlan'] }) {
  return (
    <li className={`pc-queen__plan pc-queen__tree-plan${plan.checked ? ' pc-queen__plan--on' : ''}`}>
      <div className="pc-queen__planlabel">
        <Checkbox
          className="pc-queen__check"
          checked={plan.checked}
          disabled={busy}
          onChange={() => onTogglePlan(hiveSlug, plan.slug)}
          ariaLabel={plan.title}
        />
        <span className="pc-queen__planslug" title={plan.slug}>{plan.title}</span>
      </div>
      <span
        className="pc-queen__planstatus"
        data-status={plan.inActive ? (plan.startStatus === 'started' ? 'started' : plan.status ?? '') : 'stale'}
      >
        {plan.inActive ? (plan.startStatus === 'started' ? 'live' : plan.status ?? '') : 'not active'}
      </span>
    </li>
  );
}

function HiveNode({
  hive,
  expanded,
  busy,
  onToggleExpand,
  onToggleHive,
  onTogglePlan,
  onSetHivePlans,
}: {
  hive: TreeHive;
  expanded: boolean;
  busy: boolean;
  onToggleExpand: () => void;
  onToggleHive: HiveSteeringTreeProps['onToggleHive'];
  onTogglePlan: HiveSteeringTreeProps['onTogglePlan'];
  onSetHivePlans: HiveSteeringTreeProps['onSetHivePlans'];
}) {
  const hasPlans = hive.plans.length > 0;
  const eligibleCount = hive.plans.filter((p) => p.checked).length;
  return (
    <li className={`pc-queen__tree-hive${hive.checked ? ' pc-queen__tree-hive--on' : ''}`}>
      <div className="pc-queen__tree-hiverow">
        <button
          type="button"
          className="pc-queen__tree-caret"
          onClick={onToggleExpand}
          aria-label={expanded ? 'Collapse hive' : 'Expand hive'}
          aria-expanded={expanded}
          disabled={!hasPlans}
        >
          {hasPlans ? (expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />) : <span className="pc-queen__tree-caret-spacer" />}
        </button>
        <div className="pc-queen__planlabel pc-queen__tree-hivelabel">
          <TriCheckbox
            checked={hive.checked}
            indeterminate={hive.planMode === 'some'}
            disabled={busy}
            onChange={() => onToggleHive(hive.slug)}
            ariaLabel={`Toggle hive ${hive.slug}`}
          />
          <span className="pc-queen__tree-hivename" title={hive.slug}>{hive.label.trim()}</span>
        </div>
        <span className="pc-queen__tree-hivemeta">
          {hive.checked
            ? hive.planMode === 'all'
              ? hasPlans ? 'all plans' : 'in scope'
              : `${eligibleCount}/${hive.plans.length}`
            : `${hive.plans.length} plan${hive.plans.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {expanded && hasPlans && (
        <>
          {hive.checked && (
            <div className="pc-queen__tree-hiveactions">
              <button type="button" className="pc-queen__chip" onClick={() => onSetHivePlans(hive.slug, true)} disabled={busy || hive.planMode === 'all'} aria-label={`Make every plan in ${hive.slug} eligible`}>all</button>
              <button type="button" className="pc-queen__chip" onClick={() => onSetHivePlans(hive.slug, false)} disabled={busy} aria-label={`Remove ${hive.slug} from scope`}>none</button>
            </div>
          )}
          <ul className={`pc-queen__plans pc-queen__tree-plans${hive.checked ? '' : ' pc-queen__tree-plans--off'}`}>
            {hive.plans.map((p) => (
              <PlanRow key={p.slug} plan={p} hiveSlug={hive.slug} busy={busy || !hive.checked} onTogglePlan={onTogglePlan} />
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

export default function HiveSteeringTree({
  tree,
  illegalCount,
  busy,
  loading,
  onToggleHive,
  onTogglePlan,
  onSetHivePlans,
  onSetAllHives,
}: HiveSteeringTreeProps) {
  // Per-hive expand/collapse — render-only ephemeral UI (not user-meaningful
  // navigation), so useState. Default: checked hives open, the rest collapsed.
  const defaultExpanded = useMemo(
    () => new Set(tree.hives.filter((h) => h.checked).map((h) => h.slug)),
    [tree.hives],
  );
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (slug: string) => manualExpanded[slug] ?? defaultExpanded.has(slug);
  const toggleExpand = (slug: string) =>
    setManualExpanded((m) => ({ ...m, [slug]: !(m[slug] ?? defaultExpanded.has(slug)) }));

  const anyHiveChecked = tree.hives.some((h) => h.checked);
  const restricted = anyHiveChecked;

  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <ListChecks size={12} aria-hidden />
        <span className="pc-queen__section-title">Steering scope</span>
        <span className="pc-queen__count">{restricted ? `${tree.hives.filter((h) => h.checked).length} hive${tree.hives.filter((h) => h.checked).length === 1 ? '' : 's'}` : 'no restriction'}</span>
        <span className="pc-queen__spacer" />
        <button type="button" className="pc-queen__chip" onClick={() => onSetAllHives(true)} disabled={busy || tree.hives.length === 0} aria-label="Select every hive">all</button>
        <button type="button" className="pc-queen__chip" onClick={() => onSetAllHives(false)} disabled={busy || !restricted} aria-label="Clear the scope">none</button>
      </div>

      <div className={`pc-queen__scope${restricted ? ' pc-queen__scope--restricted' : ''}`}>
        {restricted
          ? 'Queen works ONLY the checked hives — check a hive for all its plans, or expand it to narrow to specific plans. Uncheck all to remove the restriction.'
          : 'Nothing checked → Queen may work ANY hive/plan. Check a hive to scope her; expand it to pick specific plans.'}
      </div>

      {illegalCount > 0 && (
        <div className="pc-queen__tree-illegal" role="alert">
          <AlertTriangle size={12} aria-hidden />
          {illegalCount} eligible plan{illegalCount === 1 ? '' : 's'} {illegalCount === 1 ? 'is' : 'are'} in an excluded hive — ignored by the Queen. Cleared on your next change.
        </div>
      )}

      {loading ? (
        <div className="pc-queen__placeholder">Loading hives + plans…</div>
      ) : tree.hives.length === 0 ? (
        <div className="pc-queen__placeholder">No hives.</div>
      ) : (
        <ul className="pc-queen__plans pc-queen__tree">
          {tree.hives.map((hive) => (
            <HiveNode
              key={hive.slug}
              hive={hive}
              expanded={isExpanded(hive.slug)}
              busy={busy}
              onToggleExpand={() => toggleExpand(hive.slug)}
              onToggleHive={onToggleHive}
              onTogglePlan={onTogglePlan}
              onSetHivePlans={onSetHivePlans}
            />
          ))}
        </ul>
      )}

      {tree.unassigned.length > 0 && (
        <div className="pc-queen__tree-unassigned">
          <div className="pc-queen__tree-unassigned-head">
            <AlertTriangle size={11} aria-hidden />
            <span>No hive — not steerable</span>
            <span className="pc-queen__count">{tree.unassigned.length}</span>
          </div>
          <ul className="pc-queen__plans pc-queen__tree-plans pc-queen__tree-plans--off">
            {tree.unassigned.map((p) => (
              <li key={p.slug} className="pc-queen__plan pc-queen__tree-plan">
                <span className="pc-queen__planslug" title={p.slug}>{p.title}</span>
                <span className="pc-queen__planstatus" data-status="stale">no hive</span>
              </li>
            ))}
          </ul>
          <span className="pc-queen__hint">These plans aren&apos;t under any hive (e.g. created at the workspace scope). Move them into a hive to steer them.</span>
        </div>
      )}

      <TreeStyles />
    </section>
  );
}

function TreeStyles() {
  return (
    <style>{`
      .pc-queen__tree { max-height: 340px; }
      .pc-queen__tree-hive { display: block; padding: 0; border: none; background: none; }
      .pc-queen__tree-hive + .pc-queen__tree-hive { margin-top: 3px; }
      .pc-queen__tree-hiverow {
        display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-queen__tree-hive--on > .pc-queen__tree-hiverow {
        border-color: color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 56%);
        background: color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 92%);
      }
      .pc-queen__tree-caret {
        display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
        padding: 0; border: none; background: none; cursor: pointer; color: var(--fg-mute, #7f9bb4); flex-shrink: 0;
      }
      .pc-queen__tree-caret:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-queen__tree-caret:focus-visible { outline: 1px solid var(--queen-accent, var(--warn, #fbbf24)); outline-offset: 1px; border-radius: 4px; }
      .pc-queen__tree-caret:disabled { cursor: default; opacity: 0.4; }
      .pc-queen__tree-caret-spacer { display: inline-block; width: 13px; }
      .pc-queen__tree-hivelabel { flex: 1; min-width: 0; }
      .pc-queen__tree-hivename {
        font-size: 11.5px; font-weight: 650; color: var(--fg, #e7f7ff);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-queen__tree-hivemeta { flex-shrink: 0; font-size: 9px; color: var(--fg-mute, #7f9bb4); }
      .pc-queen__tree-hiveactions { display: flex; gap: 5px; padding: 4px 7px 2px 28px; }
      .pc-queen__tree-plans { margin: 2px 0 2px 0; padding-left: 21px; max-height: none; gap: 3px; }
      .pc-queen__tree-plans--off { opacity: 0.55; }
      .pc-queen__tree-plan { padding: 4px 7px; }
      .pc-queen__tree-illegal {
        display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 1.3; color: var(--fg, #e7f7ff);
        padding: 5px 8px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 62%);
        background: color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 90%);
      }
      .pc-queen__tree-unassigned {
        display: flex; flex-direction: column; gap: 5px; padding: 7px 8px; border-radius: 8px;
        border: 1px dashed color-mix(in srgb, var(--bad, #f43f5e), transparent 62%);
        background: color-mix(in srgb, var(--bad, #f43f5e), transparent 94%);
      }
      .pc-queen__tree-unassigned-head { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0; color: #fca5a5; }
      .pc-queen__tree-unassigned-head svg { color: #fca5a5; }
      .pc-queen__tree-unassigned .pc-queen__plan { border-color: color-mix(in srgb, var(--bad, #f43f5e), transparent 78%); }
    `}</style>
  );
}
