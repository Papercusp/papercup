/**
 * experiment:run — run an experiment via the eval-battery engine and get the per-arm
 * judge scores + the compareArms verdict (`experiment-registry-invocation-api` P-031).
 *
 * v1 executes the OFFLINE replay tier, riding the frontier:replay-harness flag +
 * governor budget (origin-tagged spend; refuses with NO spend when dark/unbudgeted/
 * exhausted). The logic lives in the pure, injectable run-core; this is the thin tool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { runGovernedReplay } from '../../replay/governed';
import { runExperiment } from '../../experiment/run-core';
import { experimentJudge, experimentReplayRunner } from '../../experiment/replay-ports';

export default defineTool({
  name: 'experiment:run',
  description:
    'Run an experiment: A/B a knob change against a battery via the eval-battery engine and get per-arm judge scores + the compareArms verdict. v1 runs the OFFLINE replay tier — re-run each synthetic case under each arm’s policy overlay and score outcome/process/divergence. Rides frontier:replay-harness (flag + governor budget; origin-tagged spend); refuses with NO spend if the replay flag is off or the budget is exhausted. Arms must address only the test’s knobSlice (experiment:catalog). A winner is a PROPOSAL — applying it rides commit→reproject + graduation, never this tool.',
  guidance: {
    when: 'Testing how a knob change performs before adopting it — screen a policy/prompt overlay against a battery on the cheap offline replay tier; the result ranks arms vs the baseline.',
    notWhen: 'Discovery (experiment:catalog). Scoring one gym run (gym:judge/gym:signals). Applying a winner to live prompts — that rides commit→reproject + graduation (D-006), never here.',
    chaining: 'experiment:catalog → pick testId + read knobSlice → experiment:run → (winner is a proposal).',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel'),
  args: z.object({
    testId: z.string().default('replay').describe('The test id from experiment:catalog. v1 executes only the offline "replay" tier; others are staged.'),
    batteryId: z.string().min(1).describe('Groups this run’s cells/rows.'),
    arms: z
      .array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          knobs: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1)
      .describe('Variants to compare. An arm with empty knobs is the baseline; knob addresses must be within the test’s knobSlice (e.g. overlay.systemOverlay for replay).'),
    cases: z
      .array(
        z.object({
          caseId: z.string(),
          context: z.string().describe('The context the agent resumes from.'),
          intent: z.string().describe('The task the judge scores against.'),
          projectContext: z.string().optional(),
        }),
      )
      .min(1)
      .describe('Synthetic battery cases (v1) — each judged per arm.'),
    repeats: z.number().int().positive().max(10).default(1),
    budgetUsd: z.number().positive().optional().describe('Per-run spend cap; the frontier:replay-harness governor budget is the upstream gate.'),
    maxDistillChars: z.number().int().positive().optional(),
    replayModel: z.string().optional().describe('Model for the replayed continuation (default claude-sonnet-4-6).'),
    maxOutputTokens: z.number().int().positive().max(8000).optional(),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const outcome = await runExperiment(
      {
        testId: args.testId,
        batteryId: args.batteryId,
        arms: args.arms,
        cases: args.cases,
        repeats: args.repeats,
        budgetUsd: args.budgetUsd,
        maxDistillChars: args.maxDistillChars,
      },
      { workspaceId },
      {
        runGovernedReplay,
        replayRunner: experimentReplayRunner(args.replayModel, args.maxOutputTokens),
        judge: await experimentJudge(),
      },
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] };
  },
});
