/**
 * flow-metrics.ts — FLOW (not stock) metrics for the self-improvement loop
 * (learning-system-audit-improvements-2026-06-09 P-041).
 *
 * The Learning tab's scoreboard counts STOCKS (total captured / open / resolved)
 * — numbers that only ever grow and say nothing about whether the loop is
 * actually cycling. This module computes the FLOWS:
 *
 *   - `captured7d` / `resolved7d` — items created vs resolved/closed in the
 *     trailing 7 days. Resolution time is approximated by `updatedAt` on a
 *     resolved/closed item (the lifecycle write IS the state transition — same
 *     approximation the recurrence-decay clock uses, see digest.ts).
 *   - `medianOpenAgeDays` — is the open backlog fresh churn or sediment?
 *   - `recurringSignatureCount` — passed through from the digest's
 *     `recurringSignatures` (computed once there — NOT re-derived here).
 *   - `watchdog` — is the hard feed-in alive? last tick + ticks/captures in 24h.
 *
 * `computeImprovementFlow` is PURE over injected rows (unit-testable without
 * PG); `readWatchdogFlowTicks` is the thin PG read beside it, using the same
 * `getOrgPg()` access the neighboring watchdog readers use.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ImprovementCandidate } from './policy';
import type { DispatchStats } from './dispatch-ledger';
import { readAgentReviewState, verificationConflict, verificationParties } from './agent-review-policy';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { PullLedgerRow } from '../../agent-tools/scheduler/pull_ledger';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentReviewTiming {
  /** Each age has its own writer/basis; null means missing, invalid or ambiguous. */
  reportAgeMs: number | null;
  ledgerRouteAgeMs: number | null;
  reviewWaitMs: number | null;
  revisionAgeMs: number | null;
  admissionDelayMs: number | null;
  enteredAt: string | null;
  round: number | null;
  reviewTimeUnknown: 'no-review' | 'missing-round-time' | 'round-mismatch' | 'invalid-round-time' | null;
}

/** P-030: first routing time is NOT current-round review entry, even on round one. */
export function computeAgentReviewTiming(input: {
  payload: unknown;
  createdAt?: string | null;
  reviewRoutedAtMs: number | null;
  nowMs: number;
}): AgentReviewTiming {
  const object = (x: unknown): Record<string, unknown> =>
    x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
  const payload = object(input.payload);
  const instant = (x: unknown): number | null => {
    if (typeof x !== 'string' || !x.trim()) return null;
    const ms = Date.parse(x);
    return Number.isFinite(ms) && ms >= 0 && ms <= input.nowMs ? ms : null;
  };
  const age = (ms: number | null): number | null => ms == null ? null : input.nowMs - ms;
  const admission = object(payload.admissionReview);
  const admissionEntry = instant(admission.enteredAt);
  const admissionEnd = instant(admission.terminalAt);
  const review = readAgentReviewState(payload);
  const timing = object(object(payload.agentReview).timing);
  const enteredMs = instant(timing.enteredAt);
  const decidedMs = instant(timing.decidedAt);
  const decisionValid = decidedMs != null && enteredMs != null && decidedMs >= enteredMs;
  const reviewTimeUnknown = !review ? 'no-review'
    : !Object.keys(timing).length ? 'missing-round-time'
    : timing.round !== review.round ? 'round-mismatch'
    : enteredMs == null || (review.status === 'pending'
        ? timing.decidedAt !== undefined
        : !decisionValid) ? 'invalid-round-time'
    : null;
  const valid = reviewTimeUnknown === null;
  const routed = input.reviewRoutedAtMs;
  return {
    reportAgeMs: age(instant(input.createdAt)),
    ledgerRouteAgeMs: age(typeof routed === 'number' && Number.isFinite(routed) && routed >= 0 && routed <= input.nowMs ? routed : null),
    reviewWaitMs: valid ? (review!.status === 'pending' ? input.nowMs : decidedMs!) - enteredMs! : null,
    revisionAgeMs: valid && review!.status === 'revision-requested' ? age(decidedMs) : null,
    admissionDelayMs: admissionEntry != null && admissionEnd != null && admissionEnd >= admissionEntry
      ? admissionEnd - admissionEntry : null,
    enteredAt: valid ? new Date(enteredMs!).toISOString() : null,
    round: review?.round ?? null,
    reviewTimeUnknown,
  };
}

export interface AgentReviewServiceScope {
  workspaceId: string;
  harnessSlug: string;
  sinceMs: number;
  nowMs: number;
  /** The measured worker roster, not every agent or human who happened to grade an idea. */
  verifierIds: readonly string[];
  verificationSpecs: readonly { specId: string; revision: number }[];
}

export interface AgentReviewServiceRow {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  state: string;
  payload: unknown;
  createdAt: string | null;
  reviewRoutedAtMs: number | null;
  ledger: { ideaId: string; routedRef: string; grade: number | null; gradedBy: string | null } | null;
}

/** A census of CURRENT review rounds. Overwritten earlier rounds are explicitly unmeasured.
 * A dispatch's status=ok is never an outcome: use the scheduler's recorded disposition,
 * including a late settlement, and the lifecycle decision corroborated by its grade ledger.
 */
export function computeAgentReviewService(
  scope: AgentReviewServiceScope,
  rows: readonly AgentReviewServiceRow[],
  pulls: readonly (PullLedgerRow & { workspaceId: string })[],
) {
  if (!Number.isFinite(scope.sinceMs) || !Number.isFinite(scope.nowMs) || scope.sinceMs > scope.nowMs) {
    throw new Error('Invalid review service window');
  }
  const inWindow = (ms: number) => Number.isFinite(ms) && ms >= scope.sinceMs && ms <= scope.nowMs;
  const workers = new Set(scope.verifierIds);
  const specs = new Set(scope.verificationSpecs.map(s => `${s.specId}@${s.revision}`));
  let currentRounds = 0, arrivals = 0, arrivalsUnknown = 0, priorRoundsUnmeasured = 0;
  let pending = 0, pendingTimingUnknown = 0, overdueKnown = 0, outcomesUnknown = 0;
  let oldestKnownPendingWaitMs: number | null = null;
  const outcomes = { approved: 0, revisionRequested: 0 };
  for (const row of rows) {
    if (row.workspaceId !== scope.workspaceId || row.harnessSlug !== scope.harnessSlug) continue;
    const review = readAgentReviewState(row.payload);
    if (!review) continue;
    currentRounds++;
    priorRoundsUnmeasured += review.round - 1;
    const timing = computeAgentReviewTiming({ ...row, nowMs: scope.nowMs });
    if (timing.enteredAt === null) arrivalsUnknown++;
    else if (inWindow(Date.parse(timing.enteredAt))) arrivals++;
    if (review.status === 'pending' && !ANY_FAMILY_TERMINAL_STATES.includes(row.state)) {
      pending++;
      if (timing.reviewWaitMs === null) pendingTimingUnknown++;
      else {
        oldestKnownPendingWaitMs = Math.max(oldestKnownPendingWaitMs ?? 0, timing.reviewWaitMs);
        if (timing.reviewWaitMs >= DAY_MS) overdueKnown++;
      }
    }
    if (review.status === 'pending') continue;
    if (timing.reviewWaitMs === null) { outcomesUnknown++; continue; }
    if (!inWindow(Date.parse(review.timing!.decidedAt!))) continue;
    const ledger = row.ledger;
    if (!ledger || ledger.ideaId !== review.ledgerIdeaId || ledger.routedRef !== `wi:${row.id}` ||
        ledger.grade === null || !Number.isInteger(ledger.grade) || ledger.grade < 1 || ledger.grade > 5 ||
        !ledger.gradedBy || !workers.has(ledger.gradedBy) ||
        verificationConflict(verificationParties({ payload: row.payload }), ledger.gradedBy) !== null ||
        (review.status === 'approved' ? ledger.grade < 4 : ledger.grade > 3)) {
      outcomesUnknown++;
      continue;
    }
    if (review.status === 'approved') outcomes.approved++;
    else outcomes.revisionRequested++;
  }
  let attempts = 0, claimed = 0, noClaim = 0, pickupUnknown = 0, unscopedPickupAttempts = 0;
  const noClaimReasons: Record<string, number> = {};
  for (const pull of pulls) {
    if (pull.workspaceId !== scope.workspaceId || pull.harness !== scope.harnessSlug ||
        !pull.bee || !workers.has(pull.bee) || !inWindow(Date.parse(pull.at))) continue;
    if (!pull.specId || pull.revision === null) { unscopedPickupAttempts++; continue; }
    if (!specs.has(`${pull.specId}@${pull.revision}`)) continue;
    attempts++;
    const late = pull.lateSettlement;
    if (late) {
      if (!inWindow(Date.parse(late.settledAt)) || late.kind === 'rejected-unknown') pickupUnknown++;
      else if (late.kind === 'claimed') claimed++;
      else { noClaim++; noClaimReasons['late-no-claim'] = (noClaimReasons['late-no-claim'] ?? 0) + 1; }
    } else if (pull.disposition === 'claimed' && pull.item) claimed++;
    else if (pull.disposition === 'no-claim') {
      noClaim++;
      const reason = pull.reason ?? 'reason-unrecorded';
      noClaimReasons[reason] = (noClaimReasons[reason] ?? 0) + 1;
    } else pickupUnknown++;
  }
  return { scope, basis: 'current-review-rounds' as const, currentRounds, arrivals, arrivalsUnknown,
    priorRoundsUnmeasured, pending, pendingTimingUnknown, overdueKnown,
    oldestKnownPendingWaitMs,
    oldestPendingWaitMs: pendingTimingUnknown ? null : oldestKnownPendingWaitMs,
    outcomes: workers.size ? outcomes : null, outcomesUnknown,
    pickups: workers.size && specs.size ? { attempts, claimed, noClaim, unknown: pickupUnknown, noClaimReasons } : null,
    unscopedPickupAttempts };
}

/** Complete scoped census before serialization; no display LIMIT can change these totals. */
export async function readAgentReviewService(scope: AgentReviewServiceScope) {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{
      id: string; state: string; payload: unknown; created_ts: number | null;
      idea_id: string | null; routed_ref: string | null; routed_at: number | null;
      human_grade: number | null; graded_by: string | null;
    }[]>`
      SELECT wi.feature_id AS id, wi.status AS state, wi.payload, wi.created_ts,
             l.idea_id, l.routed_ref, l.routed_at, l.human_grade, l.graded_by
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.scout_routed_ideas l
          ON l.workspace_id = wi.workspace_id AND l.harness_slug = wi.harness_slug
         AND l.idea_id = wi.payload #>> '{agentReview,ledgerIdeaId}'
       WHERE wi.workspace_id = ${scope.workspaceId} AND wi.harness_slug = ${scope.harnessSlug}
         AND jsonb_typeof(wi.payload -> 'agentReview') = 'object'`;
    const pulls = await sql<{
      invoked_at: Date; coord_owner_id: string | null; harness_slug: string; status: string;
      duration_ms: number | null; disposition: unknown; late_settlement: unknown;
    }[]>`
      SELECT invoked_at, coord_owner_id, harness_slug, status, duration_ms,
             metadata_json -> 'schedulerDisposition' AS disposition,
             metadata_json -> 'schedulerLateSettlement' AS late_settlement
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
         AND tool_name = 'scheduler:get_next' AND coord_owner_id = ANY(${[...scope.verifierIds]}::text[])
         AND invoked_at >= ${new Date(scope.sinceMs)} AND invoked_at <= ${new Date(scope.nowMs)}`;
    const { pullLedgerRowFromInvocation } = await import('../../agent-tools/scheduler/pull_ledger');
    return { status: 'known' as const, ...computeAgentReviewService(scope, rows.map(row => ({
      id: row.id, state: row.state, payload: row.payload, workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      createdAt: row.created_ts === null ? null : new Date(Number(row.created_ts)).toISOString(),
      reviewRoutedAtMs: row.routed_at === null ? null : Number(row.routed_at),
      ledger: row.idea_id && row.routed_ref ? { ideaId: row.idea_id, routedRef: row.routed_ref,
        grade: row.human_grade === null ? null : Number(row.human_grade), gradedBy: row.graded_by } : null,
    })), pulls.map(pull => ({ workspaceId: scope.workspaceId,
      ...pullLedgerRowFromInvocation({ ...pull, invoked_at: new Date(pull.invoked_at).toISOString() }),
    }))) };
  } catch {
    return { status: 'unknown' as const, scope, reason: 'service-read-failed' as const };
  }
}

/** Minimal watchdog tick row the flow rollup needs (injected — see readWatchdogFlowTicks). */
export interface WatchdogFlowTick {
  /** tick_at, epoch ms. */
  tickAtMs: number;
  /** How many improvements that tick captured (length of the `captured` id array). */
  capturedCount: number;
}

export interface ImprovementFlow {
  /** Items created in the trailing 7 days. */
  captured7d: number;
  /** Items whose state is resolved/closed AND whose last update is in the trailing 7 days. */
  resolved7d: number;
  /** captured7d − resolved7d. Positive = the backlog grew this week. */
  net7d: number;
  /** Median age (days, 0.1 precision) of the OPEN items; null when nothing is open. */
  medianOpenAgeDays: number | null;
  /** Count of recurring friction signatures — from digest.recurringSignatures (reused, not re-derived). */
  recurringSignatureCount: number;
  watchdog: {
    /** ISO timestamp of the most recent tick, or null if the watchdog never ticked. */
    lastTickAt: string | null;
    /** Ticks in the trailing 24h. */
    ticks24h: number;
    /** Improvements captured by ticks in the trailing 24h. */
    captured24h: number;
  };
  /**
   * Auto-implement dispatch ledger rollup (consume-edges P-010 / B-04) — is the
   * BACK edge cycling (fired vs actually fixed, in-progress vs presumed-dead)?
   * Computed once in dispatch-ledger.ts and passed through (not re-derived
   * here, same rule as recurringSignatureCount); null when the ledger read
   * failed or wasn't attempted.
   */
  dispatch: DispatchStats | null;
}

function parseMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ComputeImprovementFlowOptions {
  /** Now, in ms — passed for deterministic tests; the resolver passes Date.now(). */
  nowMs?: number;
  /** digest.recurringSignatures.length — the digest already computed it; pass it through. */
  recurringSignatureCount?: number;
  /** computeDispatchStats(...) over the ledger read — passed through, not re-derived. */
  dispatchStats?: DispatchStats | null;
}

/**
 * Pure flow rollup over the candidate + watchdog-tick rows. Deterministic given
 * `nowMs`; no PG, no clock reads.
 */
export function computeImprovementFlow(
  candidates: ImprovementCandidate[],
  ticks: WatchdogFlowTick[],
  opts: ComputeImprovementFlowOptions = {},
): ImprovementFlow {
  const nowMs = opts.nowMs ?? Date.now();
  const weekStart = nowMs - 7 * DAY_MS;
  const dayStart = nowMs - DAY_MS;

  let captured7d = 0;
  let resolved7d = 0;
  const openAges: number[] = [];
  for (const c of candidates) {
    const createdMs = parseMs(c.createdAt);
    if (createdMs !== null && createdMs >= weekStart && createdMs <= nowMs) captured7d += 1;

    const state = c.state ?? 'open';
    if (state === 'open') {
      if (createdMs !== null) openAges.push(Math.max(0, (nowMs - createdMs) / DAY_MS));
      continue;
    }
    // resolved/closed — approximate the resolution time by the last lifecycle
    // update (updated_at), same clock the recurrence-decay matcher reads.
    const resolvedMs = parseMs(c.updatedAt) ?? createdMs;
    if (resolvedMs !== null && resolvedMs >= weekStart && resolvedMs <= nowMs) resolved7d += 1;
  }
  openAges.sort((a, b) => a - b);
  const med = median(openAges);

  let lastTickMs: number | null = null;
  let ticks24h = 0;
  let captured24h = 0;
  for (const t of ticks) {
    if (lastTickMs === null || t.tickAtMs > lastTickMs) lastTickMs = t.tickAtMs;
    if (t.tickAtMs >= dayStart && t.tickAtMs <= nowMs) {
      ticks24h += 1;
      captured24h += t.capturedCount;
    }
  }

  return {
    captured7d,
    resolved7d,
    net7d: captured7d - resolved7d,
    medianOpenAgeDays: med === null ? null : Math.round(med * 10) / 10,
    recurringSignatureCount: opts.recurringSignatureCount ?? 0,
    watchdog: {
      lastTickAt: lastTickMs === null ? null : new Date(lastTickMs).toISOString(),
      ticks24h,
      captured24h,
    },
    dispatch: opts.dispatchStats ?? null,
  };
}

/**
 * PG read for the watchdog half of the flow: the most recent tick rows
 * (tick_at + captured count), newest-first. Bounded — the watchdog ticks
 * ~96/day/host and rows are retention-pruned, so the cap comfortably covers
 * the 24h window while still carrying the true last tick even when it's old.
 */
export async function readWatchdogFlowTicks(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<WatchdogFlowTick[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 2000);
  const rows = await sql<{ tick_at: Date | string; captured_count: number }[]>`
    SELECT tick_at, COALESCE(array_length(captured, 1), 0) AS captured_count
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows
    .map((r) => ({
      tickAtMs: r.tick_at instanceof Date ? r.tick_at.getTime() : Date.parse(String(r.tick_at)),
      capturedCount: Number(r.captured_count) || 0,
    }))
    .filter((t) => !Number.isNaN(t.tickAtMs));
}
