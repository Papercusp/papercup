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
  account: 'default' as const,
};

export type GradingAuditLaunchContext = Parameters<typeof launchAgentTool.handler>[1];
type GradingAuditLaunchHandler = typeof launchAgentTool.handler;

export type PendingGradingAuditDispatchState = 'launched' | 'deduped' | 'skipped' | 'failed';

export interface PendingGradingAuditDispatchReceipt {
  issueId: string;
  rubricRef?: string;
  state: PendingGradingAuditDispatchState;
  idempotencyKey?: string;
  launch?: unknown;
  reason?: string;
  terminalRecovery?: {
    retiredTaskIds: string[];
    attempts: number;
    codes: AcceptanceGraderTerminalFailureCode[];
    fallback: typeof GRADING_AUDIT_FALLBACK;
  };
}

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
  reserve?: typeof reservePendingGradingAudit;
  release?: typeof releasePendingGradingAudit;
  readLogTail?: (path: string) => string | Promise<string>;
  killTask?: typeof killTask;
  sleep?: (ms: number) => Promise<void>;
  terminalLogRecheckDelayMs?: number;
  terminalLogMaxRechecks?: number;
  /** Read the active workspace-wide owner pause before dispatching new auditors. */
  listWorkspaceWideLoopStanddownOwners?: (workspaceId: string, nowMs: number) => Promise<Set<string>>;
}

export type GradingAuditReservationStatus = 'claimed' | 'already-reserved' | 'not-pending';

export interface GradingAuditReservationResult {
  status: GradingAuditReservationStatus;
  reservation?: {
    key: string;
    reservedAt: string;
  };
}

interface GradingAuditReservationOptions {
  workspaceId?: string | null;
  now?: Date;
  /** Currentness from scorecards:list; stale settled cards are reopened atomically. */
  currentness?: ScorecardGradingAuditCurrentness;
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
  const reopenStale =
    options.currentness?.state === 'stale' &&
    options.currentness.currentRevision != null &&
    options.currentness.currentCriteriaHash != null
      ? {
          recordedRevision: options.currentness.recordedRevision,
          recordedCriteriaHash: options.currentness.recordedCriteriaHash,
          rubricRevision: options.currentness.currentRevision,
          criteriaHash: options.currentness.currentCriteriaHash,
        }
      : null;
  const reopenedStamp = reopenStale
    ? JSON.stringify({
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        rubricRevision: reopenStale.rubricRevision,
        criteriaHash: reopenStale.criteriaHash,
        stampedAt: now.toISOString(),
        dispatchReservation: { key: reservationKey, reservedAt },
      })
    : null;

  return boundedOrgTxn(async (tx: OrgSql) => {
    const claimed = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
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
           )
           OR (
             ${reopenStale ? tx`payload->'observation'->'gradingAudit'->>'state' IN ('passed', 'failed')
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'rubricRevision' IS NOT DISTINCT FROM ${String(reopenStale.recordedRevision)}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'criteriaHash' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS NOT DISTINCT FROM ${reopenStale.recordedCriteriaHash}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS DISTINCT FROM ${String(reopenStale.rubricRevision)}
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS DISTINCT FROM ${reopenStale.criteriaHash}
               )` : tx`FALSE`}
           )
         )
       RETURNING feature_id`;
    if (claimed[0]) {
      if (reopenStale && reopenedStamp) {
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

    const current = await tx<{ state: string | null; has_reservation: boolean }[]>`
      SELECT payload->'observation'->'gradingAudit'->>'state' AS state,
             (payload->'observation'->'gradingAudit' ? 'dispatchReservation') AS has_reservation
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       FOR UPDATE`;
    return current[0]?.state === 'pending' && current[0].has_reservation
      ? { status: 'already-reserved' as const }
      : { status: 'not-pending' as const };
  });
}

/** Release only the reservation owned by this dispatcher. */
export async function releasePendingGradingAudit(
  issueId: string,
  reservationKey: string,
  options: Pick<GradingAuditReservationOptions, 'workspaceId'> = {},
): Promise<boolean> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const released = await boundedOrgTxn(async (tx: OrgSql) =>
    tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = payload #- '{observation,gradingAudit,dispatchReservation}',
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
  const staleSettled = audit !== undefined && audit.state !== 'pending' && card.gradingAuditCurrentness?.state === 'stale';
  return (
    (audit?.state === 'pending' || staleSettled) &&
    !card.supersededBy &&
    !card.retracted &&
    card.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF
  );
}

function oldestFirst(a: ScorecardRow, b: ScorecardRow): number {
  return a.createdAt.localeCompare(b.createdAt) || a.issueId.localeCompare(b.issueId);
}

function gradingAuditBrief(card: ScorecardRow): string {
  return [
    `You are the dedicated grading-integrity auditor for scorecard ${card.issueId}.`,
    `The target is a terminal standard-rubric scorecard for rubric '${card.rubricRef}'. Inspect that exact scorecard and grade whether its evidence and criterion explanations are complete and independently re-runnable.`,
    'Do not modify implementation files, run shell commands, recruit peers, emit an ordinary same-rubric scorecard, or broaden scope.',
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
  const release = deps.release ?? releasePendingGradingAudit;
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
    const terminalCodes: AcceptanceGraderTerminalFailureCode[] = [];
    let currentIdempotencyKey = idempotencyKey;
    let terminalFallbacks = 0;
    let attempts = 0;
    let reservationHeld = false;
    const releaseReservation = async () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      try {
        await release(issueId, idempotencyKey, { workspaceId: input.ctx.workspaceId });
      } catch {
        // The reservation TTL is the durable cleanup fallback if this release
        // cannot reach the database after a launcher failure.
      }
    };
    const recoveryFields = () =>
      retiredTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds,
              attempts,
              codes: terminalCodes,
              fallback: GRADING_AUDIT_FALLBACK,
            },
          }
        : {};
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
            reservation.status === 'already-reserved'
              ? 'another dispatcher already reserved this scorecard'
              : 'target is no longer a pending scorecard',
        });
        continue;
      }
      reservationHeld = true;
      const terminateTask = deps.killTask ?? killTask;
      const readLogTail = deps.readLogTail ?? readAcceptanceGraderLogTail;
      let launchBackend: 'claude' | 'codex' = 'claude';
      let receipt: PendingGradingAuditDispatchReceipt | null = null;

      for (let attempt = 0; attempt <= GRADING_AUDIT_MAX_TERMINAL_FALLBACKS; attempt += 1) {
        attempts = attempt + 1;
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
        const terminalFailure = logPath
          ? await detectAcceptanceGraderTerminalFailure(logPath, {
              readLogTail,
              ...(deps.sleep ? { sleep: deps.sleep } : {}),
              delayMs: deps.terminalLogRecheckDelayMs ?? GRADING_AUDIT_TERMINAL_LOG_RECHECK_DELAY_MS,
              maxRechecks: deps.terminalLogMaxRechecks ?? GRADING_AUDIT_TERMINAL_LOG_MAX_RECHECKS,
              allowStandaloneWeeklyLimit: true,
              allowInferenceGatewayError: true,
              detectStartupStall: false,
            })
          : null;

        if (terminalFailure) {
          if (!taskId) {
            await releaseReservation();
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
            await releaseReservation();
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
            await releaseReservation();
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              reason:
                `grading auditor fallback also ended on ${terminalFailure.code}; ` +
                'the one-retry ceiling stopped another launch',
              ...recoveryFields(),
            };
            break;
          }
          terminalFallbacks += 1;
          launchBackend = GRADING_AUDIT_FALLBACK.agent;
          const retryIdentity = createHash('sha256')
            .update(`${currentIdempotencyKey}\0${taskId}\0${terminalFailure.code}\0${launchBackend}`)
            .digest('hex')
            .slice(0, 16);
          currentIdempotencyKey = `${idempotencyKey}:recovery:${retryIdentity}`;
          continue;
        }

        if (result.isError) {
          await releaseReservation();
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            launch: result.data?.launch,
            reason: result.content?.[0]?.text ?? 'grading auditor launch failed',
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
      await releaseReservation();
      receipts.push({
        issueId,
        rubricRef: card.rubricRef,
        state: 'failed',
        idempotencyKey: currentIdempotencyKey,
        reason: error instanceof Error ? error.message : String(error),
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
