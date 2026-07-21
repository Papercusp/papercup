/**
 * Hard fleet-scope assignment admission (agent-operability P-016).
 *
 * A live fleet member may only receive work selected by its authoritative
 * per-member/inherited fleet claim spec. The boundary is enforced at every
 * assignment seam and is independent of the scheduler kill-switch. Existing
 * incompatible claims are quarantined by releasing them in one reconciliation
 * sweep and notifying the fleet leader.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { WorkItem } from '../work-items';
import type { ClaimSpecRecord } from './claim-spec-store';
import { resolveClaimSpecWorkspace } from './claim-spec-workspace';
import {
  matchesClaimSpecFilter,
  matchesWorkItemClaimSpec,
  type ClaimSpecSubject,
} from './claim-spec-match';
import { claimSpecFilterToClaimablePayloadFilter } from './claim-spec-payload-filter';

export interface FleetScopeContext {
  ownerId: string;
  fleetSlug: string;
  fleetRole: 'member';
  record: ClaimSpecRecord;
  /** EI-16710: the CONCRETE workspace this scope was resolved under (the same
   *  one `resolveFleetScopeContext` validated via `resolveClaimSpecWorkspace`
   *  before it would even return a non-null scope). Every scope-matching check
   *  must key off THIS value, never the ambient `activeWorkspaceId()` — see
   *  `featureMatchesRecord` for why. */
  workspaceId: string;
}

export type FleetScopeAdmission =
  | { allowed: true; scoped: false }
  | { allowed: true; scoped: true; scope: FleetScopeContext }
  | {
      allowed: false;
      scoped: true;
      code: 'fleet_scope_missing' | 'fleet_scope_violation' | 'fleet_winding_down';
      reason: string;
      scope: FleetScopeContext;
    };

/** Resolve only MEMBER scope. Leaders supervise fleets but do not consume their member lane. */
export async function resolveFleetScopeContext(
  ownerIdOrName: string,
  workspaceId?: string | null,
): Promise<FleetScopeContext | null> {
  // Lazy seams keep assignment-tool unit tests from loading the entire scheduler /
  // coord graph merely because they import a handler. The calls still reuse the
  // canonical stores; only module evaluation is deferred until admission is needed.
  const { latestFleetMembership } = await import('../fleet-membership-store');
  const { listFleetAssignments } = await import('../fleet/assignments');
  const ws = resolveClaimSpecWorkspace(workspaceId);
  // No specific workspace (null / '*' / empty) ⇒ no fleet-member scope to resolve.
  if (!ws) return null;
  let ownerId = ownerIdOrName;
  let membership = await latestFleetMembership(ws, ownerId).catch(() => null);

  // plan_items:assign addresses a stable agent-name. Resolve it through the
  // canonical assignment/presence view before consulting append-only membership.
  if (!membership?.fleetSlug) {
    const rows = await listFleetAssignments({ workspaceId: ws, agent: ownerIdOrName, activeOnly: true }).catch(() => []);
    const row = rows.find((r) => r.agentId && r.fleetSlug && r.fleetRole === 'member');
    if (row?.agentId) {
      ownerId = row.agentId;
      membership = { fleetSlug: row.fleetSlug ?? null, fleetRole: row.fleetRole ?? null };
    }
  }

  if (!membership?.fleetSlug || membership.fleetRole !== 'member') return null;
  const { getClaimSpecRecord } = await import('./claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: ownerId, workspaceId: ws });
  return { ownerId, fleetSlug: membership.fleetSlug, fleetRole: 'member', record, workspaceId: ws };
}

/**
 * EI-16710: takes `workspaceId` EXPLICITLY — never resolve it ambiently via
 * `activeWorkspaceId()` here. This function is reached through
 * `reconcileFleetScopeClaims`/`admitWorkItemForFleetTarget`, both of which
 * already threaded a caller-supplied, request-scoped workspaceId all the way
 * down to build `scope` — falling back to the process-ambient resolver at the
 * very last SQL call silently re-introduces the "wrong workspace" class
 * per-window-workspace-context (P-021) exists to kill: a caller whose request
 * carried the RIGHT workspace still gets evaluated against whatever
 * `activeWorkspaceId()` happens to resolve to (a different ALS layer, the
 * process-global default, ...), so a genuinely in-scope item spuriously
 * fails the match and reconcileFleetScopeClaims wrongly releases (and
 * re-arms the release-cooldown floor on) a fleet member's own valid claim —
 * every single call, since nothing about the mismatch ever self-corrects.
 */
async function featureMatchesRecord(
  item: WorkItem,
  record: ClaimSpecRecord,
  workspaceId: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const { compileFilter } = await import('./get-next');
  const filter = compileFilter(sql, record.spec.view.filter);
  const rows = await sql<{ matched: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${item.id}
         AND ${item.harness ? sql`harness_slug = ${item.harness}` : sql`TRUE`}
         AND ${filter}
    ) AS matched`;
  return Boolean(rows[0]?.matched);
}

async function itemMatchesScope(item: WorkItem, scope: FleetScopeContext): Promise<boolean> {
  if (item.family === 'feature') return featureMatchesRecord(item, scope.record, scope.workspaceId);
  return matchesWorkItemClaimSpec(item, scope.record.spec);
}

function denyMissing(scope: FleetScopeContext): FleetScopeAdmission {
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_missing',
    scope,
    reason:
      `fleet member ${scope.ownerId} belongs to '${scope.fleetSlug}' but has no explicit per-member or inherited fleet claim spec; ` +
      'assignment refused instead of falling through to the generic backlog',
  };
}

/**
 * EI-12832: while a fleet is paused (control_state='winding-down', set by
 * fleet:pause / fleet:wind-down), a member must NOT acquire NEW work — not via a
 * direct by-id claim, not via a leader/self assign, not via a self-select pull.
 *
 * The prior gap: the winding-down state floored the SELECT-side (get_next), but a
 * member parked on `events:await('work-item:claimable')` from before the pause
 * would still be woken by a peer's compliant stand-down release and then claim the
 * released item by id — the claim path only checked spec-match (in-spec ⇒ passed),
 * never the fleet's control state — so a release performed BECAUSE of the pause
 * recruited the next member (observed live 2026-07-15, fleet
 * nonp2p-bug-drain-0715).
 *
 * Consulting the durable registry control state (mig 575) at every fleet-scope
 * admission seam closes the class: a refusal here reaches work_items:claim,
 * plan_items:assign, and work_items:create's assign-on-create. Returns the loud,
 * leader-addressed refusal when winding-down, else null (allowed).
 *
 * FAIL-OPEN: an unresolvable workspace or a control-state read error returns null
 * (allowed). A registry-read hiccup must never wedge normal claiming — the pause
 * gate is a floor on new work, not a hard dependency of the claim path.
 */
export async function readFleetPauseState(
  scope: FleetScopeContext,
  workspaceId?: string | null,
): Promise<{ windingDown: boolean; reason: string | null }> {
  const ws = resolveClaimSpecWorkspace(workspaceId);
  if (!ws) return { windingDown: false, reason: null };
  const { getFleet } = await import('../agent-fleets-store');
  const fleet = await getFleet(ws, scope.fleetSlug).catch(() => null);
  if (fleet?.controlState !== 'winding-down') return { windingDown: false, reason: null };
  return { windingDown: true, reason: fleet.controlReason };
}

/** The admission-seam form: a loud, leader-addressed refusal when paused, else null. */
export async function fleetControlWindDownRefusal(
  scope: FleetScopeContext,
  workspaceId?: string | null,
): Promise<Extract<FleetScopeAdmission, { allowed: false }> | null> {
  const { windingDown, reason } = await readFleetPauseState(scope, workspaceId);
  if (!windingDown) return null;
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_winding_down',
    scope,
    reason:
      `fleet '${scope.fleetSlug}' is winding-down (paused${reason ? `: ${reason}` : ''}); ` +
      `member ${scope.ownerId} may not acquire NEW work until a fleet:resume (control_state=active) lands. ` +
      'A release performed as part of the stand-down must not recruit the next member',
  };
}

export async function admitWorkItemForFleetTarget(args: {
  target: string;
  workItemId: string;
  harness?: string;
  workspaceId?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  // EI-12832: a paused fleet's member takes no NEW work, whatever its spec says.
  const paused = await fleetControlWindDownRefusal(scope, args.workspaceId);
  if (paused) return paused;
  if (scope.record.source === 'default') return denyMissing(scope);
  const { getWorkItem } = await import('../work-items');
  const item = await getWorkItem(args.workItemId, args.harness);
  if (!item) return { allowed: true, scoped: true, scope }; // the claim seam returns not_found
  if (await itemMatchesScope(item, scope)) return { allowed: true, scoped: true, scope };
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    reason:
      `work-item ${item.id} does not match ${scope.record.spec.specId}@${scope.record.spec.revision} ` +
      `for fleet '${scope.fleetSlug}'`,
  };
}

export async function admitSubjectForFleetTarget(args: {
  target: string;
  subject: ClaimSpecSubject;
  workspaceId?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  // EI-12832: a paused fleet's member takes no NEW work, whatever its spec says.
  const paused = await fleetControlWindDownRefusal(scope, args.workspaceId);
  if (paused) return paused;
  if (scope.record.source === 'default') return denyMissing(scope);
  if (matchesClaimSpecFilter(args.subject, scope.record.spec.view.filter)) {
    return { allowed: true, scoped: true, scope };
  }
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    reason:
      `assignment does not match ${scope.record.spec.specId}@${scope.record.spec.revision} ` +
      `for fleet '${scope.fleetSlug}'`,
  };
}

/**
 * EI-18221674485894260: the CONCRETE, ready-to-run leader remedy for a fleet-scope
 * admission refusal. The prior notification said only "Re-steer the member's claim
 * spec or route the work elsewhere" — naming neither the TOOL nor the call shape, so
 * a leader who searched their toolset for the widen mechanism came up empty (the tool
 * DOES exist — `scheduler:set_claim_spec` — but ToolSearch/`tools:find` did not surface
 * it, and nothing in the refusal itself pointed at it), and every out-of-spec item then
 * needed manual leader intervention instead of a one-call re-steer. This turns the
 * refusal into that one-call widen action.
 *
 * Code-conditional: a `fleet_winding_down` refusal is NEVER widened — the fleet is
 * paused, so the member must stand down, and the remedy is `fleet:resume`, not a spec
 * bump. Pure (no I/O) so it is unit-testable and reused by the member-facing hint path.
 */
export function fleetScopeLeaderRemedy(
  admission: Extract<FleetScopeAdmission, { allowed: false }>,
): string {
  const fleetSlug = admission.scope.fleetSlug;
  if (admission.code === 'fleet_winding_down') {
    return (
      `This fleet is PAUSED (winding-down) — do NOT widen its claim spec; the member must stand down. ` +
      `When you intend it to resume, lift the pause: fleet:resume { fleet: "${fleetSlug}" }.`
    );
  }
  const spec = admission.scope.record?.spec;
  const specRef = spec?.specId ? `${spec.specId}@${spec.revision}` : 'the fleet lane (no authored spec yet — default)';
  return (
    `To let this member self-claim it, WIDEN the fleet lane in ONE call: ` +
    `scheduler:set_claim_spec { fleet: "${fleetSlug}", spec: { … a revision bump of ${specRef} ` +
    `whose view.filter admits this work } } — the member picks it up on its next scheduler:get_next, ` +
    `no re-dispatch. (Or route the work elsewhere / complete it yourself.)`
  );
}

export async function notifyFleetScopeRefusal(
  identity: AgentIdentity,
  admission: Extract<FleetScopeAdmission, { allowed: false }>,
  action: string,
): Promise<void> {
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  await sendMessage(identity, {
    to: [`@fleet-leader:${admission.scope.fleetSlug}`],
    summary: `fleet-scope admission blocked ${action}`,
    body: `${admission.reason}. The assignment was not mutated. ${fleetScopeLeaderRemedy(admission)}`,
    category: 'fleet-scope-admission',
  }).catch(() => undefined);
}

export interface FleetScopeReconciliation {
  scope: FleetScopeContext | null;
  quarantinedIds: string[];
}

/** Release every incompatible claim in one bounded sweep; never drip one per wake. */
export async function reconcileFleetScopeClaims(args: {
  ownerId: string;
  workspaceId?: string | null;
  identity?: AgentIdentity;
}): Promise<FleetScopeReconciliation> {
  const scope = await resolveFleetScopeContext(args.ownerId, args.workspaceId);
  if (!scope) return { scope: null, quarantinedIds: [] };
  const { listFleetAssignments } = await import('../fleet/assignments');
  const { getWorkItem, releaseWorkItem } = await import('../work-items');
  const rows = await listFleetAssignments({
    workspaceId: resolveClaimSpecWorkspace(args.workspaceId),
    agent: scope.ownerId,
    activeOnly: true,
  });
  const ids = [...new Set(rows.filter((r) => r.source === 'work_item_claim' && r.workItemId).map((r) => r.workItemId as string))];
  const quarantinedIds: string[] = [];
  for (const id of ids) {
    const item = await getWorkItem(id);
    const matches = item && scope.record.source !== 'default' ? await itemMatchesScope(item, scope) : false;
    if (matches) continue;
    const released = await releaseWorkItem(id, { expectedAssignee: scope.ownerId });
    if (released) quarantinedIds.push(id);
  }
  if (quarantinedIds.length > 0 && args.identity) {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    await sendMessage(args.identity, {
      to: [`@fleet-leader:${scope.fleetSlug}`],
      summary: `quarantined ${quarantinedIds.length} out-of-scope fleet claim(s)`,
      body:
        `Released in one reconciliation sweep from ${scope.ownerId}: ${quarantinedIds.join(', ')}. ` +
        `Authoritative scope is ${scope.record.spec.specId}@${scope.record.spec.revision}; re-steer or reassign deliberately.`,
      category: 'fleet-scope-admission',
    }).catch(() => undefined);
  }
  return { scope, quarantinedIds };
}

/**
 * EI-13520: result of {@link diagnoseFleetScopeCooldownMiss} — non-null only when the
 * scoped miss is (at least partly) explained by THIS bee's own release-cooldown floor,
 * not by the claim spec being genuinely empty.
 */
export interface CooldownMissDiagnosis {
  /** Rows that match spec + every OTHER floor and are excluded SPECIFICALLY by this
   *  bee's own release-cooldown floor (last_released_by = me AND still within the
   *  cooldown window) — i.e. the true SET DIFFERENCE between the with-cooldown and
   *  without-cooldown floors, not a bare without-cooldown count (WI-5303: the prior
   *  bare count over-attributed rows excluded by a different floor / a TOCTOU race
   *  to cooldown). */
  cooldownExcluded: number;
  /** Earliest cooldown expiry (ms since epoch) among this bee's own recently-released
   *  matching rows that are STILL within the cooldown window. Always non-null when
   *  cooldownExcluded > 0 (both are now computed from the same restricted row set —
   *  WI-5303: previously an unrestricted MIN could lock onto an already-expired
   *  release and report an expiry stuck in the past, i.e. a cooldownExpirySec of 0
   *  forever). */
  earliestExpiryMs: number | null;
  /** EI-16519: the work-item id whose `last_released_at` PRODUCES `earliestExpiryMs` —
   *  i.e. the argmin, not just the min. `last_released_at` is only ever written by an
   *  actual release-of-a-claimed-row (releaseWorkItem's UPDATE, gated on `taken_by IS
   *  NOT NULL` — see EI-16475's code trace + regression tests), so a SINGLE row's
   *  timestamp can never advance without a genuine re-claim+re-release of THAT row.
   *  When `cooldownExcluded > 1`, the reported `earliestExpiryMs` is a MIN over
   *  MULTIPLE different rows this bee released at different times — as the currently-
   *  earliest one ages out of the window, the MIN jumps to the next-earliest (a
   *  DIFFERENT row), which looks like "the cooldown clock keeps re-arming" but is
   *  ordinary multi-row churn from a bee that has released more than one in-spec row
   *  recently, not a livelock. Comparing `earliestRowId` across successive polls is the
   *  mechanical test: the SAME id with an advancing expiry is the genuine EI-14615
   *  livelock; a DIFFERENT id each poll is healthy churn, not a bug. Null only when
   *  cooldownExcluded is 0. */
  earliestRowId: string | null;
}

/**
 * EI-13520: best-effort tier-1 diagnosis for a fleet-scoped self-select MISS — does the
 * spec's primary feature-family view have candidate rows that would be admissible once
 * this bee's own release-cooldown floor (claimFloorsWhereSql's `cooldownAssignee` leg) is
 * dropped? When yes, the miss is a COOLDOWN artifact, not a scope/spec problem — re-authoring
 * the claim spec cannot fix it (see the fleet-livelock incident this closes: 6 agents thrashed
 * for hours re-authoring a spec that was never the cause).
 *
 * Scope of the check: the spec's TIER-1 view against `harness_features_consolidated`, the
 * SAME table + floors `getNextWorkItem`'s tier-1 attempt queries. Deliberately does not
 * replicate tiers 2/3 (the widened-kind or adjacent-issue-family fallbacks) — this is an
 * ANNOTATION on the already-failed claim, not a second claim attempt, so tier-1 fidelity is
 * enough to catch the dominant livelock shape (a bee's own just-released rows sorting back
 * to the top of a stable rank).
 *
 * WI-5303 fix: the row set is restricted, up front, to rows this bee itself released AND
 * that are still inside the cooldown window (`last_released_at >= now() - cooldown`) — the
 * exact predicate the WITH-cooldown floor uses to EXCLUDE a row. That makes `cnt` the true
 * set difference (rows the without-cooldown floor admits that the with-cooldown floor does
 * not, attributable to cooldown alone — not to a different floor or a race), and `earliest`
 * (MIN release time among only-still-active rows) can never lock onto an already-expired
 * release, so the derived `cooldownExpirySec` can never be stuck at 0 while cnt > 0.
 *
 * FAILS SOFT, same philosophy as `buildMissDiagnosis` (agent-tools/scheduler/get_next.ts):
 * any query error returns null — a diagnosis only ever annotates a miss, it must never be
 * able to turn a clean miss response into a thrown error.
 */
export async function diagnoseFleetScopeCooldownMiss(args: {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
  states?: string[];
}): Promise<CooldownMissDiagnosis | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const spec = args.scope.record.spec;
    if (!spec.view.filter) return null;
    const { sql } = getOrgPg();
    const { claimFloorsWhereSql, releaseCooldownSec } = await import('../work-items');
    const { compileFilter } = await import('./get-next');
    const cooldownSec = releaseCooldownSec();
    if (cooldownSec <= 0) return null;
    // The WITHOUT-cooldown leg: identical floors, `cooldownAssignee` simply omitted so
    // that clause compiles to `TRUE` (see claimFloorsWhereSql) instead of excluding this
    // bee's recently-released rows.
    const floorsNoCooldown = claimFloorsWhereSql(sql, {
      harness: args.harness,
      workspaceId: ws,
      states: args.states ?? spec.states,
    });
    const filter = compileFilter(sql, spec.view.filter);
    // WI-5303: restrict directly to the rows the WITH-cooldown floor would exclude for
    // THIS bee (self-released, still within the window) — same query, same filter, plus
    // the exact cooldown-exclusion predicate — instead of a bare without-cooldown count.
    // EI-16519: fetch feature_id alongside last_released_at (not a bare MIN aggregate)
    // so the argmin row is identifiable — a caller/leader can then tell "the SAME row
    // keeps re-arming" (genuine livelock) apart from "a DIFFERENT row is earliest each
    // poll" (ordinary churn across this bee's own multiple recent releases). `count(*)
    // OVER()` is computed over the FULL matching set before ORDER BY/LIMIT clip which
    // row is returned, so `cnt` stays the exact total (no under-count from the LIMIT 1)
    // while a single row round-trip gives us the argmin directly.
    const rows = await sql<{ feature_id: string; last_released_at: Date; cnt: number }[]>`
      SELECT feature_id, last_released_at, count(*) OVER()::int AS cnt
        FROM harness_shared.harness_features_consolidated
       WHERE ${floorsNoCooldown}
         AND ${filter}
         AND last_released_by = ${args.scope.ownerId}
         AND last_released_at IS NOT NULL
         AND last_released_at >= now() - make_interval(secs => ${cooldownSec})
       ORDER BY last_released_at ASC
       LIMIT 1`;
    const cnt = rows[0]?.cnt ?? 0;
    if (cnt === 0) return null;
    const earliest = rows[0]!.last_released_at;
    const earliestExpiryMs = new Date(earliest).getTime() + cooldownSec * 1000;
    return { cooldownExcluded: cnt, earliestExpiryMs, earliestRowId: rows[0]!.feature_id };
  } catch {
    return null;
  }
}

/**
 * WI-5561: the fleet-scoped sibling of `buildMissDiagnosis`'s EI-13965 aggregate floor
 * breakdown. A fleet MEMBER's `scheduler:get_next` miss never ran `aggregateIssueClaimExclusions`
 * at all (only a non-fleet caller did — `buildMissDiagnosis` short-circuits to an empty
 * diagnosis whenever `reconciliation.scope` is set), so a member scoped to an issue-family
 * `kind` filter (e.g. a bug-drain fleet's `{kind:'bug'}`) got a bare "no claimable work-item
 * matched fleet scope" with NO explanation — even when the true cause is a fully floor-gated
 * pool (confirmed live: fleet bug-drain-200k, 302 open+unclaimed+local bugs, ALL excluded by
 * legitimate floors — 169 federation-detector, 80 needs-human, 33 claim-hold, 21
 * observation-lane), not a scope/spec mismatch. Reuses the SAME `aggregateIssueClaimExclusions`
 * the non-fleet path already relies on — one source of truth, never a second implementation.
 * FAILS SOFT (same philosophy as `diagnoseFleetScopeCooldownMiss` / `buildMissDiagnosis`): any
 * error, or a spec whose filter matches ZERO issue-family rows at all (a genuine spec problem,
 * not a floor story), returns null and the miss degrades to the pre-existing bare message.
 */
export async function diagnoseFleetScopeIssueFloorMiss(args: {
  scope: FleetScopeContext;
  harness: string;
  workspaceId?: string | null;
  states?: string[];
  rigAvailable?: boolean;
}): Promise<import('./get-next').IssueClaimExclusionBreakdown | null> {
  try {
    const ws = resolveClaimSpecWorkspace(args.workspaceId);
    if (!ws) return null;
    const spec = args.scope.record.spec;
    const { aggregateIssueClaimExclusions } = await import('./get-next');
    const agg = await aggregateIssueClaimExclusions(spec.view.filter, {
      harness: args.harness,
      states: args.states ?? spec.states,
      assignee: args.scope.ownerId,
      rigAvailable: args.rigAvailable,
    });
    if (!agg || agg.matchedByFilter === 0) return null;
    return agg;
  } catch {
    return null;
  }
}

export function fleetScopedMiss(
  scope: FleetScopeContext,
  quarantinedIds: string[] = [],
  // EI-12832: when the miss is because the fleet is PAUSED (winding-down), the item
  // may well match the spec — the member just must not pull. Say so honestly instead
  // of the "no item matched scope" message (which would be actively misleading during
  // a pause), and give the stand-down (not the re-steer) advice.
  //
  // EI-13520: `cooldownDiag` (ignored while paused — the pause message already fully
  // explains the miss) reattributes a cooldown-only miss so the caller — and the fleet
  // leader they'd otherwise report a false spec problem to — is told the true cause.
  //
  // EI-14615: a cooldown-only miss also carries `cooldownExpiryAt` (the ABSOLUTE expiry
  // instant), and the advice distinguishes a NORMAL one-time cooldown (expiry holds
  // steady, re-poll and it clears) from a LIVELOCKED one (expiry keeps ADVANCING because
  // the fleet round-robin re-releases permanently-unfit rows faster than the window
  // lapses — the relative `~Ns` reads a perpetually-fresh ~300s and never clears). The
  // old advice told the member NOT to escalate; for the livelock case that was exactly
  // wrong — a leader spec-revision to exclude those rows is the only fix.
  // EI-15777: how many of the CALLER's own standing `work-item:claimable` idle-park
  // await(s) were just cancelled server-side as part of reporting this paused miss
  // (see the cancelClaimableAwaits call at both self-pull call sites). Only
  // meaningful while `paused` — a normal/cooldown miss must keep re-parking.
  opts?: {
    pausedReason?: string | null;
    cooldownDiag?: CooldownMissDiagnosis | null;
    claimableAwaitsCancelled?: number;
    /** WI-5561: the issue-family floor breakdown (see {@link diagnoseFleetScopeIssueFloorMiss}) —
     *  ignored while paused (the pause message already fully explains the miss), and only ever
     *  surfaced alongside (not instead of) the cooldown-only message when both are present. */
    issueBreakdown?: import('./get-next').IssueClaimExclusionBreakdown | null;
  },
) {
  const paused = opts?.pausedReason !== undefined;
  const cooldown = !paused ? (opts?.cooldownDiag ?? null) : null;
  // WI-5561: surfaced alongside the generic/cooldown message (never while paused — the pause
  // message already fully explains the miss).
  const breakdown = !paused ? (opts?.issueBreakdown ?? null) : null;
  // EI-15185: derive the ready-made `payload_filter` for a `work-item:claimable`
  // idle-park await from the member's OWN claim-spec view — the missing "how do I
  // scope this await" answer that led members to register an UNSCOPED await and
  // get woken on every system-wide release. `undefined` ⇒ the spec narrows only on
  // fields the claimable payload does not carry, so the advice below must NOT
  // recommend an unscoped await (the other half of the fix).
  const claimablePayloadFilter = claimSpecFilterToClaimablePayloadFilter(scope.record.spec.view.filter);
  const cooldownExpirySec = cooldown?.earliestExpiryMs != null ? Math.max(0, Math.round((cooldown.earliestExpiryMs - Date.now()) / 1000)) : null;
  // EI-14615: surface the ABSOLUTE cooldown expiry instant, not just the relative
  // `~Ns` (which is recomputed against Date.now() every poll and so reads the same
  // "~300s" whether the window is decaying normally OR being externally re-stamped).
  // A member can compare this absolute timestamp across successive polls: if it holds
  // steady the cooldown is decaying normally and will clear; if it keeps ADVANCING the
  // window is being re-stamped by the fleet round-robin re-releasing these rows faster
  // than the cooldown lapses (the livelock this ticket documents) — it will NEVER clear
  // on its own, and the do-not-escalate advice below is corrected to say so.
  const cooldownExpiryAt = cooldown?.earliestExpiryMs != null ? new Date(cooldown.earliestExpiryMs).toISOString() : null;
  return {
    ok: false as const,
    error: paused
      ? `fleet '${scope.fleetSlug}' is winding-down (paused${opts?.pausedReason ? `: ${opts.pausedReason}` : ''}); ` +
        'do NOT pull new work from this fleet\'s lanes — stand down until a fleet:resume (control_state=active) lands'
      : cooldown
        ? `${cooldown.cooldownExcluded} in-spec row(s) matched fleet scope ${scope.record.spec.specId}@${scope.record.spec.revision} ` +
          `but ${cooldown.cooldownExcluded === 1 ? 'is' : 'are'} excluded ONLY by YOUR OWN release-cooldown floor` +
          (cooldownExpirySec != null ? ` (earliest expiry in ~${cooldownExpirySec}s)` : '') +
          '; this is NOT a scope/spec mismatch — do not re-author the claim spec for this miss.'
        : `no claimable work-item matched fleet scope ${scope.record.spec.specId}@${scope.record.spec.revision}; ` +
          'the member was NOT allowed to fall through to the generic backlog',
    fleetScope: {
      fleet: scope.fleetSlug,
      specId: scope.record.spec.specId,
      revision: scope.record.spec.revision,
      source: scope.record.source,
    },
    quarantinedIds,
    windDown: true as const,
    // EI-15185: the ready-made payload_filter derived from THIS member's own claim
    // spec — present only when the spec can be narrowed over the claimable payload's
    // fields (id/kind/title/plan). Copy it verbatim into the idle-park await below.
    ...(claimablePayloadFilter ? { payloadFilter: claimablePayloadFilter } : {}),
    ...(paused ? { paused: true as const } : {}),
    // EI-15777: surface how many of the caller's OWN pre-pause `work-item:claimable`
    // idle-park await(s) were just cancelled — so the caller (and anyone reading the
    // response) can see the standing wake that would have fired on a peer's next
    // compliant release was actually retired, not merely refused-if-it-fires.
    ...(paused ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(cooldown ? { cooldownOnly: true as const, cooldownExcluded: cooldown.cooldownExcluded, cooldownExpirySec, cooldownExpiryAt, cooldownEarliestRowId: cooldown.earliestRowId } : {}),
    // WI-5561: the issue-family floor breakdown — present whenever the diagnosis ran and found
    // the spec's filter matches ≥1 issue-family row (a genuine scope/spec-empty miss keeps this
    // absent, same as the non-fleet buildMissDiagnosis breakdown it mirrors).
    ...(breakdown
      ? {
          excludedBreakdown: breakdown,
          excludedBreakdownSummary:
            `Your spec's filter matches ${breakdown.matchedByFilter} issue-family row(s); stranded by: ` +
            Object.entries(breakdown.excluded)
              .filter(([, n]) => (n as number) > 0)
              .sort((a, b) => (b[1] as number) - (a[1] as number))
              .map(([k, n]) => `${k}=${n}`)
              .join(', ') +
            ' (buckets are independent, a row can count under more than one; 0 candidates surviving ALL floors means the pool is genuinely floor-gated, not a scope/spec bug — re-authoring the claim spec will not help).',
        }
      : {}),
    advice: paused
      ? 'Fleet is paused (winding-down): finish only the atomic step in hand, work_items:checkpoint + release your claims/locks, loop:end any armed loop, and ack your leader. Do NOT re-park a work-item:claimable await while paused (any pre-pause await of yours was just cancelled server-side, EI-15777 — a peer\'s compliant release will no longer re-wake you for nothing). Resume normal pull cadence only after a fleet:resume cue.'
      : cooldown
        ? 'Cooldown-only miss (EI-13520): the row(s) excluding you are held off ONLY by your own recent-release cooldown (PAPERCUSP_RELEASE_COOLDOWN_SEC, default 300s), not a scope/spec mismatch — for a NORMAL one-time cooldown, re-poll ONCE after cooldownExpiryAt (or park on a work-item:claimable await) and the row clears (or any OTHER fleet member can claim it immediately); do NOT re-author the claim spec for that. ' +
          '`cooldownEarliestRowId` names the SPECIFIC row driving `cooldownExpirySec` — compare it, not just the number, across polls (EI-16519): a mere advancing/never-shrinking `~Ns` is NOT by itself a livelock signal — `last_released_at` can only change via a genuine release-of-a-claimed-row (EI-16475), so when `cooldownExcluded > 1` the reported expiry is a MIN over MULTIPLE rows YOU released at different times, and it legitimately jumps to a LATER instant as the earlier one ages out and a fresher row becomes the new earliest (ordinary churn from actively completing/releasing several in-spec items, not a bug — keep polling, no escalation needed). Only escalate to your leader as a genuine EI-14615 livelock when `cooldownEarliestRowId` stays the SAME id across successive polls while its expiry keeps advancing — that combination is the one that cannot happen without something repeatedly re-claiming and re-releasing that exact row out from under you.'
        : breakdown
          ? 'This is a FLOOR-GATED miss (WI-5561), not a scope/spec mismatch — see `excludedBreakdownSummary` for which floors (federation-detector / needs-human / claim-hold / observation-lane / …) are excluding your spec\'s matched rows. Checkpoint, release, loop:end, and report the breakdown to your fleet leader — a floor-gated pool needs a DIFFERENT lane/scope (or the gating condition itself resolved by whoever owns it), not a claim-spec re-author. ' +
            (claimablePayloadFilter
              ? 'You may still park ONE events:await { event: "work-item:claimable", payload_filter: <the `payloadFilter` returned in this response>, timeout_sec: 1800 } in case a floor lifts (a claim-hold clears, a needs-human item gets picked up) and end your turn.'
              : 'Do NOT park an UNSCOPED work-item:claimable await — it would fire on every system-wide release for nothing (EI-15185).')
          : claimablePayloadFilter
            ? 'Checkpoint any atomic progress, release remaining lane resources, and call loop:end. To be woken ONLY on work your spec could admit (EI-15185), park ONE events:await { event: "work-item:claimable", payload_filter: <the `payloadFilter` returned in this response>, timeout_sec: 1800 } and end your turn — it is derived from your own claim spec\'s view, so it fires only on in-scope items instead of every system-wide release; the ~30-min on_timeout backstops a missed emit. The wake is a HINT: scheduler:get_next stays the authoritative claim (a re-miss just re-registers the await).'
            : 'Checkpoint any atomic progress, release remaining lane resources, call loop:end, and report the scoped miss to the fleet leader. Do NOT park an UNSCOPED work-item:claimable await — your spec narrows only on fields the claimable event payload does not carry, so an unscoped await would fire (and waste a full wake) on every system-wide release (EI-15185). Resume only after a claim-spec revision or a leader/inbox wake.',
  };
}
