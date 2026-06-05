/**
 * plan-item liveness + the claim POLICY coordinator + the merged view.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 2 + Phase 3 view).
 *
 * Three things live here, all sitting ABOVE the low-level lease (claims.ts):
 *
 *  1. LIVENESS MODE (D-003) — `harnessLivenessMode`. A LOCAL harness uses
 *     'availability' (an idle claim only hurts its owner → held while the session is
 *     alive); a SHARED harness uses 'activity' (an idle claim blocks all members →
 *     the lease renews on a completed turn / explicit extend, and lapses on
 *     inactivity). Shared-ness is resolved from harness membership (>1 contributor),
 *     behind a SEAM `setHarnessSharedResolver` that su-584a8's per-user-identity /
 *     harness-membership model swaps in. Default LOCAL — correct on a single box.
 *
 *  2. CLAIM POLICY (D-004/D-005) — `claimPlanItem`. The interplay of the two stores:
 *     an ASSIGNED item may only be claimed by its assignee-NAME (even when currently
 *     unclaimed/lapsed — the assignment anchors it, so a sleeper's work is never
 *     stolen); an UNASSIGNED item is a pool pull, gated by work-group membership when
 *     a work-group is declared (cross-user) and open otherwise (single-user/local).
 *
 *  3. THE MERGED VIEW (Risks: assignment/claim drift) — `mergedPlanItemStates` /
 *     `myItemsWithState`. Assignment (federated source of truth) + claim (authority
 *     source of truth) merged into one coherent per-item disposition.
 */
import { getOrgPg } from '@papercusp/db-org';
import { readPlanBySlug } from '../agent-tools/plans/source';
import {
  getAssignment,
  listAssignmentsForName,
  listAssignmentsForPlan,
  type PlanItemAssignment,
} from './assignments';
import {
  acquireClaim,
  getClaim,
  listClaimsForPlan,
  type PlanItemClaim,
  type LivenessMode,
} from './claims';
import { workGroupExists, isWorkGroupMember } from './work-group';

// ── 1. Liveness mode (shared-ness) ──────────────────────────────────────────────

export type HarnessSharedResolver = (workspaceId: string, harnessSlug: string) => Promise<boolean>;

async function defaultSharedResolver(workspaceId: string, harnessSlug: string): Promise<boolean> {
  // A harness is SHARED if >1 distinct contributor (github user) participates in it.
  // This is the v1 heuristic; su-584a8's harness-membership model is the real answer.
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(DISTINCT github_user_id)::int AS n
        FROM harness_shared.contributors
       WHERE harness_slug = ${harnessSlug}
         AND (${workspaceId === '*'} OR workspace_id = ${workspaceId})
    `;
    return (rows[0]?.n ?? 0) > 1;
  } catch {
    return false; // unknown → LOCAL (availability)
  }
}

let sharedResolver: HarnessSharedResolver = defaultSharedResolver;

/** Swap in a real harness-shared resolver (su-584a8's membership model). */
export function setHarnessSharedResolver(r: HarnessSharedResolver): void {
  sharedResolver = r;
}
export function resetHarnessSharedResolver(): void {
  sharedResolver = defaultSharedResolver;
}

/** The liveness mode for a harness: 'activity' if SHARED, else 'availability' (LOCAL). */
export async function harnessLivenessMode(workspaceId: string, harnessSlug: string): Promise<LivenessMode> {
  return (await sharedResolver(workspaceId, harnessSlug)) ? 'activity' : 'availability';
}

// ── 2. Claim policy coordinator ─────────────────────────────────────────────────

export interface ClaimPlanItemOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  ownerUser: string;
  intent?: string;
  /** Force a mode (tests / explicit). Default: resolved from harness shared-ness. */
  livenessMode?: LivenessMode;
  ttlSec?: number;
}

export type ClaimPlanItemResult =
  | { status: 'claimed'; claim: PlanItemClaim; mode: LivenessMode; viaAssignment: boolean }
  | { status: 'conflict'; conflict: PlanItemClaim }
  | { status: 'refused'; reason: string; assignee?: string };

/**
 * Take the live claim on a plan item, enforcing the assignment + work-group policy,
 * then leasing via the authority-mediated store.
 */
export async function claimPlanItem(opts: ClaimPlanItemOpts): Promise<ClaimPlanItemResult> {
  const mode = opts.livenessMode ?? (await harnessLivenessMode(opts.workspaceId, opts.harnessSlug));
  const assignment = await getAssignment(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);

  let viaAssignment = false;
  if (assignment?.assigneeName) {
    // Assigned → only the assignee-NAME may claim, even when currently unclaimed/lapsed (D-004).
    if (!opts.ownerName || opts.ownerName !== assignment.assigneeName) {
      return {
        status: 'refused',
        reason: `plan item ${opts.itemId} is assigned to '${assignment.assigneeName}' — only that agent-name may claim it`,
        assignee: assignment.assigneeName,
      };
    }
    viaAssignment = true;
  } else {
    // Unassigned → a pool pull. Gate cross-user pulls on work-group membership; a
    // plan with no declared work-group is open (single-user / local, D-005).
    if (await workGroupExists(opts.workspaceId, opts.harnessSlug, opts.planSlug)) {
      const member = await isWorkGroupMember(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.ownerUser);
      if (!member) {
        return {
          status: 'refused',
          reason: `plan item ${opts.itemId} is unassigned and this plan has a work-group — join it to pull (plan_items:join_group)`,
        };
      }
    }
  }

  const res = await acquireClaim({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    owner: opts.owner,
    ownerLabel: opts.ownerLabel,
    ownerName: opts.ownerName,
    intent: opts.intent,
    livenessMode: mode,
    ttlSec: opts.ttlSec,
  });
  if (res.ok) return { status: 'claimed', claim: res.claim, mode, viaAssignment };
  return { status: 'conflict', conflict: res.conflict };
}

// ── 3. The merged per-item view ─────────────────────────────────────────────────

export type PlanItemDisposition =
  | 'pooled' // unassigned + no live claim → open to pull
  | 'assigned-idle' // assigned + no live claim → awaiting its assignee (or lapsed back to it)
  | 'active' // assigned + live claim held by the assignee
  | 'claimed-pooled' // unassigned + live claim → pulled from the pool
  | 'claimed-mismatch'; // assigned + live claim held by someone who is NOT the assignee (drift)

export interface MergedPlanItemState {
  itemId: string;
  /** The plan item's effective status (todo/wip/…); null if the id isn't in the plan (orphan record). */
  itemStatus: string | null;
  disposition: PlanItemDisposition;
  assignment: PlanItemAssignment | null;
  /** The live claim (a lapsed/expired claim is reported as null — it no longer holds). */
  claim: PlanItemClaim | null;
  inPlan: boolean;
}

function disposition(assignment: PlanItemAssignment | null, liveClaim: PlanItemClaim | null): PlanItemDisposition {
  const assignee = assignment?.assigneeName ?? null;
  if (liveClaim) {
    if (!assignee) return 'claimed-pooled';
    return liveClaim.ownerName === assignee ? 'active' : 'claimed-mismatch';
  }
  return assignee ? 'assigned-idle' : 'pooled';
}

/** Per-item merged disposition for every item in a plan (+ any orphan assignment/claim records). */
export async function mergedPlanItemStates(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<MergedPlanItemState[]> {
  const read = await readPlanBySlug(planSlug, { harnessSlug });
  const planItems = read
    ? read.row.items.length > 0
      ? read.row.items.map((i) => ({ id: i.id, status: i.status }))
      : read.parsed.items.map((i) => ({ id: i.id, status: i.storedStatus as string }))
    : [];

  const [assignments, claims] = await Promise.all([
    listAssignmentsForPlan(workspaceId, harnessSlug, planSlug),
    listClaimsForPlan(workspaceId, harnessSlug, planSlug),
  ]);
  const aByItem = new Map(assignments.map((a) => [a.itemId, a]));
  const cByItem = new Map(claims.map((c) => [c.itemId, c]));

  const ids = new Set<string>();
  for (const i of planItems) ids.add(i.id);
  for (const a of assignments) ids.add(a.itemId);
  for (const c of claims) ids.add(c.itemId);

  const planStatus = new Map(planItems.map((i) => [i.id, i.status] as const));
  const out: MergedPlanItemState[] = [];
  for (const id of [...ids].sort()) {
    const assignment = aByItem.get(id) ?? null;
    const claimRow = cByItem.get(id) ?? null;
    const liveClaim = claimRow && !claimRow.expired ? claimRow : null;
    out.push({
      itemId: id,
      itemStatus: planStatus.has(id) ? (planStatus.get(id) ?? null) : null,
      disposition: disposition(assignment, liveClaim),
      assignment,
      claim: liveClaim,
      inPlan: planStatus.has(id),
    });
  }
  return out;
}

export interface MyItemState {
  assignment: PlanItemAssignment;
  claim: PlanItemClaim | null;
  disposition: PlanItemDisposition;
}

/** Active assignments to an agent-name across all plans, each with its live claim state. */
export async function myItemsWithState(workspaceId: string, agentName: string): Promise<MyItemState[]> {
  const assignments = await listAssignmentsForName(workspaceId, agentName);
  const out: MyItemState[] = [];
  for (const a of assignments) {
    const claimRow = await getClaim(workspaceId, a.harnessSlug, a.planSlug, a.itemId);
    const liveClaim = claimRow && !claimRow.expired ? claimRow : null;
    out.push({ assignment: a, claim: liveClaim, disposition: disposition(a, liveClaim) });
  }
  return out;
}
