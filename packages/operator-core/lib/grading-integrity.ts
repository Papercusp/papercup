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

import launchAgentTool from './agent-tools/capability/launch-agent';
import { getRubric } from './rubrics';
import { listScorecards, type ScorecardRow } from './scorecards';


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
}

function currentPendingScorecard(card: ScorecardRow): boolean {
  return (
    card.gradingAudit?.state === 'pending' &&
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
    "Do not modify implementation files, run shell commands, recruit peers, emit an ordinary same-rubric scorecard, or broaden scope.",
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
    try {
      const result = (await launch(
        {
          brief: gradingAuditBrief(card),
          ...(harness && harness !== '*' ? { harness } : {}),
          headless: true,
          account: 'default',
          count: 1,
          members: [{ role: 'judge', account: 'default' }],
          label: `grading-audit:${issueId}`,
          idempotencyKey,
        } as never,
        input.ctx,
      )) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        data?: { deduped?: boolean; launch?: unknown };
      };
      if (result.isError) {
        receipts.push({
          issueId,
          rubricRef: card.rubricRef,
          state: 'failed',
          idempotencyKey,
          launch: result.data?.launch,
          reason: result.content?.[0]?.text ?? 'grading auditor launch failed',
        });
      } else {
        receipts.push({
          issueId,
          rubricRef: card.rubricRef,
          state: result.data?.deduped ? 'deduped' : 'launched',
          idempotencyKey,
          launch: result.data?.launch,
        });
      }
    } catch (error) {
      receipts.push({
        issueId,
        rubricRef: card.rubricRef,
        state: 'failed',
        idempotencyKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { requestedTargetIds, receipts };
}

/** P-013 write-side gate. Fail-soft to OFF (no stamp — pre-P-013 behavior) when flag
 *  infra is unavailable: early boot and unit tests must never lose a scorecard over
 *  an audit annotation. */
export async function gradingAuditGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
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
  return (
    input.rubricKind === 'standard' &&
    !input.provisional &&
    input.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF
  );
}
