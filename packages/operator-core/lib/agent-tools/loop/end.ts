/**
 * loop:end — end the engine-managed loop on your own session (or another owner's,
 * with `ownerId`): stop the recurring warm wake (loop-routines-interval-recurrence-
 * 2026-06-20, B-LOOP-5 / P-008). The routine is DEACTIVATED (the row is kept for
 * fire-history + a quick re-arm). Deliberately NOT flag-gated — you must always be
 * able to stop a loop you armed, even if the loop feature flag was later turned off.
 *
 * P-002 (goal-mode-design-intent-hardening-2026-08-16): a GOAL-mode owner whose
 * goal is still ACTIVE must pass `disposition` (achieved | killed | handoff) —
 * the platform then records it on the goal and delivers the owner report built
 * from the loop carry-note + `reason`. The gate itself is flag-gated
 * (GOAL_WINDDOWN_DISPOSITION_GATE, fail-CLOSED) so the stop path can never be
 * wedged by flag infra; the STOP itself stays unflagged.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { deactivateLoop, getLoopStatus } from '../../harness/routines/loop';
import { activeWorkspaceId } from '../../workspace-registry';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  buildDispositionRefusal,
  evaluateGoalAcceptanceGate,
  buildGoalWindDownReport,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
} from '../../goals/wind-down-disposition';
import { evaluateGoalWindDownOutputs } from '../../goals/goal-io-validation';
import { getLoopCarryNote } from '../../carry-note';

export default defineTool({
  name: 'loop:end',
  profile: 'engineer',
  description:
    "End the owner-scoped loop on your own session (or another owner's, with `ownerId`) — stops the recurring warm wake. The routine is deactivated (history kept); an optional `reason` is recorded in the transition log. A GOAL-mode owner with a still-active goal must also pass `disposition` (achieved | killed | handoff) — the wind-down report to the owner is generated from the loop carry-note + reason. This tool intentionally has no `harness` argument; loops are keyed by owner. Re-arm anytime with loop:arm.",
  guidance: {
    when: 'Stop a loop you armed with loop:arm — the goal is done, you are blocked on something external, or the user says stop. Pass `reason` when a durable stop explanation matters. In GOAL mode with the goal still active, also pass `disposition` (achieved | killed | handoff — handoff takes `handoffTo`). This owner-scoped tool intentionally does not take `harness`. Better to loop:end than burn empty wakes spinning.',
    notWhen:
      'Pause the WHOLE autoloop / routines engine — that is autoloop:control. End the autonomous hive loop — that is pot:pause.',
    chaining: 'loop:arm to start; loop:status to check; loop:end to stop.',
    seeAlso: [
      'loop:arm (start a loop)',
      'loop:status (check it)',
      'autoloop:control (pause the whole autoloop engine)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe('End the loop for this owner id (default: yourself).'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional durable reason for ending the loop; recorded in the loop transition log.'),
    disposition: z
      .enum(GOAL_DISPOSITIONS)
      .optional()
      .describe(
        "GOAL-mode wind-down verdict, REQUIRED when the target owner's goal is still active: 'achieved' | 'killed' | 'handoff'. Recorded on the goal; the owner report is auto-generated from the loop carry-note + `reason`.",
      ),
    handoffTo: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("With disposition:'handoff' — who continues the goal (owner id / label). The goal stays active."),
    outputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "P-021: the goal's reported outputs, validated against its declared output_schema. With disposition:'achieved' every declared-required output must be filled (refused otherwise); 'killed' accepts partial/absent; 'handoff' records nothing.",
      ),
    acknowledgeOpenDirectives: z
      .boolean()
      .optional()
      .describe(
        'EI-11484 guard: open owner directives soft-block loop:end (ending removes their wake render surface). Pass true to consciously proceed with them still open.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    // EI-11484 P4: while OPEN owner directives exist, ending the loop silently
    // removes the surface that re-renders them every wake — warn first;
    // acknowledgeOpenDirectives:true proceeds. Fail-open on read errors (you
    // must always be able to stop a loop you armed).
    {
      const { checkOpenDirectivesGuard } = await import('../orders/open-directives-guard');
      const guard = await checkOpenDirectivesGuard({
        workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId,
        acknowledged: args.acknowledgeOpenDirectives,
        action: 'loop:end',
      });
      if (guard) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(guard) }],
          isError: true,
        };
      }
    }
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // P-002 gate: a goal-mode owner with a still-active goal winds down WITH a
    // disposition or not at all. Positive-finding-only: every resolution miss
    // (not goal mode, goal not active, flag infra down) passes the gate.
    const activeGoal =
      workspaceId && (await windDownDispositionGateEnabled())
        ? await activeGoalForOwner({ workspaceId, ownerId }).catch(() => null)
        : null;
    if (activeGoal && !args.disposition && !activeGoal.recordedDisposition) {
      const refusal = buildDispositionRefusal({
        action: 'loop:end',
        goalId: activeGoal.goalId,
        goalTitle: activeGoal.title,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
        isError: true,
      };
    }
    // P-009 (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2): 'achieved' is a
    // CLAIM — the acceptance gate demands the vetted, independently-graded rubric.
    // Positive-finding-only (infra faults pass), and it runs BEFORE deactivateLoop so
    // a refusal never strands an already-ended loop. killed/handoff never reach it.
    if (activeGoal && args.disposition === 'achieved') {
      const acceptance = await evaluateGoalAcceptanceGate({
        goalId: activeGoal.goalId,
        goalTitle: activeGoal.title,
        goalOwner: ownerId,
      });
      if (!acceptance.satisfied) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: acceptance.code,
                message: acceptance.message,
                goalId: activeGoal.goalId,
                ...(acceptance.rubricId ? { rubricId: acceptance.rubricId } : {}),
              }),
            },
          ],
          isError: true,
        };
      }
    }
    // ── P-021: the outputs gate — BEFORE deactivateLoop, so a refusal never
    // strands an already-ended loop (same posture as the acceptance gate
    // above). 'achieved' with a declared output_schema demands every declared
    // output filled; 'killed' validates leniently; 'handoff' records nothing.
    // Canonical-datatype field checks (D-004) are not yet threaded here — the
    // seam takes `datatypeSchemas`, and plan publication already enforces it;
    // wiring the registry resolver through the wind-down doors is follow-up.
    let windDownOutputs: Record<string, unknown> | null = null;
    if (activeGoal && args.disposition) {
      const ov = evaluateGoalWindDownOutputs({
        outputSchema: activeGoal.outputSchema,
        outputs: args.outputs ?? null,
        disposition: args.disposition,
      });
      if (!ov.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: ov.code,
                message: ov.hint,
                missing: ov.missing,
                issues: ov.errors,
                goalId: activeGoal.goalId,
              }),
            },
          ],
          isError: true,
        };
      }
      windDownOutputs = ov.outputs;
    }
    // The routine row names the harness the carry-note is scoped by — read it
    // BEFORE deactivation so the report leg can still find the note.
    const statusBefore =
      activeGoal && args.disposition ? await getLoopStatus(ownerId).catch(() => null) : null;
    const ended = await deactivateLoop(ownerId, { reason: args.reason });
    // Disposition apply + owner report, FAIL-SOFT: the loop is already ended and
    // stays ended — a report failure downgrades to a warning, never un-stops.
    let dispositionApplied = false;
    let dispositionWarning: string | null = null;
    if (activeGoal && args.disposition) {
      try {
        await applyGoalDisposition({
          workspaceId,
          goalId: activeGoal.goalId,
          disposition: args.disposition,
          dispositionBy: identity.ownerId,
          handoffTo: args.handoffTo ?? null,
          outputs: windDownOutputs,
        });
        const carryNote = statusBefore
          ? await getLoopCarryNote({ harness: statusBefore.harnessSlug, ownerId }).catch(() => null)
          : null;
        const report = buildGoalWindDownReport({
          goalId: activeGoal.goalId,
          goalTitle: activeGoal.title,
          disposition: args.disposition,
          endedBy: identity.ownerId,
          action: 'loop:end',
          reason: args.reason ?? null,
          carryNote,
          handoffTo: args.handoffTo ?? null,
        });
        await deliverGoalWindDownReport(identity, {
          workspaceId,
          goalId: activeGoal.goalId,
          disposition: args.disposition,
          summary: report.summary,
          body: report.body,
        });
        dispositionApplied = true;
      } catch (e) {
        dispositionWarning = `loop ended, but recording/reporting the goal disposition failed: ${
          e instanceof Error ? e.message : String(e)
        }. Record it via goals:update and report to the owner manually.`;
      }
    }
    const control = ended
      ? await refreshControlAnchorAfterMutation({
          ownerId,
          workspaceId,
          origin: 'agent',
          actorId: identity.ownerId,
          source: 'loop:end',
        })
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ownerId,
            ended,
            controlGeneration: control?.generation ?? null,
            ...(activeGoal && args.disposition
              ? {
                  goalId: activeGoal.goalId,
                  disposition: args.disposition,
                  dispositionApplied,
                  ...(dispositionWarning ? { warning: dispositionWarning } : {}),
                }
              : {}),
            note: ended
              ? 'Loop ended — no further wakes will fire.'
              : 'No active loop found for this owner (already ended or never armed).',
          }),
        },
      ],
    };
  },
});
