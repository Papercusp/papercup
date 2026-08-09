/**
 * GoalTab — the rail's GLANCE at what the fleet is actually pointed at
 * (goal-mode-2026-08-07 P-019, placement D-018).
 *
 * WHY A RAIL TAB AND NOT A /goals ROUTE (D-018): this rail is the declared
 * steering surface and already hosts the supervised-agent tabs (Mug, Overwatch).
 * A goal is the thing those agents are supervised AGAINST, so it belongs beside
 * them rather than behind a top-level route the owner has to remember to visit.
 *
 * ── The ordering rule ──────────────────────────────────────────────────────
 * Sections are ordered by WHAT CAN STOP THE GOAL, not by what reads nicely:
 *   1. the kill criterion + its live tripwire bars — the only thing that ever
 *      ends a goal, so it sits above everything;
 *   2. spend against the ceiling — the second thing that ends one;
 *   3. waiting-on-you — the only thing the OWNER can unblock;
 *   4. projects — context, last.
 * A criterion written as prose is a promise nobody re-checks. Rendered beside
 * live bars it becomes a readout, which is the whole point of the surface.
 *
 * ── D-021 MUST SURVIVE INTO THIS UI ────────────────────────────────────────
 * A project can serve several goals, so a shared project's spend counts IN FULL
 * against each goal and the per-goal figures DELIBERATELY DO NOT SUM. Never
 * total the goal column on screen. Any cross-goal number renders
 * `portfolioSpendUsd`, which the resolver computes over DISTINCT projects — so
 * the `Σ rows ≠ portfolio` gap is visible as shared work rather than as a bug.
 *
 * Spend is labelled "fleet spend", never "total goal cost": it measures the
 * CHILDREN a goal spawns. The goal agent's own interactive turns are
 * subscription-billed and measure ~$0, so the honest name is the narrow one.
 */
import { useMemo } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Target, UserRound } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import type { GoalSummaryRow, GoalTripwire } from '@papercusp/operator-core/lib/sync-resolver/goals';
import { usd } from './SpendTab';

/** The shape `goals.list` returns as its single row. */
export interface GoalsListPayload {
  goals: GoalSummaryRow[];
  /** Computed over DISTINCT projects — the ONLY honest cross-goal total. */
  portfolioSpendUsd: number;
  portfolioProjects: number;
}

/**
 * A tripwire's fill, clamped to [0,1].
 *
 * Clamped rather than left raw because an OVERSHOT tripwire is the case that
 * matters most (day 34 of a 30-day box), and an unclamped bar renders past its
 * track and reads as a layout bug exactly when the owner most needs to believe
 * it. The overshoot is not lost — `tripwireBreached` drives a distinct style
 * and the numeric label always states the real figures.
 */
export function tripwireFill(t: GoalTripwire): number {
  if (!Number.isFinite(t.threshold) || t.threshold <= 0) return 0;
  const current = Number.isFinite(t.current as number) ? (t.current as number) : 0;
  return Math.max(0, Math.min(1, current / t.threshold));
}

export function tripwireBreached(t: GoalTripwire): boolean {
  if (!Number.isFinite(t.threshold) || t.threshold <= 0) return false;
  return Number.isFinite(t.current as number) && (t.current as number) >= t.threshold;
}

/** `12 of 30 days` — units are optional, so the label degrades to bare numbers. */
export function tripwireLabel(t: GoalTripwire): string {
  const current = Number.isFinite(t.current as number) ? (t.current as number) : 0;
  const unit = t.unit ? ` ${t.unit}` : '';
  return `${current} of ${t.threshold}${unit}`;
}

/**
 * Goals that can still change sit at the top.
 *
 * The resolver already orders rows this way; re-stating it here keeps the tab
 * correct if it is ever handed a hand-built list (a test, a future filter)
 * rather than the query's own output. Pure.
 */
const STATUS_RANK: Record<string, number> = { active: 0, paused: 1 };
export function rankGoals(rows: readonly GoalSummaryRow[]): GoalSummaryRow[] {
  return [...rows].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2) ||
      b.spendUsd - a.spendUsd ||
      a.title.localeCompare(b.title),
  );
}

function GoalCard({ goal }: { goal: GoalSummaryRow }) {
  const ceilingUsd = goal.budgetCents == null ? null : goal.budgetCents / 100;
  const overCeiling = ceilingUsd != null && goal.spendUsd >= ceilingUsd;

  return (
    <div className="pc-goal__card" data-testid={`goal-card-${goal.id}`} data-status={goal.status}>
      <div className="pc-goal__head">
        <span className="pc-goal__title" title={goal.title}>
          {goal.title}
        </span>
        <span className="pc-goal__status" data-status={goal.status}>
          {goal.status}
        </span>
      </div>

      {/* 1. WHAT ENDS THIS GOAL. Rendered first even when there are no
          tripwires — a bare criterion is still the contract, and a goal with
          NO criterion at all is the loudest thing on the card, not a blank. */}
      <div className="pc-goal__ends" data-testid={`goal-ends-${goal.id}`}>
        <span className="pc-goal__ends-label">Ends when</span>
        {goal.killCriterion ? (
          <span className="pc-goal__criterion">{goal.killCriterion}</span>
        ) : (
          <span className="pc-goal__criterion pc-goal__criterion--missing">
            <AlertTriangle size={10} aria-hidden /> no kill criterion — nothing can stop this
          </span>
        )}
      </div>

      {goal.tripwires.length > 0 && (
        <div className="pc-goal__wires">
          {goal.tripwires.map((t) => (
            <div
              className="pc-goal__wire"
              key={t.metric}
              data-testid={`goal-wire-${goal.id}-${t.metric}`}
              data-breached={tripwireBreached(t) ? 'true' : 'false'}
            >
              <span className="pc-goal__wire-label">{t.label}</span>
              <span className="pc-goal__wire-track" aria-hidden>
                <span className="pc-goal__wire-fill" style={{ width: `${tripwireFill(t) * 100}%` }} />
              </span>
              <span className="pc-goal__wire-value">{tripwireLabel(t)}</span>
            </div>
          ))}
        </div>
      )}

      {/* 2. Spend vs ceiling — the second thing that can end a goal. */}
      <div className="pc-goal__meters">
        <Tooltip label="Fleet spend: what the CHILD agents this goal spawned have cost. The goal agent's own turns are subscription-billed and measure ~$0.">
          <span className="pc-goal__meter" data-over={overCeiling ? 'true' : 'false'}>
            <span className="pc-goal__meter-label">fleet spend</span>
            <span className="pc-goal__meter-value" data-testid={`goal-spend-${goal.id}`}>
              {usd(goal.spendUsd)}
              {ceilingUsd != null && <em> / {usd(ceilingUsd)}</em>}
            </span>
          </span>
        </Tooltip>

        {/* 3. The only lane the OWNER can personally unblock. */}
        {goal.needsHuman > 0 && (
          <span className="pc-goal__meter pc-goal__meter--you" data-testid={`goal-needsyou-${goal.id}`}>
            <UserRound size={10} aria-hidden />
            <span className="pc-goal__meter-value">{goal.needsHuman} waiting on you</span>
          </span>
        )}
      </div>

      {/* 4. Context, last. */}
      <div className="pc-goal__foot">
        <span>{goal.projectCount} {goal.projectCount === 1 ? 'project' : 'projects'}</span>
        <span>·</span>
        <span>{goal.openWorkItems} open</span>
      </div>
    </div>
  );
}

export default function GoalTab({ active }: { active: boolean }) {
  // THREAD THE REAL WORKSPACE — do not let the resolver's `'default'` fallback
  // stand in for it. `goals` is workspace-scoped, so a hardcoded or omitted id
  // returns zero rows and renders as "no goals yet" rather than as an error:
  // the read looks healthy and empty when it is actually pointed at the wrong
  // tenant. That exact shape cost WI-5125 (agentChats.detail, 181 rows, all
  // invisible), and an empty state is the one this surface is most likely to
  // show legitimately — so it is the hardest place to notice the bug.
  const workspaceId = useWorkspaceId();
  const q = useSyncQuery<GoalsListPayload>({
    queryName: 'goals.list',
    args: { workspaceId },
    staleTime: 20_000,
    enabled: active,
  });

  const data = q.data?.[0] ?? null;
  const goals = useMemo(() => rankGoals(data?.goals ?? []), [data]);

  if (!active) return null;

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-auto" data-testid="left-sidebar-goal">
        <header className="pc-auto__bar">
          <Target size={14} aria-hidden />
          <span className="pc-auto__identity">
            <span className="pc-auto__title">Goals</span>
            <span className="pc-auto__subtitle">What the fleet is pointed at</span>
          </span>
          <Tooltip label="Every goal in this workspace, across all pots">
            <span className="pc-auto__scope">workspace</span>
          </Tooltip>
          <span className="pc-auto__spacer" />
        </header>

        <div className="pc-auto__panel">
          {q.error && (
            <div className="pc-auto__err" role="alert">
              {String(q.error)}
            </div>
          )}
          {q.loading && !data && <div className="pc-auto__placeholder">Loading…</div>}

          {data && (
            <section className="pc-auto__section">
              <div className="pc-auto__section-head">
                <Target size={12} aria-hidden />
                <span className="pc-auto__section-title">Active goals</span>
                {/* The portfolio figure, NOT a sum of the cards below it. */}
                <Tooltip label="Portfolio spend, counted over DISTINCT projects. It is deliberately LESS than the sum of the cards whenever a project serves more than one goal — that gap is the shared work.">
                  <span className="pc-auto__count" data-testid="goal-portfolio-spend">
                    {usd(data.portfolioSpendUsd)} · {data.portfolioProjects} proj
                  </span>
                </Tooltip>
              </div>

              {goals.length === 0 ? (
                <div className="pc-auto__placeholder">
                  No goals yet. Ask an agent to start one — it will propose the kill criterion
                  and the ceiling rather than handing you a blank form.
                </div>
              ) : (
                goals.map((g) => <GoalCard goal={g} key={g.id} />)
              )}

              {/* Not decoration: without this the reader assumes the cards add up
                  to the portfolio figure, sees that they do not, and reads a
                  correct number as a bug. */}
              <p className="pc-auto__foot">
                <AlertTriangle size={10} aria-hidden /> A project can serve several goals, so
                each goal is charged its FULL cost and these figures do not sum. The header
                total counts each project once.
              </p>
            </section>
          )}
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
