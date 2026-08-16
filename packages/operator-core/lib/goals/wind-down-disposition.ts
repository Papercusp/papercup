/**
 * Wind-down disposition gate (goal-mode-design-intent-hardening-2026-08-16 P-002).
 *
 * A GOAL-mode owner ending its loop (or, loopless, its session) while the goal
 * is still ACTIVE must say what became of the goal — `achieved | killed |
 * handoff` — and the platform then generates the owner report FROM the state
 * the agent already wrote (the loop carry-note + the end reason) and delivers
 * it to the owner inbox. The graded run that motivated this (WI-39531) had all
 * the per-platform evidence sitting in its own loop:end text and sent none of
 * it: the disposition demand is the structural fix, the auto-report is what
 * makes the demand cheap to satisfy.
 *
 * Delivery is an ADVISORY escalation: escalations ARE the owner inbox (the
 * inbox `by_kind` counts them; the drain watchdog pages on the same surface),
 * so no new delivery channel is invented here.
 *
 * The gate's flag check fails CLOSED (gate off on flag-infra errors) — the
 * deliberate opposite of `drainFleetAutoMintEnabled`'s fail-open. A refusal
 * gate on the STOP path must never block on infra errors: you must always be
 * able to stop a loop you armed. loop:end itself stays unflagged for stopping
 * for the same reason.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';

import { getModeSubject } from '../modes/store';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const GOAL_DISPOSITIONS = ['achieved', 'killed', 'handoff'] as const;
export type GoalDisposition = (typeof GOAL_DISPOSITIONS)[number];

export function isGoalDisposition(v: unknown): v is GoalDisposition {
  return typeof v === 'string' && (GOAL_DISPOSITIONS as readonly string[]).includes(v);
}

/** The owner's still-active goal, or null when the wind-down needs no disposition. */
export interface ActiveGoalRef {
  goalId: string;
  title: string;
  installSlug: string;
  /** A disposition already recorded on the row (metadata.disposition) — the gate
   *  passes when one exists, so a re-entrant wind-down never demands it twice. */
  recordedDisposition: string | null;
}

/**
 * Resolve the caller's active goal: the GOAL mode row's subject
 * (`getModeSubject(ws, ownerId, 'goal')`), then the goals row itself, which
 * must still be `status='active'`. Null on every not-applicable case (not in
 * goal mode, subject unset, goal already terminal/paused, row gone) — the gate
 * only ever REFUSES on a positive finding, never on a resolution miss.
 *
 * Takes the org pool by default (never ctx.tx): session:end runs
 * `skipWorkspaceTx` and loop:end must stay callable under a saturated
 * workspace pool.
 */
export async function activeGoalForOwner(opts: {
  workspaceId: string;
  ownerId: string;
  sql?: GoalSqlTag;
}): Promise<ActiveGoalRef | null> {
  const sql = opts.sql ?? (getOrgPg().sql as unknown as GoalSqlTag);
  const goalId = await getModeSubject(
    opts.workspaceId,
    opts.ownerId,
    'goal',
    sql as never,
  ).catch(() => null);
  if (!goalId) return null;
  const rows = await sql<
    Array<{ id: string; title: string; install_slug: string; disposition: string | null }>
  >`
    SELECT id, title, install_slug, metadata->>'disposition' AS disposition
      FROM harness_shared.goals
     WHERE id = ${goalId} AND workspace_id = ${opts.workspaceId} AND status = 'active'
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    goalId: row.id,
    title: row.title,
    installSlug: row.install_slug,
    recordedDisposition: row.disposition ?? null,
  };
}

/**
 * PURE: the refusal both gates return when a goal-mode owner winds down with no
 * disposition. Exported (and pinned by the guard test) because the acceptance
 * criterion is about the WORDS: the refusal must name the missing arg
 * (`disposition`) and all three legal values, or the refused agent has no way
 * forward from the error alone.
 */
export function buildDispositionRefusal(opts: {
  action: 'loop:end' | 'session:end';
  goalId: string;
  goalTitle: string;
}): { ok: false; error: string; goalId: string; dispositions: readonly GoalDisposition[] } {
  return {
    ok: false,
    error:
      `REFUSED — this owner is in GOAL mode and goal ${opts.goalId} (“${opts.goalTitle}”) is still active. ` +
      `${opts.action} requires a \`disposition\`: 'achieved' (the goal is done), 'killed' (deliberately stopped), ` +
      `or 'handoff' (someone else continues — pass handoffTo). Retry with disposition set; ` +
      `the wind-down report to the owner is generated for you.`,
    goalId: opts.goalId,
    dispositions: GOAL_DISPOSITIONS,
  };
}

export interface GoalWindDownReportInput {
  goalId: string;
  goalTitle: string;
  disposition: GoalDisposition;
  endedBy: string;
  /** Which verb wound down — report provenance. */
  action: 'loop:end' | 'session:end';
  reason?: string | null;
  /** The loop carry-note at wind-down — the evidence the report exists to carry. */
  carryNote?: string | null;
  handoffTo?: string | null;
}

/** PURE: render the owner report. The summary is the inbox card line; the body
 *  folds the reason + the final carry-note so the evidence the agent already
 *  wrote actually reaches the owner. */
export function buildGoalWindDownReport(input: GoalWindDownReportInput): {
  summary: string;
  body: string;
} {
  const dispositionLine =
    input.disposition === 'handoff'
      ? `handoff${input.handoffTo ? ` → ${input.handoffTo}` : ''} (goal stays active)`
      : input.disposition;
  const summary = `Goal wind-down [${dispositionLine}]: ${input.goalTitle}`;
  const lines = [
    `Goal ${input.goalId} (“${input.goalTitle}”) was wound down via ${input.action} by ${input.endedBy}.`,
    `Disposition: ${dispositionLine}.`,
  ];
  const reason = input.reason?.trim();
  if (reason) lines.push('', `## End reason`, reason);
  const note = input.carryNote?.trim();
  if (note) lines.push('', `## Final carry-note`, note);
  if (!reason && !note)
    lines.push('', '(No end reason or carry-note was recorded at wind-down.)');
  return { summary, body: lines.join('\n') };
}

/**
 * Record the disposition on the goals row. `achieved`/`killed` flip
 * `status` (both are in GOAL_STATUSES); `handoff` leaves the goal ACTIVE —
 * someone else continues pursuing it. All three stamp
 * `metadata.{disposition,dispositionBy,dispositionAt[,handoffTo]}`.
 * Id+workspace scoped like `deleteGoalRow`: the table is multi-tenant and this
 * write must never reach another tenant's row.
 */
export async function applyGoalDisposition(opts: {
  workspaceId: string;
  goalId: string;
  disposition: GoalDisposition;
  dispositionBy: string;
  handoffTo?: string | null;
  sql?: GoalSqlTag;
}): Promise<void> {
  const sql = opts.sql ?? (getOrgPg().sql as unknown as GoalSqlTag);
  const stamp: Record<string, unknown> = {
    disposition: opts.disposition,
    dispositionBy: opts.dispositionBy,
    dispositionAt: new Date().toISOString(),
  };
  if (opts.disposition === 'handoff' && opts.handoffTo) stamp.handoffTo = opts.handoffTo;
  const nextStatus = opts.disposition === 'handoff' ? null : opts.disposition;
  await sql`
    UPDATE harness_shared.goals
       SET status = COALESCE(${nextStatus}::text, status),
           metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb
     WHERE id = ${opts.goalId} AND workspace_id = ${opts.workspaceId}
  `;
}

/**
 * Deliver the report to the owner inbox as an advisory escalation, deduped per
 * goal (`goal-wind-down` / `<ws>:<goalId>`) so a retried wind-down bumps the
 * card instead of stacking a second one.
 */
export async function deliverGoalWindDownReport(
  identity: AgentIdentity,
  opts: {
    workspaceId: string;
    goalId: string;
    disposition: GoalDisposition;
    summary: string;
    body: string;
  },
): Promise<void> {
  await openEscalation(identity, {
    severity: 'advisory',
    summary: opts.summary,
    body: opts.body,
    meta: {
      dedupKind: 'goal-wind-down',
      subjectSignature: `${opts.workspaceId}:${opts.goalId}`,
      goalId: opts.goalId,
      disposition: opts.disposition,
    },
  });
}

/**
 * FLAGS.GOAL_WINDDOWN_DISPOSITION_GATE, default ON. Fail-CLOSED on flag-infra
 * errors — the deliberate opposite of `drainFleetAutoMintEnabled`: this is a
 * REFUSAL gate on the stop path, and a broken flag read must disable the gate,
 * never wedge an agent that is trying to stop its own loop.
 */
export async function windDownDispositionGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_WINDDOWN_DISPOSITION_GATE, 'system');
  } catch {
    return false;
  }
}
