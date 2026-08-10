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

// ⚠ `harness_shared.work_items` DOES NOT HAVE `closed_at` / `updated_at`. Its
// timestamps are BIGINT EPOCH-MS columns named `closed_ts` / `updated_ts` (and
// its primary key is `feature_id`, not `id`) — unlike `goals`, `goal_projects`
// and every other table this file touches, which all use real timestamptz
// `*_at` columns. Writing the `*_at` form here is the natural mistake and it
// throws at RUNTIME ONLY (`column wi.closed_at does not exist`): tsc cannot see
// into a SQL string, and every test that mocks the sync layer stays green. Both
// resolvers below shipped with exactly that bug and NOTHING caught it until the
// query was first run against a real database — see the integration test beside
// this file, which exists to make that impossible a second time.
//
// Convert on the way out (`to_timestamp(x / 1000.0)`) rather than passing the
// bigint through: the row mappers hand these to `iso()`, which expects a Date
// or an ISO string and would otherwise stringify the raw epoch number.
//
// NOTE: the `tx` handle inside `sql.begin` is deliberately left INFERRED below.
// Annotating it `Sql` is wrong and does not merely lose precision — postgres.js
// hands the callback a `TransactionSql`, which is not assignable to `Sql`, so
// the annotation fails to typecheck outright. Every other `sql.begin` in this
// package leaves it inferred for the same reason.

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
  /**
   * Fleet spend inside the recent window — the RATE input, where `spendUsd` is
   * the LEVEL (goals-tab-improvement-2026-08-09 P-003).
   *
   * `spendUsd` alone cannot distinguish a goal that spent its ceiling over six
   * weeks from one that spent it since Tuesday, and the ceiling is exactly the
   * thing the owner needs advance warning of.
   *
   * Attributed exactly as `spendUsd` is — every sample for the goal's
   * non-removed projects — so the two are the same measurement over different
   * spans and a caller may divide one by the window to get a rate. It follows
   * that this inherits D-021: it is per-goal and DOES NOT SUM across goals,
   * because a shared project's spend counts in full against each goal it serves.
   */
  spendRecentUsd: number;
  /**
   * How wide that window is, in days.
   *
   * On the WIRE rather than a constant the UI imports, because the HUD
   * deliberately narrows this row into its own `HudGoalInput` instead of
   * importing it (see that type's docblock). A UI that hardcoded `7` would
   * silently keep saying "last 7 days" if this window were ever retuned;
   * reading the window from the same payload as the figure makes that
   * particular drift impossible rather than merely unlikely.
   */
  spendRecentWindowDays: number;
}

/**
 * The rolling window behind `spendRecentUsd`.
 *
 * Rolling (`ts >= now - N days`), NOT calendar days. `spendByDay` further down
 * buckets by UTC calendar day for the chart, and the two windows genuinely
 * differ — deriving the burn from those buckets instead would guarantee the
 * card and the detail panel disagreed about the same goal.
 */
export const SPEND_RECENT_WINDOW_DAYS = 7;

const SPEND_RECENT_WINDOW_MS = SPEND_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
  spend_recent_usd: string | null;
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
    spendRecentUsd: num(r.spend_recent_usd),
    spendRecentWindowDays: SPEND_RECENT_WINDOW_DAYS,
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
  // Cut ONCE for the whole page, so two rows in the same render can never be
  // measured over windows that differ by the query's own duration.
  const recentSinceMs = Date.now() - SPEND_RECENT_WINDOW_MS;
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.metadata, g.created_at, g.updated_at,
             (SELECT COUNT(*) FROM harness_shared.goal_projects gp
               WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                 AND gp.removed_at IS NULL) AS project_count,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_ts IS NULL) AS open_work_items,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.goal_id = g.id AND wi.closed_ts IS NULL
                 AND COALESCE((wi.payload->>'needsHuman')::boolean, false)) AS needs_human,
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.harness_slug IN (
                   SELECT gp.harness_slug FROM harness_shared.goal_projects gp
                    WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                      AND gp.removed_at IS NULL)) AS spend_usd,
             -- The same sum over the recent window. s.ts is epoch MILLIS
             -- (bigint), not a timestamp, so this compares against a ms integer
             -- rather than a now() - interval expression. Covered by
             -- agent_usage_samples_harness_idx (workspace_id, harness_slug, ts DESC).
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = g.workspace_id
                 AND s.ts >= ${recentSinceMs}
                 AND s.harness_slug IN (
                   SELECT gp.harness_slug FROM harness_shared.goal_projects gp
                    WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                      AND gp.removed_at IS NULL)) AS spend_recent_usd
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
 * One PLAN associated with a goal (goals-tab-improvement-2026-08-09 P-019).
 *
 * ⚠ Read D-010 before changing how this is derived. A goal has NO direct plan
 * link — `harness_plans` carries no `goal_id` and there is no join table — so
 * this is DERIVED, and only one derivation is honest: a plan serves a goal iff a
 * work item STAMPED with that goal came from that plan
 * (`work_items.goal_id` → `work_items.source_plan_slug`).
 *
 * The tempting alternative — every plan in a harness that `goal_projects` links
 * to the goal — is REJECTED and must not be reintroduced: a harness holds
 * hundreds of plans, so it answers "plans in a project that serves this goal",
 * which would render the entire papercusp plan directory under a one-day-old
 * goal and call it association.
 *
 * Deriving it this way also inherits the stamp's provenance rule for free:
 * `stampGoalProvenance` writes `goal_id` only from the creator's live GOAL-mode
 * subject, never from an argument or a guess, so a plan cannot self-report its
 * way onto a goal.
 */
export interface GoalPlanCard {
  planSlug: string;
  harnessSlug: string;
  /** Null when the work items reference a plan slug that no longer resolves —
   *  rendered as the bare slug rather than dropped, because a plan that was
   *  deleted out from under live work items is worth SEEING, not hiding. */
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Work items on this goal that came from this plan. NOT a count of the
   *  plan's own items — the plan may be far larger than its goal-stamped slice,
   *  and labelling this "plan progress" would overstate what the goal owns. */
  items: number;
  openItems: number;
  updatedAt: string | null;
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
  // Same cut as resolveGoalsList — see the note there.
  const recentSinceMs = Date.now() - SPEND_RECENT_WINDOW_MS;

  return sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);

    const [goalRow] = (await tx`
      SELECT g.id, g.title, g.body, g.status, g.parent_id, g.kill_criterion, g.tripwires,
             g.budget_cents, g.metadata, g.created_at, g.updated_at,
             0 AS project_count, 0 AS open_work_items, 0 AS needs_human,
             0 AS spend_usd, 0 AS spend_recent_usd
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
             -- The recent-window half, per project, so the popup's burn rate is
             -- the SAME measurement the card's is (P-003). Deliberately the
             -- rolling ts predicate the list uses, NOT the calendar-day buckets
             -- spend_by_day builds below: those are different windows, and
             -- deriving the rate from them would make the two surfaces disagree.
             (SELECT COALESCE(SUM(s.cost_usd), 0)
                FROM harness_shared.agent_usage_samples s
               WHERE s.workspace_id = gp.workspace_id
                 AND s.ts >= ${recentSinceMs}
                 AND s.harness_slug = gp.harness_slug) AS spend_recent_usd,
             (SELECT COUNT(*) FROM harness_shared.work_items wi
               WHERE wi.harness_slug = gp.harness_slug
                 AND wi.goal_id = gp.goal_id
                 AND wi.closed_ts IS NULL) AS open_work_items
        FROM harness_shared.goal_projects gp
       WHERE gp.workspace_id = ${workspaceId} AND gp.goal_id = ${goalId}
       ORDER BY (gp.removed_at IS NULL) DESC, (gp.role = 'owner') DESC, gp.added_at ASC
    `) as unknown as Array<Record<string, unknown>>;

    // Waiting on you — the asks only the owner can clear. This is the first
    // thing the detail view shows after the kill criterion, because it is the
    // only section the owner can ACT on.
    const waiting = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug,
             to_timestamp(wi.updated_ts / 1000.0) AS updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
         AND wi.closed_ts IS NULL
         AND COALESCE((wi.payload->>'needsHuman')::boolean, false)
       ORDER BY wi.updated_ts DESC NULLS LAST
       LIMIT 25
    `) as unknown as Array<Record<string, unknown>>;

    const activity = (await tx`
      SELECT wi.feature_id AS id, wi.title, wi.harness_slug, wi.status,
             to_timestamp(wi.closed_ts / 1000.0) AS closed_at,
             to_timestamp(wi.updated_ts / 1000.0) AS updated_at
        FROM harness_shared.work_items wi
       WHERE wi.goal_id = ${goalId}
       ORDER BY wi.updated_ts DESC NULLS LAST
       LIMIT ${activityLimit}
    `) as unknown as Array<Record<string, unknown>>;

    // Plans, DERIVED through the goal's stamped work items (D-010). The LEFT
    // JOIN is deliberate: a slug whose plan row is gone still returns a card
    // with a null title, because live work items pointing at a deleted plan is
    // exactly the state worth surfacing.
    const planRows = (await tx`
      SELECT wi.source_plan_slug AS plan_slug,
             wi.harness_slug,
             p.title, p.status, COALESCE(p.archived, false) AS archived,
             COUNT(*) AS items,
             COUNT(*) FILTER (WHERE wi.closed_ts IS NULL) AS open_items,
             to_timestamp(MAX(wi.updated_ts) / 1000.0) AS updated_at
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.harness_plans p
               ON p.workspace_id = ${workspaceId}
              AND p.harness_slug = wi.harness_slug
              AND p.plan_slug = wi.source_plan_slug
       WHERE wi.goal_id = ${goalId}
         AND wi.source_plan_slug IS NOT NULL
       GROUP BY wi.source_plan_slug, wi.harness_slug, p.title, p.status, p.archived
       ORDER BY COUNT(*) FILTER (WHERE wi.closed_ts IS NULL) DESC, MAX(wi.updated_ts) DESC NULLS LAST
    `) as unknown as Array<Record<string, unknown>>;

    // The agent(s) RUNNING this goal (P-018's conversation affordance). D-007:
    // the goal↔agent marker is `agent_modes.subject` — no dedicated column and
    // no migration was ever needed. `goals:start` writes this row, so the goal
    // popup can offer the ONE honest conversation affordance available to it:
    // a route to the agent's existing conversation, never a composer of its own
    // (see GoalDetailPanel's docblock and D-011).
    //
    // D-006 makes this a single agent in practice (one directed agent = one
    // goal), but it is returned as a LIST rather than a scalar: collapsing it
    // would silently hide a second stamp, and a goal with two agents is a
    // coordination fault worth SEEING rather than a row to discard.
    const agentRows = (await tx`
      SELECT am.owner_id, am.set_at, am.set_by
        FROM harness_shared.agent_modes am
       WHERE am.workspace_id = ${workspaceId}
         AND am.mode = 'goal'
         AND am.subject = ${goalId}
       ORDER BY am.set_at DESC
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
    // Summed over the SAME project set as spendUsd immediately above, so the
    // level and the rate always describe one population. Read off the raw rows
    // rather than the mapped ones: this is an input to the burn, not a field of
    // the project card, and widening the card's type for it would put an
    // unrendered number on a public shape.
    goal.spendRecentUsd = projectRows
      .filter((p) => p.removed_at == null)
      .reduce((acc, p) => acc + num(p.spend_recent_usd), 0);
    goal.openWorkItems = projects.reduce((acc, p) => acc + p.openWorkItems, 0);

    /* SUBDIRECTIVES + the parent, for the popup's hierarchy section
       (goals-tab-improvement-2026-08-09 P-017).

       Deliberately NARROW — id/title/status only. No spend, no ceiling, no
       counts: per D-006 one goal is one agent is one bill, so a child HAS no
       separable spend, and selecting a column that looks like one would invite
       the parent+children addition D-002 forbids. The columns are absent rather
       than zeroed, because a rendered 0 reads as a measurement.

       Ordered oldest-first: these are the directions the agent was pointed in,
       and that sequence is the readable story of how the goal got here. */
    const childRows = (await tx`
      SELECT g.id, g.title, g.status
        FROM harness_shared.goals g
       WHERE g.workspace_id = ${workspaceId} AND g.parent_id = ${goalId}
       ORDER BY g.created_at ASC
       LIMIT 200
    `) as unknown as Array<{ id: string; title: string | null; status: string | null }>;

    /* The parent's TITLE, so a child's popup can name what it serves instead of
       rendering a bare id the owner would have to go look up. Skipped entirely
       when this goal has no parent. */
    const parentId = (goalRow.parent_id as string | null) ?? null;
    const [parentRow] = parentId
      ? ((await tx`
          SELECT g.id, g.title
            FROM harness_shared.goals g
           WHERE g.workspace_id = ${workspaceId} AND g.id = ${parentId}
           LIMIT 1
        `) as unknown as Array<{ id: string; title: string | null }>)
      : [];

    return {
      goal,
      /** Present and empty when this goal has none — never absent, so the panel
       *  can tell "no subdirectives" from "this payload predates P-017". */
      subGoals: childRows.map((c) => ({
        id: String(c.id),
        title: (c.title as string | null) ?? String(c.id),
        status: String(c.status ?? '').toLowerCase(),
      })),
      /** Null unless this goal IS a subdirective. */
      parent: parentRow
        ? { id: String(parentRow.id), title: (parentRow.title as string | null) ?? String(parentRow.id) }
        : null,
      projects,
      agents: agentRows.map((a) => ({
        ownerId: String(a.owner_id),
        setAt: iso(a.set_at as string | Date | null),
        setBy: (a.set_by as string | null) ?? null,
      })),
      plans: planRows.map((p) => ({
        planSlug: String(p.plan_slug),
        harnessSlug: String(p.harness_slug),
        title: (p.title as string | null) ?? null,
        status: (p.status as string | null) ?? null,
        archived: p.archived === true,
        items: num(p.items),
        openItems: num(p.open_items),
        updatedAt: iso(p.updated_at as string | Date | null),
      })),
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
