/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): grade-the-grader.
 * The plan-ship verification pattern (audit + rubric grade, grader ≠ author) extends
 * to GRADE mode itself: a TERMINAL scorecard against a standard rubric stays
 * audit-pending until a NON-AUTHOR auditor grades the grading against the
 * grading-integrity meta-rubric. Three D-004 bounds, enforced structurally here:
 *   1. ONE level — the audit card itself (rubricRef === GRADING_INTEGRITY_RUBRIC_REF)
 *      is never stamped pending, so nobody grades the auditor.
 *   2. TERMINAL cards only — a provisional card is already excluded as a working
 *      note; stamping it too would double-bucket (see needsGradingAudit).
 *   3. Sampled evidence re-runs are the AUDIT's method (rubric criteria), not a
 *      code path here.
 */

import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import launchAgentTool from './agent-tools/capability/launch-agent';
import {
  detectAcceptanceGraderTerminalFailure,
  readAcceptanceGraderLogTail,
  type AcceptanceGraderTerminalFailureCode,
} from './acceptance-grader';
import { getRubric } from './rubrics';
import { listScorecards, type ScorecardGradingAuditCurrentness, type ScorecardRow } from './scorecards';
import { killTask } from './task-manager/control';
import { resolveIssueWorkspace } from './issues-engineer';
import { boundedOrgTxn } from './pg-bounded-txn';
import type { OrgSql } from './work-items';
import { listLoopStanddownOwners } from './harness/routines/release-pause-ttl';
import { routeSourceGradingAudit } from './grading-audit-routing';
import { getTask, listTasks } from './task-manager/store';
import { isTerminalState } from './task-manager/types';

/** The meta-rubric every grading audit grades against (proposed by P-013). */
export const GRADING_INTEGRITY_RUBRIC_REF = 'grading-integrity';

/**
 * Keep every trigger bounded. A pending card is already a durable queue entry;
 * a scorecard emit or completion refusal must not turn one caller into an
 * unbounded fan-out when a historical backlog is present.
 */
export const GRADING_AUDIT_DISPATCH_LIMIT = 50;
/** Maximum scorecard history scanned when selecting an oldest-first backlog batch. */
export const GRADING_AUDIT_BACKLOG_SCAN_LIMIT = 500;
/**
 * A dispatch reservation survives a launcher response failure long enough for
 * the launch idempotency key to settle, but not forever if the launcher dies
 * before the auditor emits its audit card.
 */
export const GRADING_AUDIT_RESERVATION_TTL_MS = 15 * 60 * 1000;
/**
 * A route/launch failure that has no provider reset still needs a bounded retry
 * window. Releasing the reservation without one lets every sweep reserve the
 * same card again while producing neither a consult nor a task.
 */
export const GRADING_AUDIT_FAILURE_BACKOFF_MS = GRADING_AUDIT_RESERVATION_TTL_MS;
/**
 * EI-22978598482930667 — reset-aware re-dispatch suppression.
 *
 * A terminal quota failure carries a KNOWN future recovery instant, and until
 * this constant existed nothing consumed it: the reservation was released on the
 * terminal failure and the next sweep tick re-launched the same doomed judge.
 * Measured 2026-09-11 over the WHOLE grading-audit log population (n=6163, not a
 * recency head): 2228 legs died on the pty-host `(quota-blocked)` drop and 2523
 * launches were refused outright by the launcher's walled-pool preflight — every
 * one of those 2523 printing a contiguous `earliest known recovery <ISO>` — while
 * ZERO cards were emitted.
 *
 * The suppression is PROVIDER-AGNOSTIC by construction: it keys on the terminal
 * failure and on the account ledger's own reset terms, so it covers the Claude
 * primary leg (which no launcher preflight gates — `isCodexAutoRoute` is false
 * for a claude-resolved provider) exactly as it covers the Codex fallback.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS = 15 * 60 * 1000;
/**
 * Floor: a recovered-but-still-walled pool must never collapse back into the
 * ~55s sweep-tick busy loop this suppression exists to stop.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS = 5 * 60 * 1000;
/**
 * Ceiling: a wrong-but-plausible far-future reset must degrade into "re-probe in
 * six hours", never into a permanently stranded audit queue. A reset beyond this
 * is clamped, re-probed once, and re-recorded from whatever the wall says then.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/**
 * Automatic grading auditors must use the inference gateway so a quota-walled
 * system/default credential cannot strand the audit queue before kickoff.
 */
export const GRADING_AUDIT_ACCOUNT = 'auto' as const;
const GRADING_AUDIT_MAX_TERMINAL_FALLBACKS = 1;
const GRADING_AUDIT_TERMINAL_LOG_RECHECK_DELAY_MS = 250;
const GRADING_AUDIT_TERMINAL_LOG_MAX_RECHECKS = 4;
const GRADING_AUDIT_FALLBACK = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol' as const,
  effort: 'high' as const,
  // The system/default credential is a single-account escape hatch, not a
  // capacity-safe recovery route. Keep the cross-backend retry on Codex's
  // gateway pool so it can select a currently healthy account and fail over
  // when the account that caused the terminal failure is walled.
  account: GRADING_AUDIT_ACCOUNT,
};

export type GradingAuditLaunchContext = Parameters<typeof launchAgentTool.handler>[1];
type GradingAuditLaunchHandler = typeof launchAgentTool.handler;

export type PendingGradingAuditDispatchState = 'routed' | 'launched' | 'deduped' | 'skipped' | 'failed';

export interface PendingGradingAuditDispatchReceipt {
  issueId: string;
  rubricRef?: string;
  state: PendingGradingAuditDispatchState;
  idempotencyKey?: string;
  launch?: unknown;
  conversationId?: string;
  routingFallback?: string;
  reason?: string;
  terminalRecovery?: {
    retiredTaskIds: string[];
    attempts: number;
    codes: GradingAuditRecoveryCode[];
    fallback: typeof GRADING_AUDIT_FALLBACK;
  };
}

type GradingAuditRecoveryCode = AcceptanceGraderTerminalFailureCode | 'task_receipt_not_live';

export interface PendingGradingAuditDispatchResult {
  requestedTargetIds: string[];
  receipts: PendingGradingAuditDispatchReceipt[];
}

export interface DispatchPendingGradingAuditsInput {
  /**
   * Pending target issue ids surfaced by the completion gate. Omit or pass an
   * empty list to select the oldest current pending cards from scorecard
   * history; this is the scorecards:emit repair trigger.
   */
  targetIds?: readonly string[];
  /** The completion caller's context, forwarded to capability:launch-agent. */
  ctx: GradingAuditLaunchContext;
  /** Keep the auditor in the completed item's harness when available. */
  harness?: string | null;
}

export interface DispatchPendingGradingAuditsDeps {
  listScorecards?: typeof listScorecards;
  getRubric?: typeof getRubric;
  launch?: GradingAuditLaunchHandler;
  route?: typeof routeSourceGradingAudit;
  reserve?: typeof reservePendingGradingAudit;
  /** Re-check the owned reservation after the candidate snapshot is claimed. */
  confirmReservation?: typeof confirmPendingGradingAuditReservation;
  release?: typeof releasePendingGradingAudit;
  /** Check for a still-live task from an earlier reservation epoch. */
  listTasks?: typeof listTasks;
  getTask?: typeof getTask;
  readLogTail?: (path: string) => string | Promise<string>;
  killTask?: typeof killTask;
  sleep?: (ms: number) => Promise<void>;
  terminalLogRecheckDelayMs?: number;
  terminalLogMaxRechecks?: number;
  /** Read the active workspace-wide owner pause before dispatching new auditors. */
  listWorkspaceWideLoopStanddownOwners?: (workspaceId: string, nowMs: number) => Promise<Set<string>>;
  /** Future usage-reset terms for the account pool, for reset-aware quota backoff. */
  readProviderResets?: (nowMs: number) => Promise<number[]>;
  /** Clock seam for the recorded backoff instant. */
  now?: () => number;
}

export type GradingAuditReservationStatus =
  | 'claimed'
  | 'already-reserved'
  | 'not-pending'
  | 'quota-backoff'
  | 'dispatch-backoff';

/**
 * Why a card must not be re-dispatched yet, recorded on the card itself so the
 * suppression survives the dispatcher process that learned it.
 */
export interface GradingAuditDispatchBackoff {
  /** ISO-8601 instant before which this card must not be re-dispatched. */
  until: string;
  /**
   * Where the instant came from. `default` is the honest answer when a quota
   * wall was measured but no reset was recoverable from either source — it is a
   * conservative window, NOT a claim about when capacity returns.
   */
  source: 'account-ledger' | 'launcher-horizon' | 'default' | 'retry-window';
  /** The terminal failure code that produced the suppression. */
  code: string;
  recordedAt: string;
  reason: string;
}

export interface GradingAuditReservationResult {
  status: GradingAuditReservationStatus;
  reservation?: {
    key: string;
    reservedAt: string;
  };
  /** Present on a live quota or general dispatch backoff that refused the claim. */
  backoff?: GradingAuditDispatchBackoff;
}

/**
 * Confirm that a reservation still owns a pending target immediately before
 * dispatch. The initial candidate read is intentionally outside the reservation
 * transaction, and the settlement writer can finish another auditor between
 * that read and this dispatcher. Re-locking the row here makes the post-
 * reservation state check authoritative for the next side effect.
 */
export async function confirmPendingGradingAuditReservation(
  issueId: string,
  reservationKey: string,
  options: Pick<GradingAuditReservationOptions, 'workspaceId'> = {},
): Promise<boolean> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const current = await boundedOrgTxn(
    async (tx: OrgSql) =>
      tx<{ feature_id: string }[]>`
      SELECT scorecard.feature_id
        FROM harness_shared.work_items AS scorecard
       WHERE scorecard.workspace_id = ${workspaceId}
         AND scorecard.feature_id = ${issueId}
         AND scorecard.item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND scorecard.payload->'observation'->'gradingAudit'->>'state' = 'pending'
         AND scorecard.payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ${reservationKey}
         AND scorecard.payload->'observation'->'retracted' IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM harness_shared.work_items AS superseder
            WHERE superseder.workspace_id = scorecard.workspace_id
              AND superseder.payload->'observation'->>'supersedes' = scorecard.feature_id
              AND superseder.payload->'observation'->>'rubricRef' = scorecard.payload->'observation'->>'rubricRef'
              AND superseder.payload->'observation'->>'sourceHive' IS NOT DISTINCT FROM scorecard.payload->'observation'->>'sourceHive'
         )
       FOR UPDATE`,
  );
  return Boolean(current[0]);
}

interface GradingAuditReservationOptions {
  workspaceId?: string | null;
  now?: Date;
  /** Currentness from scorecards:list; stale or legacy identity-less settled cards are reopened atomically. */
  currentness?: ScorecardGradingAuditCurrentness;
}

/**
 * A settled stamp can be re-opened only when the current meta-rubric identity is
 * known and the recorded identity is either stale or absent because the card was
 * created before audit identity stamping. Other unknown states (missing live
 * identity or a meta-rubric mismatch) remain fail-closed.
 */
function reopenableSettledAuditIdentity(
  currentness: ScorecardGradingAuditCurrentness | undefined,
): currentness is ScorecardGradingAuditCurrentness & {
  currentRevision: number;
  currentCriteriaHash: string;
} {
  return Boolean(
    currentness &&
    currentness.currentRevision != null &&
    currentness.currentCriteriaHash != null &&
    (currentness.state === 'stale' ||
      (currentness.state === 'unknown' && currentness.reason === 'recorded-identity-missing')),
  );
}

/**
 * The launcher's walled-pool refusal prints its own recovery horizon as a
 * contiguous ISO instant. Measured over the whole grading-audit log population
 * (2026-09-11, n=6163): 2523 refusals, 2523 contiguous horizons — the TUI never
 * wrapped one, so reading it back out of the terminal evidence is sound.
 */
const LAUNCHER_RECOVERY_HORIZON = /earliest known recovery (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

/** Extract the launcher's printed recovery instant; null when absent or already past. */
export function parseLauncherRecoveryHorizon(rawLog: string | null | undefined, nowMs = Date.now()): number | null {
  const match = LAUNCHER_RECOVERY_HORIZON.exec(rawLog ?? '');
  if (!match?.[1]) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) && at > nowMs ? at : null;
}

/**
 * Future reset terms for every usage-walled account in the pool, across ALL
 * providers on purpose: the dispatcher may use its Claude primary OR its Codex
 * fallback, so re-dispatch becomes useful the moment EITHER provider recovers.
 * Fail-open (an empty list) on any read failure — a missing ledger must degrade
 * to the default window, never strand the queue.
 */
export async function readWalledAccountResets(nowMs: number): Promise<number[]> {
  try {
    const [{ accountStatus }, { activeWorkspaceId }] = await Promise.all([
      import('./deployment/account-pool-store'),
      import('./workspace-registry'),
    ]);
    const rows = await accountStatus(activeWorkspaceId());
    return rows
      .filter((row) => row.usageWalled)
      .map((row) => row.usageResetAt)
      .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > nowMs);
  } catch {
    return [];
  }
}

/**
 * Turn a measured quota wall into a DATED suppression.
 *
 * The EARLIEST future candidate wins, deliberately. The two error directions are
 * not symmetric: waking too early costs one futile boot that simply re-records
 * the backoff, while waking too late strands the whole audit queue past the
 * moment capacity actually returned. When neither source yields an instant the
 * result says so (`source: 'default'`) instead of inventing a recovery time.
 */
export async function resolveGradingAuditQuotaBackoff(input: {
  code: string;
  evidence?: string | null;
  logTail?: string | null;
  nowMs?: number;
  readProviderResets?: (nowMs: number) => Promise<number[]>;
}): Promise<GradingAuditDispatchBackoff> {
  const nowMs = input.nowMs ?? Date.now();
  const horizon = parseLauncherRecoveryHorizon(`${input.logTail ?? ''}\n${input.evidence ?? ''}`, nowMs);
  const ledger = await (input.readProviderResets ?? readWalledAccountResets)(nowMs).catch(() => [] as number[]);
  const ledgerEarliest = ledger
    .filter((at) => Number.isFinite(at) && at > nowMs)
    .sort((a, b) => a - b)[0];
  const candidates: Array<{ at: number; source: GradingAuditDispatchBackoff['source'] }> = [
    ...(ledgerEarliest != null ? [{ at: ledgerEarliest, source: 'account-ledger' as const }] : []),
    ...(horizon != null ? [{ at: horizon, source: 'launcher-horizon' as const }] : []),
  ].sort((a, b) => a.at - b.at);
  const chosen = candidates[0];
  const rawUntil = chosen ? chosen.at : nowMs + GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS;
  const until = Math.min(
    Math.max(rawUntil, nowMs + GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS),
    nowMs + GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS,
  );
  const source = chosen?.source ?? 'default';
  return {
    until: new Date(until).toISOString(),
    source,
    code: input.code,
    recordedAt: new Date(nowMs).toISOString(),
    reason:
      source === 'default'
        ? `terminal ${input.code} with no recoverable reset; suppressing re-dispatch for a conservative window`
        : `terminal ${input.code}; suppressing re-dispatch until the ${source} reset`,
  };
}

/** Build the durable suppression used when routing/launching failed without a
 * provider-specific recovery horizon. */
export function resolveGradingAuditFailureBackoff(input: {
  code: string;
  reason: string;
  nowMs?: number;
}): GradingAuditDispatchBackoff {
  const nowMs = input.nowMs ?? Date.now();
  return {
    until: new Date(nowMs + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
    source: 'retry-window',
    code: input.code,
    recordedAt: new Date(nowMs).toISOString(),
    reason: input.reason,
  };
}

/**
 * Atomically reserve one pending scorecard for an auditor launch.
 *
 * The dispatcher intentionally reads a bounded candidate list first, so this
 * is the second, write-side gate: the UPDATE predicate is the actual winner
 * election. A row lock is held for the fallback classification query, which
 * keeps two concurrent dispatchers from both observing an unreserved target.
 */
export async function reservePendingGradingAudit(
  issueId: string,
  reservationKey: string,
  options: GradingAuditReservationOptions = {},
): Promise<GradingAuditReservationResult> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const now = options.now ?? new Date();
  const reservedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - GRADING_AUDIT_RESERVATION_TTL_MS).toISOString();
  const reservation = JSON.stringify({ key: reservationKey, reservedAt });
  const reopenIdentity = reopenableSettledAuditIdentity(options.currentness)
    ? {
        recordedRevision: options.currentness.recordedRevision,
        recordedCriteriaHash: options.currentness.recordedCriteriaHash,
        rubricRevision: options.currentness.currentRevision,
        criteriaHash: options.currentness.currentCriteriaHash,
      }
    : null;
  const reopenedStamp = reopenIdentity
    ? JSON.stringify({
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        rubricRevision: reopenIdentity.rubricRevision,
        criteriaHash: reopenIdentity.criteriaHash,
        stampedAt: now.toISOString(),
        dispatchReservation: { key: reservationKey, reservedAt },
      })
    : null;

  return boundedOrgTxn(async (tx: OrgSql) => {
    const claimed = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               -- A claim only succeeds once any quota backoff below has EXPIRED,
               -- so clearing it here is the natural place: the stamp is spent.
               COALESCE(payload, '{}'::jsonb) #- '{observation,gradingAudit,dispatchBackoff}',
               '{observation,gradingAudit,dispatchReservation}',
               ${reservation}::jsonb,
               true
             ),
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND (
           (
             payload->'observation'->'gradingAudit'->>'state' = 'pending'
             AND (
               payload->'observation'->'gradingAudit'->'dispatchReservation' IS NULL
               OR CASE
                    WHEN payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt'
                         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                    THEN (payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt')::timestamptz < ${staleBefore}::timestamptz
                    ELSE TRUE
                  END
             )
             -- EI-22978598482930667: a live reset-aware quota backoff refuses the
             -- claim outright. Fail OPEN on an unparseable stamp, exactly like the
             -- reservation predicate above: a malformed value must never be able to
             -- strand a card permanently.
             AND (
               payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until' IS NULL
               OR CASE
                    WHEN payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until'
                         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                    THEN (payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until')::timestamptz <= ${reservedAt}::timestamptz
                    ELSE TRUE
                  END
             )
           )
           OR (
             ${
               reopenIdentity
                 ? tx`payload->'observation'->'gradingAudit'->>'state' IN ('passed', 'failed')
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'rubricRevision' IS NOT DISTINCT FROM ${String(reopenIdentity.recordedRevision)}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'criteriaHash' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS NOT DISTINCT FROM ${reopenIdentity.recordedCriteriaHash}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS DISTINCT FROM ${String(reopenIdentity.rubricRevision)}
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS DISTINCT FROM ${reopenIdentity.criteriaHash}
               )`
                 : tx`FALSE`
             }
           )
         )
       RETURNING feature_id`;
    if (claimed[0]) {
      if (reopenIdentity && reopenedStamp) {
        await tx`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(
                   COALESCE(payload, '{}'::jsonb),
                   '{observation,gradingAudit}',
                   ${reopenedStamp}::jsonb,
                   true
                 ),
                 origin = 'local',
                 updated_ts = ${Date.now()}
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ${issueId}
             AND item_kind = ANY (ARRAY['bug', 'change', 'task'])`;
      }
      return { status: 'claimed' as const, reservation: { key: reservationKey, reservedAt } };
    }

    const current = await tx<
      { state: string | null; has_reservation: boolean; backoff: GradingAuditDispatchBackoff | null }[]
    >`
      SELECT payload->'observation'->'gradingAudit'->>'state' AS state,
             (payload->'observation'->'gradingAudit' ? 'dispatchReservation') AS has_reservation,
             payload->'observation'->'gradingAudit'->'dispatchBackoff' AS backoff
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       FOR UPDATE`;
    const row = current[0];
    if (row?.state !== 'pending') return { status: 'not-pending' as const };
    // Report the quota wall ahead of the reservation: a backoff is only written
    // as the reservation is released, so a live one is the specific reason this
    // claim was refused — and a caller that reads 'already-reserved' would wait
    // on a dispatcher that is not in fact running.
    const until = row.backoff?.until ? Date.parse(row.backoff.until) : NaN;
    if (row.backoff && Number.isFinite(until) && until > now.getTime()) {
      return {
        status: row.backoff.code === 'model_quota_exhausted' ? ('quota-backoff' as const) : ('dispatch-backoff' as const),
        backoff: row.backoff,
      };
    }
    return row.has_reservation ? { status: 'already-reserved' as const } : { status: 'not-pending' as const };
  });
}

/**
 * Release only the reservation owned by this dispatcher.
 *
 * EI-22978598482930667: pass `backoff` to record a reset-aware quota suppression
 * in the SAME statement that drops the reservation. Atomicity is the point — a
 * separate write could lose the race to the next sweep tick and re-launch the
 * judge the suppression exists to stop.
 */
export async function releasePendingGradingAudit(
  issueId: string,
  reservationKey: string,
  options: Pick<GradingAuditReservationOptions, 'workspaceId'> & { backoff?: GradingAuditDispatchBackoff } = {},
): Promise<boolean> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const backoffJson = options.backoff ? JSON.stringify(options.backoff) : null;
  const released = await boundedOrgTxn(
    async (tx: OrgSql) =>
      tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = ${
           backoffJson
             ? tx`jsonb_set(
                 payload #- '{observation,gradingAudit,dispatchReservation}',
                 '{observation,gradingAudit,dispatchBackoff}',
                 ${backoffJson}::jsonb,
                 true
               )`
             : tx`payload #- '{observation,gradingAudit,dispatchReservation}'`
         },
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND payload->'observation'->'gradingAudit'->>'state' = 'pending'
         AND payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ${reservationKey}
      RETURNING feature_id`,
  );
  return Boolean(released[0]);
}

function currentPendingScorecard(card: ScorecardRow): boolean {
  const audit = card.gradingAudit;
  const reopenableSettled =
    audit !== undefined && audit.state !== 'pending' && reopenableSettledAuditIdentity(card.gradingAuditCurrentness);
  return (
    (audit?.state === 'pending' || reopenableSettled) &&
    !card.supersededBy &&
    !card.retracted &&
    card.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF
  );
}

function oldestFirst(a: ScorecardRow, b: ScorecardRow): number {
  return a.createdAt.localeCompare(b.createdAt) || a.issueId.localeCompare(b.issueId);
}

function gradingAuditBrief(card: ScorecardRow): string {
  const scratchTemplate = `/tmp/grading-integrity-${card.issueId}.XXXXXX`;
  return [
    `You are the dedicated grading-integrity auditor for scorecard ${card.issueId}.`,
    `The target is a terminal standard-rubric scorecard for rubric '${card.rubricRef}'. Inspect that exact scorecard and grade whether its evidence and criterion explanations are complete and independently re-runnable.`,
    `Source subject: ${JSON.stringify(card.subject ?? null)}; evidence fingerprint: ${card.evidenceFingerprint ?? 'not recorded'}. Preserve the stored evidence scope; do not substitute a newer working tree.`,
    'Do not modify implementation files, run shell commands, recruit peers, emit an ordinary same-rubric scorecard, or broaden scope.',
    `If the ordinary MCP tools are unavailable and you must use the documented scripts/mcp-call.mjs recovery path, stream each JSON payload through quoted stdin (--json -). If an intermediate file is unavoidable, first create a private directory with \`mktemp -d ${scratchTemplate}\` and keep every file inside it. Never read or write shared fixed names such as /tmp/eval-args.json or /tmp/eval.json: other grading auditors run concurrently and can overwrite them.`,
    `Emit exactly one COMPLETE terminal scorecards:emit audit: { rubricRef:'${GRADING_INTEGRITY_RUBRIC_REF}', terminal:true, subject:{ kind:'scorecard', ref:'${card.issueId}' }, ratings:{...} }. Include concrete evidence for every criterion in the grading-integrity rubric.`,
    'A successful audit emission settles the target scorecard; do not emit any second audit or other scorecard.',
  ].join('\n\n');
}

/**
 * Launch one independent auditor for each currently pending target surfaced by
 * the completion gate, or for an oldest-first bounded backlog batch when no
 * explicit targets were supplied. The scorecard read deliberately includes
 * historical rows, then applies the current/superseded/retracted filter locally:
 * this prevents a read-side default change from accidentally re-dispatching a
 * retired target. capability:launch-agent's stable idempotency key makes a
 * retry of the same completion or emit safe.
 */
export async function dispatchPendingGradingAudits(
  input: DispatchPendingGradingAuditsInput,
  deps: DispatchPendingGradingAuditsDeps = {},
): Promise<PendingGradingAuditDispatchResult> {
  const explicitTargetIds = [...new Set((input.targetIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(
    0,
    GRADING_AUDIT_DISPATCH_LIMIT,
  );

  const readCards = deps.listScorecards ?? listScorecards;
  const resolveRubric = deps.getRubric ?? getRubric;
  const launch = deps.launch ?? launchAgentTool.handler;
  const reserve = deps.reserve ?? reservePendingGradingAudit;
  const confirmReservation = deps.confirmReservation ?? confirmPendingGradingAuditReservation;
  const release = deps.release ?? releasePendingGradingAudit;
  const readTasks = deps.listTasks ?? listTasks;
  const workspaceId = input.ctx.workspaceId?.trim();
  const readWorkspaceWideStanddowns =
    deps.listWorkspaceWideLoopStanddownOwners ??
    (async (id: string, nowMs: number) => {
      try {
        return await listLoopStanddownOwners(getOrgPg().sql, {
          workspaceId: id,
          nowMs,
          workspaceWideOnly: true,
        });
      } catch (error) {
        // This guard only suppresses new work. A read failure must preserve the
        // pre-guard behavior rather than silently strand the audit queue.
        console.warn(
          `[grading-integrity] workspace stand-down read failed (non-fatal, failing open): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return new Set<string>();
      }
    });
  if (workspaceId) {
    const standdownOwners = await readWorkspaceWideStanddowns(workspaceId, Date.now());
    if (standdownOwners.size > 0) {
      return {
        requestedTargetIds: explicitTargetIds,
        receipts: explicitTargetIds.map((issueId) => ({
          issueId,
          state: 'skipped' as const,
          reason: 'dispatch suppressed by active workspace-wide loop stand-down',
        })),
      };
    }
  }
  const cards = await readCards({
    includeSuperseded: true,
    includeRetracted: true,
    limit: explicitTargetIds.length > 0 ? GRADING_AUDIT_DISPATCH_LIMIT : GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  });
  const pendingCards = cards.filter(currentPendingScorecard);
  const pendingById = new Map(pendingCards.map((card) => [card.issueId, card] as const));
  const requestedTargetIds =
    explicitTargetIds.length > 0
      ? explicitTargetIds
      : pendingCards
          .slice()
          .sort(oldestFirst)
          .slice(0, GRADING_AUDIT_DISPATCH_LIMIT)
          .map((card) => card.issueId);

  const receipts: PendingGradingAuditDispatchReceipt[] = [];
  for (const issueId of requestedTargetIds) {
    const card = pendingById.get(issueId);
    if (!card) {
      receipts.push({
        issueId,
        state: 'skipped',
        reason: 'target is no longer a current pending standard-rubric scorecard',
      });
      continue;
    }

    const rubric = await resolveRubric(card.rubricRef);
    if (!rubric) {
      receipts.push({ issueId, rubricRef: card.rubricRef, state: 'skipped', reason: 'target rubric not found' });
      continue;
    }
    if (rubric.kind !== 'standard') {
      receipts.push({
        issueId,
        rubricRef: card.rubricRef,
        state: 'skipped',
        reason: `target rubric kind '${rubric.kind}' is not standard`,
      });
      continue;
    }

    const idempotencyKey = `grading-audit:${issueId}`;
    const harness = input.harness?.trim();
    const retiredTaskIds: string[] = [];
    const terminalCodes: GradingAuditRecoveryCode[] = [];
    let currentIdempotencyKey = idempotencyKey;
    let terminalFallbacks = 0;
    let attempts = 0;
    let reservationHeld = false;
    let reservationReservedAt = 'reservation-unknown';
    let launchBackend: 'claude' | 'codex' = 'claude';
    let routingFallback: string | undefined;
    let receipt: PendingGradingAuditDispatchReceipt | null = null;
    const releaseReservation = async (backoff?: GradingAuditDispatchBackoff) => {
      if (!reservationHeld) return;
      reservationHeld = false;
      try {
        await release(issueId, idempotencyKey, {
          workspaceId: input.ctx.workspaceId,
          ...(backoff ? { backoff } : {}),
        });
      } catch {
        // The reservation TTL is the durable cleanup fallback if this release
        // cannot reach the database after a launcher failure.
      }
    };
    const confirmOwnedPendingReservation = async (): Promise<boolean> => {
      const current = await confirmReservation(issueId, idempotencyKey, {
        workspaceId: input.ctx.workspaceId,
      });
      if (current) return true;
      await releaseReservation();
      receipt = {
        issueId,
        rubricRef: card.rubricRef,
        state: 'skipped',
        idempotencyKey,
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      };
      return false;
    };
    const recoveryFields = () => ({
      ...(routingFallback ? { routingFallback } : {}),
      ...(retiredTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds,
              attempts,
              codes: terminalCodes,
              fallback: GRADING_AUDIT_FALLBACK,
            },
          }
        : {}),
    });
    const terminateTask = deps.killTask ?? killTask;
    const readTask = deps.getTask ?? getTask;
    const readLogTail = deps.readLogTail ?? readAcceptanceGraderLogTail;
    const detectTerminalFailure = (
      logPath: string | null,
      maxRechecks = deps.terminalLogMaxRechecks ?? GRADING_AUDIT_TERMINAL_LOG_MAX_RECHECKS,
      allowGatewayErrorWithoutFooter = true,
    ) =>
      detectAcceptanceGraderTerminalFailure(logPath, {
        readLogTail,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        delayMs: deps.terminalLogRecheckDelayMs ?? GRADING_AUDIT_TERMINAL_LOG_RECHECK_DELAY_MS,
        maxRechecks,
        allowStandaloneWeeklyLimit: true,
        allowInferenceGatewayError: true,
        // This controlled brief contains only the scorecard identity and
        // fingerprint, never a quoted gateway screen. A headless Claude
        // turn can stop on that exact screen before rendering its footer;
        // treating it as terminal is what lets the Codex fallback run.
        allowGatewayErrorWithoutFooter,
        allowLauncherQuotaDrop: true,
        // EI-22978598482930667: a launch REFUSED by the walled-pool preflight
        // is terminal for this mission. Without this it classified as nothing,
        // so the refusal was receipted as a successful launch and the card sat
        // on a held reservation until the TTL expired.
        allowLauncherWalledPoolRefusal: true,
        detectStartupStall: false,
      });
    /**
     * EI-22978598482930667: a terminal QUOTA failure is futile to retry until
     * capacity returns, and the recovery instant is knowable — from the account
     * ledger's reset terms, or from the horizon the launcher itself printed in
     * this very log. Record it so the reservation release ALSO suppresses the
     * next sweep tick. Only `model_quota_exhausted` earns a suppression: a
     * gateway 5xx or a startup stall is a transient this must not sit out.
     */
    const quotaBackoffFor = async (
      failure: { code: GradingAuditRecoveryCode; evidence: string },
      failedLogPath: string | null,
    ): Promise<GradingAuditDispatchBackoff | undefined> => {
      if (failure.code !== 'model_quota_exhausted') return undefined;
      let logTail = '';
      if (failedLogPath) {
        try {
          logTail = await readLogTail(failedLogPath);
        } catch {
          // The evidence string alone still carries the horizon when the
          // launcher refused; an unreadable log must not block the backoff.
        }
      }
      return resolveGradingAuditQuotaBackoff({
        code: failure.code,
        evidence: failure.evidence,
        logTail,
        ...(deps.now ? { nowMs: deps.now() } : {}),
        ...(deps.readProviderResets ? { readProviderResets: deps.readProviderResets } : {}),
      });
    };
    const recoveryKeyFor = (taskId: string, failureCode: GradingAuditRecoveryCode): string => {
      const retryIdentity = createHash('sha256')
        // The reservation timestamp is the bounded retry generation. A
        // later 15-minute reservation epoch must not dedupe its one allowed
        // recovery to the previous epoch's already-terminal fallback task.
        .update(
          `${reservationReservedAt}\0` +
            `${currentIdempotencyKey}\0${taskId}\0${failureCode}\0${GRADING_AUDIT_FALLBACK.agent}`,
        )
        .digest('hex')
        .slice(0, 16);
      return `${idempotencyKey}:recovery:${retryIdentity}`;
    };
    try {
      const reservation = await reserve(issueId, idempotencyKey, {
        workspaceId: input.ctx.workspaceId,
        currentness: card.gradingAuditCurrentness,
      });
      if (reservation.status !== 'claimed') {
        receipts.push({
          issueId,
          rubricRef: card.rubricRef,
          state: 'skipped',
          idempotencyKey,
          reason:
            reservation.status === 'quota-backoff'
              ? `re-dispatch suppressed until ${reservation.backoff?.until} ` +
                `(${reservation.backoff?.source ?? 'unknown'} reset after terminal ${reservation.backoff?.code ?? 'quota failure'})`
              : reservation.status === 'dispatch-backoff'
                ? `re-dispatch suppressed until ${reservation.backoff?.until} after ${reservation.backoff?.code ?? 'dispatch failure'}`
              : reservation.status === 'already-reserved'
                ? 'another dispatcher already reserved this scorecard'
                : 'target is no longer a pending scorecard',
        });
        continue;
      }
      reservationReservedAt = reservation.reservation?.reservedAt ?? reservationReservedAt;
      reservationHeld = true;
      if (!(await confirmOwnedPendingReservation())) {
        receipts.push(receipt!);
        continue;
      }
      /**
       * The reservation is a bounded dispatch lease, not the auditor's
       * identity. Once its TTL expires, a still-running task from the prior
       * lease must win over a new route or launch. The launcher's idempotency
       * receipt can be absent or stale even while the task-manager row remains
       * live, so query the durable task label directly before any fallback
       * side effect.
       */
      const liveTasks = await readTasks({
        workspaceId: input.ctx.workspaceId,
        states: ['pending', 'running'],
        labelPrefix: idempotencyKey,
        limit: 10,
      });
      const viableLiveTasks = [] as typeof liveTasks;
      for (const task of liveTasks) {
        const taskLogPath = task.logPath ?? null;
        // EI-23148617450190529: a headless CLI can return to its interactive
        // prompt after a delayed gateway/quota failure while its PTY and task
        // ledger row stay live. The old guard treated process liveness as mission
        // liveness and deduped forever. This is an OLD task on a later sweep, so
        // one current log read is sufficient; the launch path below retains its
        // bounded startup rechecks for a newly-created task.
        let terminalFailure: { code: GradingAuditRecoveryCode; evidence: string } | null = null;
        if (taskLogPath) {
          try {
            // A delayed live-task check requires Claude's completed-turn footer.
            // Unlike the launch transaction, this log may now contain tool output
            // derived from the scorecard, so the error headline alone is no longer
            // safe evidence that the auditor itself failed.
            terminalFailure = await detectTerminalFailure(taskLogPath, 0, false);
          } catch {
            // An unreadable task log cannot prove the mission terminal. Preserve
            // the existing fail-open dedupe until a later sweep can read it.
          }
        }
        if (!terminalFailure) {
          viableLiveTasks.push(task);
          continue;
        }
        const killed = await terminateTask(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (
          !killed.ok &&
          killed.error !== 'not_live' &&
          killed.error !== 'task_not_found' &&
          killed.error !== 'already_gone'
        ) {
          await releaseReservation(await quotaBackoffFor(terminalFailure, taskLogPath));
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            reason:
              `live grading auditor '${task.taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
              `could not be retired: ${killed.error}`,
            ...recoveryFields(),
          };
          break;
        }
        retiredTaskIds.push(task.taskId);
        terminalCodes.push(terminalFailure.code);
        if (terminalFallbacks < GRADING_AUDIT_MAX_TERMINAL_FALLBACKS) {
          terminalFallbacks += 1;
          launchBackend = GRADING_AUDIT_FALLBACK.agent;
          currentIdempotencyKey = recoveryKeyFor(task.taskId, terminalFailure.code);
        }
      }
      if (receipt) {
        receipts.push(receipt);
        continue;
      }
      if (viableLiveTasks.length > 0) {
        await releaseReservation();
        receipt = {
          issueId,
          rubricRef: card.rubricRef,
          state: 'deduped',
          idempotencyKey,
          launch: {
            deduped: true,
            opened: 0,
            failed: 0,
            mode: 'live-task-guard',
            tasks: viableLiveTasks.map((task) => ({
              taskId: task.taskId,
              logPath: task.logPath ?? null,
              label: typeof task.detail?.label === 'string' ? task.detail.label : idempotencyKey,
            })),
          },
          reason:
            viableLiveTasks.length === 1
              ? `existing live grading auditor task '${viableLiveTasks[0]?.taskId ?? 'unknown'}' owns ${idempotencyKey}; duplicate launch suppressed`
              : `${viableLiveTasks.length} existing live grading auditor tasks own ${idempotencyKey}; duplicate launch suppressed`,
          ...recoveryFields(),
        };
        receipts.push(receipt);
        continue;
      }
      const routed = await (deps.route ?? routeSourceGradingAudit)({
        card,
        reservationKey: idempotencyKey,
        brief: gradingAuditBrief(card),
        ctx: input.ctx,
        ...(harness && harness !== '*' ? { harness } : {}),
      });
      if (routed.state !== 'fallback') {
        receipts.push({
          issueId,
          rubricRef: card.rubricRef,
          idempotencyKey,
          state: routed.state,
          conversationId: routed.conversationId,
          ...(routed.reason ? { reason: routed.reason } : {}),
          ...recoveryFields(),
        });
        continue;
      }
      routingFallback = routed.reason;

      for (let attempt = 0; attempt <= GRADING_AUDIT_MAX_TERMINAL_FALLBACKS; attempt += 1) {
        attempts = attempt + 1;
        // Routing can itself create a durable consult and take long enough for
        // another auditor to settle the target. Re-check directly before each
        // external launch as well as before routing; never launch from the stale
        // candidate snapshot after settlement.
        if (!(await confirmOwnedPendingReservation())) break;
        const useFallback = launchBackend === GRADING_AUDIT_FALLBACK.agent;
        const result = (await launch(
          {
            brief: gradingAuditBrief(card),
            ...(harness && harness !== '*' ? { harness } : {}),
            headless: true,
            account: useFallback ? GRADING_AUDIT_FALLBACK.account : GRADING_AUDIT_ACCOUNT,
            ...(useFallback ? { agent: GRADING_AUDIT_FALLBACK.agent } : {}),
            count: 1,
            members: [
              useFallback
                ? {
                    role: 'judge',
                    agent: GRADING_AUDIT_FALLBACK.agent,
                    model: GRADING_AUDIT_FALLBACK.model,
                    effort: GRADING_AUDIT_FALLBACK.effort,
                    account: GRADING_AUDIT_FALLBACK.account,
                  }
                : { role: 'judge', account: GRADING_AUDIT_ACCOUNT },
            ],
            label: `grading-audit:${issueId}`,
            idempotencyKey: currentIdempotencyKey,
          } as never,
          input.ctx,
        )) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          data?: { deduped?: boolean; launch?: unknown };
        };
        const launchData = result.data?.launch as
          | { tasks?: Array<{ taskId?: unknown; logPath?: unknown }> }
          | undefined;
        const launchedTask = launchData?.tasks?.[0];
        const taskId = typeof launchedTask?.taskId === 'string' ? launchedTask.taskId : null;
        const logPath = typeof launchedTask?.logPath === 'string' ? launchedTask.logPath : null;
        let terminalFailure: { code: GradingAuditRecoveryCode; evidence: string } | null = logPath
          ? await detectTerminalFailure(logPath)
          : null;

        // A stable launch receipt can outlive the task it represented. Log
        // classifiers cover known quota/auth exits, but an operator reaper or
        // host recycle can end the task without writing any such terminal text.
        // Treat a DEDUPED receipt whose durable task is already gone as a
        // recoverable terminal mission; otherwise the card keeps a reservation
        // while every later sweep "succeeds" by deduping to the same dead task.
        if (!terminalFailure && result.data?.deduped && taskId) {
          const task = await readTask(taskId);
          if (!task || isTerminalState(task.state)) {
            terminalFailure = {
              code: 'task_receipt_not_live',
              evidence: task ? `task ledger state is ${task.state}` : 'task ledger row is absent',
            };
          }
        }

        if (terminalFailure) {
          if (!taskId) {
            await releaseReservation(await quotaBackoffFor(terminalFailure, logPath));
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              reason:
                `grading auditor ended on ${terminalFailure.code}, but its launch receipt carried no task id; ` +
                'refusing an untracked fallback',
              ...recoveryFields(),
            };
            break;
          }
          const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
          if (
            !killed.ok &&
            killed.error !== 'not_live' &&
            killed.error !== 'task_not_found' &&
            killed.error !== 'already_gone'
          ) {
            await releaseReservation(await quotaBackoffFor(terminalFailure, logPath));
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              reason:
                `grading auditor '${taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
                `could not be retired: ${killed.error}`,
              ...recoveryFields(),
            };
            break;
          }
          retiredTaskIds.push(taskId);
          terminalCodes.push(terminalFailure.code);
          if (terminalFallbacks >= GRADING_AUDIT_MAX_TERMINAL_FALLBACKS) {
            // The dominant path: BOTH legs are terminally quota-blocked. Before
            // EI-22978598482930667 this released the reservation with no backoff,
            // so the next ~55s sweep tick re-launched the same doomed pair.
            const backoff = await quotaBackoffFor(terminalFailure, logPath);
            await releaseReservation(backoff);
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              reason:
                `grading auditor fallback also ended on ${terminalFailure.code}; ` +
                'the one-retry ceiling stopped another launch' +
                (backoff ? `; re-dispatch suppressed until ${backoff.until} (${backoff.source})` : ''),
              ...recoveryFields(),
            };
            break;
          }
          terminalFallbacks += 1;
          launchBackend = GRADING_AUDIT_FALLBACK.agent;
          currentIdempotencyKey = recoveryKeyFor(taskId, terminalFailure.code);
          continue;
        }

        if (result.isError) {
          const reason = result.content?.[0]?.text ?? 'grading auditor launch failed';
          await releaseReservation(
            resolveGradingAuditFailureBackoff({
              code: 'launch_failed',
              reason,
              ...(deps.now ? { nowMs: deps.now() } : {}),
            }),
          );
          console.warn(`[grading-integrity] pending audit dispatch failed for ${issueId}: ${reason}`);
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            launch: result.data?.launch,
            reason,
            ...recoveryFields(),
          };
        } else {
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: result.data?.deduped ? 'deduped' : 'launched',
            idempotencyKey: currentIdempotencyKey,
            launch: result.data?.launch,
            ...recoveryFields(),
          };
        }
        break;
      }

      receipts.push(
        receipt ?? {
          issueId,
          rubricRef: card.rubricRef,
          state: 'failed',
          idempotencyKey: currentIdempotencyKey,
          reason: 'grading auditor terminal recovery exhausted without a receipt',
          ...recoveryFields(),
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await releaseReservation(
        resolveGradingAuditFailureBackoff({
          code: 'dispatch_exception',
          reason,
          ...(deps.now ? { nowMs: deps.now() } : {}),
        }),
      );
      console.warn(`[grading-integrity] pending audit dispatch failed for ${issueId}: ${reason}`);
      receipts.push({
        issueId,
        rubricRef: card.rubricRef,
        state: 'failed',
        idempotencyKey: currentIdempotencyKey,
        reason,
        ...recoveryFields(),
      });
    }
  }

  return { requestedTargetIds, receipts };
}

/**
 * Periodic repair entry point for the pending-audit queue. A completion refusal
 * is the normal trigger for the first dispatch, but the launched judge can learn
 * about a quota/auth failure after that short startup probe has ended. Re-running
 * the same bounded, idempotency-keyed dispatcher lets it inspect the old task's
 * now-terminal log and take the existing safe retirement/fallback path. Keep this
 * as a named wrapper so a routine can own the clock without duplicating dispatch
 * rules or creating a second launch surface.
 */
export async function reconcilePendingGradingAudits(
  input: Omit<DispatchPendingGradingAuditsInput, 'targetIds'>,
  deps: DispatchPendingGradingAuditsDeps = {},
): Promise<PendingGradingAuditDispatchResult> {
  return dispatchPendingGradingAudits(input, deps);
}

/** P-013 write-side gate. Fail-soft to OFF (no stamp — pre-P-013 behavior) when flag
 *  infra is unavailable: early boot and unit tests must never lose a scorecard over
 *  an audit annotation. */
export async function gradingAuditGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return await getFlag(FLAGS.GRADING_INTEGRITY_AUDIT_GATE, 'system');
  } catch {
    return false;
  }
}

/**
 * Pure: does THIS emit need the audit-pending stamp?
 * - standard-kind rubrics only: acceptance cards already carry their own
 *   grader ≠ author gate (plan-acceptance-gate), and auditing them here would be a
 *   second independent guard colliding with the first.
 * - terminal only (not provisional): an interim is a working note (D-004 bound 2).
 * - never the audit card itself (D-004 bound 1 — one level, no regress).
 */
export function needsGradingAudit(input: {
  rubricKind: string | undefined;
  rubricRef: string;
  provisional: boolean;
}): boolean {
  return input.rubricKind === 'standard' && !input.provisional && input.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF;
}
