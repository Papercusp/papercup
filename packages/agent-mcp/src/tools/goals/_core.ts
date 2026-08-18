/**
 * Shared goal-row primitives — the ONE definition of how a goal id is minted
 * and how a goal row is written, so a second writer cannot drift from
 * `goals:create`'s column list.
 *
 * WHY THIS IS A SEPARATE MODULE (and a package export subpath). The second
 * writer is `goals:start` (operator-core), which creates the goal AND spawns
 * the GOAL-mode agent that owns it, atomically. That tool cannot live in this
 * package: the spawn needs operator-core's console-launcher, and agent-mcp
 * deliberately does not depend on operator-core. The dependency runs the other
 * way (operator-core imports `@papercusp/agent-mcp`), so the half they share
 * lives HERE and is imported from there — exactly the arrangement `./_bulk`
 * already has.
 *
 * The alternative was re-typing the INSERT in operator-core. That column list
 * has already moved once (migration 765 promoted `kill_criterion` out of
 * `metadata`), and a duplicate would have kept writing the old shape while
 * still compiling.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** A readable, collision-resistant id: `ship-paid-app-3f9a1c`. */
export function goalId(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'goal'}-${randomBytes(3).toString('hex')}`;
}

export const GOAL_STATUSES = ['active', 'achieved', 'killed', 'paused'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * The goal TERMINAL partition — the dependency substrate's per-kind policy for
 * `blocked_kind='goal'` edges (goal-dag-shared-substrate-2026-08-18 D-002).
 *
 * Goals join the shared work-queue DAG (`work_item_deps` + the blockersOf()/
 * frontier-readiness seam) as a SECOND consumer family, and the work-item rule
 * — any terminal blocker is satisfied — is WRONG here, because a goal dies two
 * ways that mean opposite things downstream:
 *
 *   - `achieved` SATISFIES a dependent ("get 1k users" achieved ⇒ "monetize
 *     the users" is now doable);
 *   - `killed` INVALIDATES the dependent's PREMISE ("get 1k users" killed ⇒
 *     "monetize the users" is moot, not ready). A killed blocker must NEVER
 *     silently unblock — readers flag the dependent `premiseInvalidated` for
 *     owner/parent review (retarget, unblock deliberately, or kill downstream).
 *
 * TERMINAL answers "is this goal finished?" (what a generic finished-check
 * needs); the SATISFYING/INVALIDATING split answers "what does that mean for
 * a dependent?". Same shape as work-item-blocking.ts's ISSUE_SHIPPED /
 * ISSUE_ABANDONED partition of ISSUE_TERMINAL_STATUSES — promoted here from
 * reporting to blocking semantics. The partition invariant (disjoint, together
 * exhaustive over TERMINAL) is pinned by `_core.test.ts`, so a future status
 * joining GOAL_STATUSES without being classified fails a test rather than
 * silently defaulting to either side.
 */
export const GOAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['achieved', 'killed']);
export const GOAL_SATISFYING_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['achieved']);
export const GOAL_INVALIDATING_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['killed']);

/**
 * A TRIPWIRE turns the kill criterion from prose into a readout.
 *
 * A criterion written as a sentence ("kill this if we pass $500 or 30 days
 * without a shipped build") is a promise nobody re-checks; the same thing as
 * `{ metric, threshold, current }` renders as a bar the owner can act on at a
 * glance (goal-mode-2026-08-07 P-021). Deliberately OPTIONAL and unconstrained
 * as to metric name: a goal whose criterion is genuinely unquantifiable must
 * still be creatable, and the detail view renders the prose with no bars when
 * this is null. `current` is a snapshot the agent refreshes via goals:update —
 * it is NOT computed here, because most metrics (revenue, users, shipped
 * builds) live outside this database entirely.
 */
export const TripwireSchema = z.object({
  metric: z.string().min(1).max(60).describe('machine key, e.g. "days_elapsed" / "spend_usd"'),
  label: z.string().min(1).max(120).describe('how it reads to the owner, e.g. "Day 12 of 30"'),
  threshold: z.number().describe('the value at which the criterion trips'),
  current: z.number().optional().describe('latest observed value; omit until first measured'),
  unit: z.string().max(20).optional().describe('"usd" / "days" / "users" — display only'),
});
export type Tripwire = z.infer<typeof TripwireSchema>;

/**
 * The narrowest structural type that both callers' SQL handles satisfy: a
 * tagged-template function returning rows. `goals:create` passes the MCP
 * request's `ctx.tx`; `goals:start` passes the org pool's `sql`. Typing it
 * structurally keeps this module free of a postgres.js import (and of any
 * opinion about which pool the caller is on).
 */
export interface GoalSqlTag {
  <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface GoalRowInput {
  id: string;
  installSlug: string;
  workspaceId: string;
  title: string;
  body?: string | null;
  parentId?: string | null;
  budgetCents?: number | null;
  status?: GoalStatus;
  killCriterion?: string | null;
  tripwires?: Tripwire[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Write the goal row. Both writers go through here, so the column list has
 * exactly one home.
 *
 * The kill criterion is a first-class COLUMN (migration 765), not a metadata
 * key. It used to be folded into `metadata` because the column did not exist —
 * but the whole GUI reads it (the detail view's "THIS GOAL ENDS WHEN"
 * headline, the rail's glance), and a jsonb key cannot be indexed,
 * constrained, or joined the way the read path needs.
 */
export async function insertGoalRow(tx: GoalSqlTag, row: GoalRowInput): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  await tx`
    INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, body, parent_id, budget_cents, status,
       kill_criterion, tripwires, metadata)
    VALUES
      (${row.id}, ${row.installSlug}, ${row.workspaceId}, ${row.title}, ${row.body ?? null},
       ${row.parentId ?? null}, ${row.budgetCents ?? null}, ${row.status ?? 'active'},
       ${row.killCriterion ?? null},
       ${row.tripwires?.length ? JSON.stringify(row.tripwires) : null}::jsonb,
       ${Object.keys(metadata).length ? JSON.stringify(metadata) : null}::jsonb)
  `;
}

/**
 * Undo `insertGoalRow` — used ONLY to roll back a goal whose agent failed to
 * spawn (`goals:start`). A goal with no agent is worse than no goal: it sits
 * on the board as an outcome somebody believes is being pursued, and nothing
 * is pursuing it.
 *
 * Deliberately id-scoped AND workspace-scoped: the id is minted per call and
 * cannot collide across workspaces, but `harness_shared.goals` is multi-tenant
 * and a rollback must never be able to reach another tenant's row.
 */
export async function deleteGoalRow(
  tx: GoalSqlTag,
  opts: { id: string; workspaceId: string },
): Promise<void> {
  await tx`
    DELETE FROM harness_shared.goals
     WHERE id = ${opts.id} AND workspace_id = ${opts.workspaceId}
  `;
}
