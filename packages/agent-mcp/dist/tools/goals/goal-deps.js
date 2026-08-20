/**
 * goal-deps — goals' membership in the shared work-queue DAG substrate
 * (goal-dag-shared-substrate-2026-08-18 P-001/P-002, D-001/D-002/D-003/D-006).
 *
 * Goals are the SECOND consumer family of the dependency substrate work items
 * already use: edges live in the SAME polymorphic `harness_shared.work_item_deps`
 * table (`blocked_kind='goal'`), and satisfaction follows the same
 * absent-never-deadlocks rule as `blockerSatisfied` (frontier-readiness.ts).
 * What differs is POLICY, and the differences are the point (D-002/D-003):
 *
 *   - achieved SATISFIES a dependent; killed INVALIDATES its premise — a killed
 *     blocker never silently unblocks (see the partition sets in `_core.ts`);
 *   - readiness at goal level is an ACTIVATION GATE, never dispatch: goals never
 *     enter `scheduler:get_next`; `actionable` feeds boards, warnings and a
 *     report-only watchdog, and a human or parent-goal decision does the rest.
 *
 * ONE HOME FOR BOTH PACKAGES. The helpers take a `GoalSqlTag` (the structural
 * tagged-template type `insertGoalRow` already uses), so the agent-mcp tools
 * pass `ctx.tx` (transactional with the goal row write) and operator-core
 * callers (goals:start, goal-auto-start, the liveness watchdog) pass
 * `getOrgPg().sql` — one SQL definition, no drifting twin. operator-core
 * reaches this module via the `@papercusp/agent-mcp/goal-deps` subpath.
 *
 * WORKSPACE SCOPING differs from the feature/issue rows deliberately: those are
 * written under DEFAULT_COORD_WORKSPACE, but `harness_shared.goals` is
 * multi-tenant with a NOT NULL workspace_id, so goal edges carry the goal's
 * REAL workspace_id and every read here is workspace-scoped.
 */
import { ISSUE_TERMINAL_STATUSES } from '@papercusp/operator-core/lib/work-item-blocking';
import { wouldCreateCycle } from '@papercusp/operator-core/lib/dbos/work-item-deps-store';
import { GOAL_INVALIDATING_STATUSES, GOAL_SATISFYING_STATUSES, } from './_core';
/** The `work_item_deps` endpoint kind for a goal (bare slug-hex ref, never harness-qualified). */
export const GOAL_DEP_KIND = 'goal';
/** The issue-family endpoint kind (bare `WI-NNN` / `EI-NNN` refs — issues:link convention). */
export const ISSUE_DEP_KIND = 'issue';
/**
 * The composite lookup key blocker maps are keyed by. A COLON separator, and
 * one function so readers cannot drift on it. (Deliberately not a space: the
 * psu file-write path has a live corruption bug that turns the `}` + space +
 * `${` byte sequence in authored template literals into a NUL byte — see the
 * nul-byte-edit-guard / the git-sync content-check quarantine class. A colon
 * sidesteps the corrupting byte pattern entirely.)
 */
export function blockerStatusKey(b) {
    return `${b.kind}:${b.ref}`;
}
/** Bare issue-family id (work-item / engineer-issue). Goal ids are slug-hex and never match. */
const ISSUE_REF = /^(?:WI|EI)-\d+$/;
/**
 * Classify a caller-supplied `blockedBy` ref by SHAPE (D-006): a bare `WI-NNN` /
 * `EI-NNN` is an issue-family work item; anything else is a goal id. Shape
 * classification is only the FIRST gate — the writer still verifies a
 * goal-classified ref resolves to a goal row in the same workspace and refuses
 * otherwise, so a typo'd ref can never mint a silently-inert edge (the D-017
 * lesson from the issue/feature families).
 */
export function classifyGoalBlockerRef(ref) {
    const trimmed = ref.trim();
    return ISSUE_REF.test(trimmed)
        ? { kind: ISSUE_DEP_KIND, ref: trimmed }
        : { kind: GOAL_DEP_KIND, ref: trimmed };
}
/**
 * All goal blocked-by edges in a workspace: blocked goal id → its blocker
 * endpoints (goal AND issue kinds). One query — goal cardinality is tiny, and
 * cycle checks need the whole goal graph anyway (D-006: derived on read, no
 * maintained readiness column).
 */
export async function readGoalBlockedByEdges(sql, workspaceId) {
    const rows = await sql `
    SELECT blocked_ref, blocker_kind, blocker_ref
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${workspaceId}
       AND dep_type = 'blocks'
       AND blocked_kind = ${GOAL_DEP_KIND}`;
    const out = new Map();
    for (const r of rows) {
        const kind = r.blocker_kind === ISSUE_DEP_KIND ? ISSUE_DEP_KIND : GOAL_DEP_KIND;
        const arr = out.get(r.blocked_ref) ?? [];
        if (!arr.some((e) => e.kind === kind && e.ref === r.blocker_ref)) {
            arr.push({ kind, ref: r.blocker_ref });
        }
        out.set(r.blocked_ref, arr);
    }
    return out;
}
/** The goal→goal projection of the edge map — the graph the acyclicity guard runs over.
 *  Issue blockers cannot participate in a goal cycle (nothing blocks an issue on a goal in v1),
 *  so they are excluded rather than fed to the cycle check as phantom nodes. */
export function goalToGoalGraph(edges) {
    const graph = new Map();
    for (const [blocked, blockers] of edges) {
        graph.set(blocked, blockers.filter((b) => b.kind === GOAL_DEP_KIND).map((b) => b.ref));
    }
    return graph;
}
/**
 * Would replacing `goalId`'s goal-blockers with `newGoalBlockers` create a
 * cycle? Pure — delegates to the substrate's own guard (`wouldCreateCycle`,
 * dbos/work-item-deps-store.ts), same replace semantics as the writer below.
 */
export function goalBlockedByWouldCycle(edges, goalId, newGoalBlockers) {
    return wouldCreateCycle(goalToGoalGraph(edges), goalId, newGoalBlockers);
}
/**
 * Replace `goalId`'s blocked-by set (declarative full-set semantics — the same
 * replace shape `wouldCreateCycle` documents for the work-item writer). Delete
 * + insert inside the caller's tag, so a tool caller gets it transactional with
 * the goal-row write. Self-edges are dropped (the table's no-self CHECK would
 * refuse them anyway); duplicates collapse via the unique edge index.
 */
export async function replaceGoalBlockedBy(sql, opts) {
    await sql `
    DELETE FROM harness_shared.work_item_deps
     WHERE workspace_id = ${opts.workspaceId}
       AND dep_type = 'blocks'
       AND blocked_kind = ${GOAL_DEP_KIND}
       AND blocked_ref = ${opts.goalId}`;
    const seen = new Set();
    for (const b of opts.blockers) {
        if (b.kind === GOAL_DEP_KIND && b.ref === opts.goalId)
            continue; // self-edge: quiet no-op
        const key = blockerStatusKey(b);
        if (seen.has(key))
            continue;
        seen.add(key);
        await sql `
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
      VALUES
        (${opts.workspaceId}, ${GOAL_DEP_KIND}, ${opts.goalId}, ${b.kind}, ${b.ref}, 'blocks',
         ${opts.createdBy ?? null})
      ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      DO NOTHING`;
    }
}
/**
 * The per-blocker policy, pure:
 *   - `status: null` = the blocker row no longer exists — SATISFIED, the same
 *     absent-never-deadlocks rule as `blockerSatisfied` (frontier-readiness.ts);
 *   - goal blockers: achieved ⇒ satisfied; killed ⇒ INVALIDATING (premise gone
 *     — never silently unblocks); active/paused ⇒ pending;
 *   - issue blockers: plain terminal-satisfies (v1, D-006) — any
 *     `ISSUE_TERMINAL_STATUSES` member satisfies; open/anything-else pends.
 */
export function goalBlockerVerdict(kind, status) {
    if (status == null)
        return 'satisfied';
    if (kind === GOAL_DEP_KIND) {
        if (GOAL_SATISFYING_STATUSES.has(status))
            return 'satisfied';
        if (GOAL_INVALIDATING_STATUSES.has(status))
            return 'invalidating';
        return 'pending';
    }
    return ISSUE_TERMINAL_STATUSES.has(status) ? 'satisfied' : 'pending';
}
/**
 * Fold blocker views into the goal's readiness verdict. `actionable` is the
 * answer to the owner's question this substrate exists for — "which goals are
 * actually doable right now" — and it is a READ, never a dispatch signal (D-003).
 */
export function goalReadiness(blockers) {
    const views = blockers.map((b) => ({
        kind: b.kind,
        ref: b.ref,
        status: b.status,
        verdict: goalBlockerVerdict(b.kind, b.status),
    }));
    return {
        actionable: views.every((v) => v.verdict === 'satisfied'),
        premiseInvalidated: views.some((v) => v.verdict === 'invalidating'),
        blockers: views,
    };
}
/**
 * Resolve the current statuses of a set of blocker endpoints, batched — goals
 * from `harness_shared.goals` (workspace-scoped), issues from
 * `harness_shared.engineer_issues` (bare issue_id, the issue floor's own key).
 * Absent rows stay absent (status null ⇒ satisfied upstream). Keys are
 * `blockerStatusKey` composites.
 */
export async function resolveBlockerStatuses(sql, workspaceId, blockers) {
    const goalRefs = blockers.filter((b) => b.kind === GOAL_DEP_KIND).map((b) => b.ref);
    const issueRefs = blockers.filter((b) => b.kind === ISSUE_DEP_KIND).map((b) => b.ref);
    const out = new Map();
    if (goalRefs.length > 0) {
        const rows = await sql `
      SELECT id, status FROM harness_shared.goals
       WHERE workspace_id = ${workspaceId} AND id = ANY(${goalRefs}::text[])`;
        for (const r of rows)
            out.set(blockerStatusKey({ kind: GOAL_DEP_KIND, ref: r.id }), r.status);
    }
    if (issueRefs.length > 0) {
        // engineer_issues' lifecycle column is `state` (open/resolved/closed/done/dropped),
        // not `status` — normalized here into the shared status slot the verdict reads.
        const rows = await sql `
      SELECT issue_id, state FROM harness_shared.engineer_issues
       WHERE issue_id = ANY(${issueRefs}::text[])`;
        for (const r of rows) {
            out.set(blockerStatusKey({ kind: ISSUE_DEP_KIND, ref: r.issue_id }), r.state);
        }
    }
    return out;
}
/**
 * The one-call WRITE all three doors share (goals:create / goals:update /
 * goals:start — P-002): classify the caller's refs, verify every one RESOLVES
 * (the D-017 lesson: an unresolvable ref would sit absent ⇒ permanently
 * satisfied ⇒ a silently-inert edge that looks recorded and gates nothing —
 * refuse instead), run the acyclicity guard over the goal graph, then replace
 * the blocked-by set. Returns the problem as a MESSAGE (the kill-criterion
 * convention: every door surfaces it verbatim) or the applied endpoints.
 */
export async function applyGoalBlockedBy(sql, opts) {
    const blockers = opts.refs.map(classifyGoalBlockerRef).filter((b) => b.ref.length > 0);
    const statuses = await resolveBlockerStatuses(sql, opts.workspaceId, blockers);
    const unresolved = blockers.filter((b) => !statuses.has(blockerStatusKey(b)));
    if (unresolved.length > 0) {
        return {
            ok: false,
            problem: `blockedBy refs do not resolve: ${unresolved.map((b) => b.ref).join(', ')} — a goal id must ` +
                'match harness_shared.goals in this workspace and an issue ref must be a bare existing ' +
                'WI-/EI- id. An unresolvable blocker would read as permanently satisfied (silently inert), ' +
                'so it is refused rather than recorded.',
        };
    }
    if (blockers.some((b) => b.kind === GOAL_DEP_KIND && b.ref === opts.goalId)) {
        return { ok: false, problem: 'a goal cannot be blocked by itself' };
    }
    const edges = await readGoalBlockedByEdges(sql, opts.workspaceId);
    const goalBlockerRefs = blockers.filter((b) => b.kind === GOAL_DEP_KIND).map((b) => b.ref);
    if (goalBlockedByWouldCycle(edges, opts.goalId, goalBlockerRefs)) {
        return {
            ok: false,
            problem: 'blockedBy would create a dependency cycle in the goal graph — a goal cannot (transitively) ' +
                'block itself. Re-examine the decomposition: a cycle usually means two edges are really ' +
                'phases of one outcome (D-005), which belong INSIDE one goal as plans/tripwires.',
        };
    }
    await replaceGoalBlockedBy(sql, {
        workspaceId: opts.workspaceId,
        goalId: opts.goalId,
        blockers,
        createdBy: opts.createdBy ?? null,
    });
    return { ok: true, blockers };
}
/**
 * The one-call read most consumers want: `goalId`'s blockers with live statuses
 * and the folded readiness verdict. Two queries (edges + statuses), workspace-
 * scoped, derived on read (D-006).
 */
export async function readGoalReadiness(sql, workspaceId, goalId) {
    const edges = await readGoalBlockedByEdges(sql, workspaceId);
    const blockers = edges.get(goalId) ?? [];
    if (blockers.length === 0)
        return { actionable: true, premiseInvalidated: false, blockers: [] };
    const statuses = await resolveBlockerStatuses(sql, workspaceId, blockers);
    return goalReadiness(blockers.map((b) => ({ ...b, status: statuses.get(blockerStatusKey(b)) ?? null })));
}
