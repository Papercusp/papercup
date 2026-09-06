/**
 * GOAL kickoff evidence — the structural answer to "may this GOAL holder place
 * portfolio work yet?" (WI-939561).
 *
 * The GOAL contract has always required four portfolio reads followed by an
 * owner-facing report before the first create/launch/placement. Prompt prose did
 * not make that ordering real: a holder could launch a fleet immediately and do
 * the reads much later (or never). This module reuses the two durable ledgers
 * that already record the facts instead of introducing a parallel checklist:
 *
 *   - harness_shared.tool_invocations — successful current-window reads;
 *   - harness_shared.coord_event_log  — the delivered owner-facing report.
 *
 * A "window" begins at the current GOAL-mode row's set_at. A reason/subject
 * change intentionally starts a new window; an idempotent mode re-assertion does
 * not rewrite set_at. The report must be delivered AFTER all four reads and must
 * name the current mode subject, so evidence from a previous goal cannot unlock
 * a newly adopted one.
 *
 * The gate applies only to the session that HOLDS mode='goal'. Descendants may
 * inherit goal provenance through session_briefs.goal_id, but they implement the
 * work and must not inherit the portfolio-manager kickoff gate.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getModes } from '../modes/store';
import {
  portfolioActFacet,
  PORTFOLIO_CREATE_TOOLS,
  PORTFOLIO_PLACE_TOOLS,
} from './portfolio-acts';
import { envelopeHasCompleteGoalOwnerReport } from '../goal-owner-report';

export const GOAL_KICKOFF_REQUIRED_READS = ['goals:list', 'pot:list', 'plans:list', 'search:semantic'] as const;

export type GoalKickoffRead = (typeof GOAL_KICKOFF_REQUIRED_READS)[number];

/**
 * Creation, launch and placement doors a GOAL holder may not cross before the
 * kickoff evidence exists. The unconditional names are derived from the same
 * facet registry that measures portfolio activity; args-sensitive acts are
 * resolved by {@link isGoalKickoffGuardedTool}. Keep this at the shared dispatch
 * seam: an inner call through tools:invoke is re-dispatched under its canonical
 * name and is covered exactly like a direct MCP/HTTP/IPC call.
 */
export const GOAL_KICKOFF_GUARDED_TOOLS: readonly string[] = Object.freeze(
  [...new Set<string>([...PORTFOLIO_CREATE_TOOLS, ...PORTFOLIO_PLACE_TOOLS])].sort(),
);

export function isGoalKickoffGuardedTool(toolName: string, args?: unknown): boolean {
  const facet = portfolioActFacet(toolName, args);
  return facet === 'create' || facet === 'place';
}

export type GoalKickoffMissingLeg =
  | GoalKickoffRead
  | 'owner-report'
  | 'goal-subject'
  | 'goal-record'
  | 'evidence-unavailable';

export interface GoalKickoffEvidence {
  /** false means this caller has no active GOAL-mode row; descendants are false. */
  applies: boolean;
  complete: boolean;
  workspaceId: string;
  ownerId: string;
  goalId: string | null;
  windowStartedAt: string | null;
  /** Informational only. A standing goal's absent kill criterion is valid. */
  standing: boolean | null;
  killCriterion: string | null;
  reads: Partial<Record<GoalKickoffRead, string>>;
  ownerReportAt: string | null;
  missing: GoalKickoffMissingLeg[];
  degradedReason: string | null;
}

export interface ReadGoalKickoffEvidenceArgs {
  workspaceId: string;
  ownerId: string;
  /**
   * The dispatch host supplies flushPendingTelemetry. Requiring the seam keeps a
   * just-finished read/report from sitting in the deferred telemetry buffer while
   * the following launch is falsely refused.
   */
  flushTelemetry: () => Promise<void>;
  sql?: Sql;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function iso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function base(args: ReadGoalKickoffEvidenceArgs): GoalKickoffEvidence {
  return {
    applies: false,
    complete: false,
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    goalId: null,
    windowStartedAt: null,
    standing: null,
    killCriterion: null,
    reads: {},
    ownerReportAt: null,
    missing: [],
    degradedReason: null,
  };
}

/**
 * Read the current, falsifiable kickoff proof. No write is made: completion is
 * derived from canonical ledgers on every guarded call, so a process restart or
 * carry-respawn cannot erase it and no second mutable "kickoff complete" bit can
 * drift from the evidence.
 */
export async function readGoalKickoffEvidence(args: ReadGoalKickoffEvidenceArgs): Promise<GoalKickoffEvidence> {
  const out = base(args);
  if (!args.workspaceId || args.workspaceId === '*' || !args.ownerId) return out;
  const sql = pg(args.sql);

  let mode: Awaited<ReturnType<typeof getModes>>[number] | undefined;
  try {
    mode = (await getModes(args.workspaceId, args.ownerId, sql)).find((row) => row.mode === 'goal');
  } catch (error) {
    // We cannot distinguish an ordinary caller from a GOAL holder when the mode
    // store itself is down. Preserve ordinary create/launch availability, but
    // make the missing enforcement visible to the host log.
    return {
      ...out,
      degradedReason: `GOAL kickoff mode read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!mode) return out;
  out.applies = true;
  out.goalId = mode.subject;
  out.windowStartedAt = iso(mode.setAt);

  if (!out.goalId) {
    out.missing = ['goal-subject'];
    return out;
  }
  if (!out.windowStartedAt) {
    out.missing = ['evidence-unavailable'];
    out.degradedReason = 'the active GOAL-mode row has no readable set_at window boundary';
    return out;
  }

  try {
    const goalRows = (await sql`
      SELECT id, standing, kill_criterion
        FROM harness_shared.goals
       WHERE workspace_id = ${args.workspaceId}
         AND id = ${out.goalId}
       LIMIT 1
    `) as unknown as Array<Record<string, unknown>>;
    if (goalRows.length === 0) {
      out.missing = ['goal-record'];
      return out;
    }
    out.standing = goalRows[0]!.standing == null ? null : Boolean(goalRows[0]!.standing);
    out.killCriterion = goalRows[0]!.kill_criterion == null ? null : String(goalRows[0]!.kill_criterion);

    await args.flushTelemetry();

    const readRows = (await sql`
      SELECT tool_name, max(invoked_at) AS invoked_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${args.workspaceId}
         AND coord_owner_id = ${args.ownerId}
         AND invoked_at >= ${out.windowStartedAt}::timestamptz
         AND status = 'ok'
         AND tool_name IN ${sql([...GOAL_KICKOFF_REQUIRED_READS])}
       GROUP BY tool_name
    `) as unknown as Array<Record<string, unknown>>;

    for (const row of readRows) {
      const name = String(row.tool_name ?? '');
      if (!GOAL_KICKOFF_REQUIRED_READS.includes(name as GoalKickoffRead)) continue;
      const at = iso(row.invoked_at);
      if (at) out.reads[name as GoalKickoffRead] = at;
    }

    const missingReads = GOAL_KICKOFF_REQUIRED_READS.filter((name) => !out.reads[name]);
    if (missingReads.length > 0) {
      // A report cannot satisfy the contract until all four reads exist because
      // it must follow them. Say both halves are still missing/actionable.
      out.missing = [...missingReads, 'owner-report'];
      return out;
    }

    const latestReadAt = GOAL_KICKOFF_REQUIRED_READS.map((name) => out.reads[name]!)
      .sort()
      .at(-1)!;
    const reportRows = (await sql`
      SELECT ts, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${args.workspaceId}
         AND body->>'from' = ${args.ownerId}
         AND ts >= ${latestReadAt}::timestamptz
         AND superseded_by_msg_id IS NULL
         AND (
           (surface = 'messages' AND body->'to' @> '["human"]'::jsonb)
           OR surface = 'escalations'
         )
       ORDER BY ts DESC
       -- Compatibility is intentionally bounded. Modern reports carry a
       -- server-authored goalOwnerReport stamp; legacy rows are parsed below
       -- and must still contain all four labeled values plus the exact goal.
       LIMIT 256
    `) as unknown as Array<Record<string, unknown>>;

    const reportRow = reportRows.find((row) => envelopeHasCompleteGoalOwnerReport(row.body, out.goalId!));
    out.ownerReportAt = reportRow ? iso(reportRow.ts) : null;
    if (!out.ownerReportAt) {
      out.missing = ['owner-report'];
      return out;
    }

    out.complete = true;
    return out;
  } catch (error) {
    out.missing = ['evidence-unavailable'];
    out.degradedReason = `GOAL kickoff evidence read failed: ${error instanceof Error ? error.message : String(error)}`;
    return out;
  }
}

export function goalKickoffRefusalPayload(toolName: string, evidence: GoalKickoffEvidence) {
  const missing = evidence.missing.length ? evidence.missing : ['evidence-unavailable'];
  const standingNote = evidence.standing
    ? ' This is a standing goal: no kill criterion is required; the gate checks only the four reads and the report.'
    : '';
  return {
    ok: false,
    error: 'goal_kickoff_incomplete',
    tool: toolName,
    goalId: evidence.goalId,
    windowStartedAt: evidence.windowStartedAt,
    missing,
    observed: {
      reads: evidence.reads,
      ownerReportAt: evidence.ownerReportAt,
    },
    ...(evidence.degradedReason ? { degradedReason: evidence.degradedReason } : {}),
    message:
      `GOAL kickoff incomplete for ${evidence.goalId ?? 'an unattributed GOAL holder'}; ${toolName} was refused before portfolio mutation/placement. ` +
      `In the current GOAL window, successfully run goals:list, pot:list, plans:list, and search:semantic on the goal's terms; then send an owner-facing report AFTER those reads (coord:send to ["human"] or coord:escalate) that names the exact goal id. ` +
      `Missing: ${missing.join(', ')}.${standingNote}`,
  };
}
