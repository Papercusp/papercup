/**
 * goals.* sync-resolver reads — the client data path for GOAL mode
 * (goal-mode-2026-08-07 P-017).
 *
 * Before this there was NO goal-shaped query among the ~210 registered: the
 * goals table had a schema, write tools and an MCP resource, but nothing the
 * UI could subscribe to. Every surface in Phase 4 (the rail tab, the HUD goals
 * tab, the detail view) reads from exactly these two.
 *
 * ── The counting rule these queries encode ─────────────────────────────────
 * A project can serve several goals (D-021), so a shared project's spend counts
 * IN FULL against each of them and `goals.list`'s per-row spend figures DO NOT
 * SUM. The list therefore also returns `portfolioSpendUsd` — computed over
 * DISTINCT projects — so a client that wants a total has one to read and never
 * has to add the rows up itself. The `Σ rows ≠ portfolio` gap is real and
 * expected; it is the shared work, not a bug.
 */

import type { Sql } from 'postgres';

export interface GoalTripwire {
  metric: string;
  label: string;
  threshold: number;
  current?: number;
  unit?: string;
}

export interface GoalSummaryRow {
  id: string;
  title: string;
  body: string | null;
  status: string;
  parentId: string | null;
  killCriterion: string | null;
  tripwires: GoalTripwire[];
  budgetCents: number | null;
  spentCents: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  projectCount: number;
  /** Open work-items stamped to this goal — the "is anything moving" signal. */
  openWorkItems: number;
  /** Items parked on the owner. The rail's "waiting on you" count. */
  needsHuman: number;
  spendUsd: number;
}

/** Rows are ordered so the goals that can still change sit at the top. */
const STATUS_RANK = `CASE g.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`;

function parseTripwires(raw: unknown): GoalTripwire[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is GoalTripwire =>
      !!t && typeof t === 'object' && typeof (t as GoalTripwire).metric === 'string',
  );
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

interface RawGoal {
  id: string;
  title: string;
  body: string | null;
  status: string;
  parent_id: string | null;
  kill_criterion: string | null;
  tripwires: unknown;
  budget_cents: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  project_count: string | null;
  open_work_items: string | null;
  needs_human: string | null;
  spend_usd: string | null;
}

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toSummary(r: RawGoal): GoalSummaryRow {
  const metadata = r.metadata ?? {};
  const spentCents =
    typeof metadata.spentCents === 'number' ? (metadata.spentCents as number) : null;
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    parentId: r.parent_id,
    // Fall back to the pre-migration-765 home so a legacy goal still shows the
    // one string the whole GUI is built around, rather than rendering blank.
    killCriterion:
      r.kill_criterion ??
      (typeof metadata.killCriterion === 'string' ? (metadata.killCriterion as string) : null),
    tripwires: parseTripwires(r.tripwires),
    budgetCents: r.budget_cents == null ? null : Number(r.budget_cents),
    spentCents,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    projectCount: num(r.project_count),
    openWorkItems: num(r.open_work_items),
    needsHuman: num(r.needs_human),
    spendUsd: num(r.spend_usd),
  };
}

/**
 * The goal cards: every goal in the workspace with its live counters.
 *
 * Counters are computed in ONE pass of correlated sub-selects rather than N+1
 * round-trips — a goals list is rendered on every HUD tick, and this is the
 * read most likely to become a hot path.
 */
export async function resolveGoalsList(args: {
  workspaceId: string;
  status?: string | null;
  limit?: number;
}): Promise<{ goals: GoalSummaryRow[]; portfolioSpendUsd: number; portfolioProjects: number }> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, status = null, limit = 100 } = args;
  const rows = await sql.begin(async (tx: Sql) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.metadata, g.created_at, g.updated_at,
             (SELECT COUNT(*) FROM harness_shared.goal_projects gp
               WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                 AND gp.removed_at IS NULL) AS project_count,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_at IS NULL) AS open_work_items,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_at IS NULL
                 AND COALESCE((wi.payload->>'needsHuman')::boolean, false)) AS needs_human,
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.harness_slug IN (
                   SELECT gp.harness_slug FROM harness_shared.goal_projects gp
                    WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                      AND gp.removed_at IS NULL)) AS spend_usd
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId}
         AND (${status}::text IS NULL OR g.status = ${status}::text)
       ORDER BY ${sql.unsafe(STATUS_RANK)}, g.updated_at DESC NULLS LAST
       LIMIT ${limit}
    `) as unknown as RawGoal[];
  });
  const goals = rows.map(toSummary);

  // The portfolio total, over DISTINCT projects. Deliberately returned
  // alongside the rows the client already has: the natural thing to do with a
  // list of spend figures is add them up, and that answer is wrong by exactly
  // the shared work. Handing over the correct total removes the temptation.
  const { portfolioSpend } = await import('@papercusp/db-org');
  const portfolio = await portfolioSpend(sql, {
    workspaceId,
    goalIds: goals.map((g) => g.id),
  });
  return {
    goals,
    portfolioSpendUsd: portfolio.costUsd,
    portfolioProjects: portfolio.projects,
  };
}

export interface GoalProjectCard {
  harnessSlug: string;
  role: 'owner' | 'contributing';
  killCriterion: string | null;
  note: string | null;
  addedAt: string;
  /** How many goals this project serves — the "shared with N goals" badge. */
  servesGoals: number;
  spendUsd: number;
  openWorkItems: number;
}

/**
 * One goal, everything its page needs, in a single round-trip.
 *
 * ⚠ KILLED PROJECTS ARE INCLUDED, flagged rather than filtered. If kills
 * vanished from the page it would only ever show growth, and the single
 * behaviour the owner most needs to confirm — that the agent actually CLOSES
 * things (contract clause 4) — would be invisible precisely when it is working.
 */
export async function resolveGoalDetail(args: {
  workspaceId: string;
  goalId: string;
  activityLimit?: number;
}): Promise<unknown> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, goalId, activityLimit = 40 } = args;

  return sql.begin(async (tx: Sql) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);

    const [goalRow] = (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.metadata, g.created_at, g.updated_at,
             0 AS project_count, 0 AS open_work_items, 0 AS needs_human, 0 AS spend_usd
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId} AND g.id = ${goalId}
       LIMIT 1
    `) as unknown as RawGoal[];
    if (!goalRow) return { goal: null };

    // Projects, INCLUDING removed ones (see the note above) — `removedAt`
    // non-null is what the greyed-out card renders from.
    const projectRows = (await tx`
      SELECT gp.harness_slug, gp.role, gp.kill_criterion, gp.note, gp.added_at, gp.removed_at,
             (SELECT COUNT(*) FROM harness_shared.goal_projects sib
               WHERE sib.workspace_id = gp.workspace_id
                 AND sib.harness_slug = gp.harness_slug
                 AND sib.removed_at IS NULL) AS serves_goals,
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = gp.workspace_id
                 AND s.harness_slug = gp.harness_slug) AS spend_usd,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.harness_slug = gp.harness_slug
                 AND wi.goal_id = gp.goal_id
                 AND wi.closed_at IS NULL) AS open_work_items
        FROM harness_shared.goal_projects gp
       WHERE gp.workspace_id = ${workspaceId} AND gp.goal_id = ${goalId}
       ORDER BY (gp.removed_at IS NULL) DESC, (gp.role = 'owner') DESC, gp.added_at ASC
    `) as unknown as Array<Record<string, unknown>>;

    // Waiting on you — the asks only the owner can clear. This is the first
    // thing the detail view shows after the kill criterion, because it is the
    // only section the owner can ACT on.
    const waiting = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug, wi.updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
         AND wi.closed_at IS NULL
         AND COALESCE((wi.payload->>'needsHuman')::boolean, false)
       ORDER BY wi.updated_at DESC NULLS LAST
       LIMIT 25
    `) as unknown as Array<Record<string, unknown>>;

    const activity = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug, wi.status,
             wi.closed_at, wi.updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
       ORDER BY wi.updated_at DESC NULLS LAST
       LIMIT ${activityLimit}
    `) as unknown as Array<Record<string, unknown>>;

    // Spend by day, stacked by project — the shape the chart wants, computed
    // once here rather than bucketed client-side over a raw sample list.
    const spendByDay = (await tx`
      SELECT to_char(to_timestamp(s.ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             s.harness_slug,
             COALESCE(SUM(s.cost_usd), 0) AS cost
        FROM harness_shared.agent_usage_samples s
       WHERE s.workspace_id = ${workspaceId}
         AND s.harness_slug IN (
           SELECT gp.harness_slug FROM harness_shared.goal_projects gp
            WHERE gp.workspace_id = ${workspaceId} AND gp.goal_id = ${goalId}
              AND gp.removed_at IS NULL)
       GROUP BY day, s.harness_slug
       ORDER BY day ASC
    `) as unknown as Array<Record<string, unknown>>;

    const projects = projectRows.map((p) => ({
      harnessSlug: String(p.harness_slug),
      role: p.role === 'owner' ? 'owner' : 'contributing',
      killCriterion: (p.kill_criterion as string | null) ?? null,
      note: (p.note as string | null) ?? null,
      addedAt: iso(p.added_at as string | Date | null),
      removedAt: iso(p.removed_at as string | Date | null),
      servesGoals: num(p.serves_goals),
      spendUsd: num(p.spend_usd),
      openWorkItems: num(p.open_work_items),
    }));

    const goal = toSummary(goalRow);
    goal.projectCount = projects.filter((p) => !p.removedAt).length;
    goal.needsHuman = waiting.length;
    goal.spendUsd = projects
      .filter((p) => !p.removedAt)
      .reduce((acc, p) => acc + p.spendUsd, 0);
    goal.openWorkItems = projects.reduce((acc, p) => acc + p.openWorkItems, 0);

    return {
      goal,
      projects,
      waitingOnYou: waiting.map((w) => ({
        id: String(w.id),
        title: String(w.title),
        harnessSlug: (w.harness_slug as string | null) ?? null,
        updatedAt: iso(w.updated_at as string | Date | null),
      })),
      activity: activity.map((a) => ({
        id: String(a.id),
        title: String(a.title),
        harnessSlug: (a.harness_slug as string | null) ?? null,
        status: (a.status as string | null) ?? null,
        closedAt: iso(a.closed_at as string | Date | null),
        updatedAt: iso(a.updated_at as string | Date | null),
      })),
      spendByDay: spendByDay.map((d) => ({
        day: String(d.day),
        harnessSlug: (d.harness_slug as string | null) ?? null,
        costUsd: num(d.cost),
      })),
      // Repeated on the detail payload because this is the page most likely to
      // be screenshotted into a report, and a spend number without this caveat
      // invites the wrong comparison.
      spendLabel: 'fleet spend',
      spendNote:
        'Spawned-agent cost attributed to this goal’s projects. A project shared with another goal counts here IN FULL, so goal spend figures do not sum.',
    };
  });
}
