import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * voice:delegate_deep — the Sentinel's deep-thinking delegation lane
 * (voice-unified-sentinel-pipeline-2026-07-01, P-005/P-006, D-003).
 *
 * HARD THINKING (analysis / research / comparison where the user expects an
 * ANSWER back in the conversation) must not block the conversational pane, and
 * must not go to the Queen (she orchestrates; her wake loop is placement-shaped,
 * not an answer channel). This tool mints a durable `deep-delegation` work_item
 * and spawns an EPHEMERAL background su agent (capped at 2 in flight) whose
 * completion.summary is injected back into the pane as `[deep-answer WI-NNN] …`
 * — spoken + written through the one pipeline.
 *
 * THE TOOL SPAWNS, NOT THE SENTINEL: the sentinel role still holds no
 * cup:spawn capability (the SN-H04 no-spawn contract); this is the
 * accountable, capped indirection. Split of lanes: buildable WORK still goes to
 * the Queen via handoff; THINKING comes here.
 */
export default defineTool({
  name: 'voice:delegate_deep',
  profile: 'engineer',
  description:
    'Delegate a HARD-THINKING question (analysis/research/deep comparison) to an ephemeral background agent. The answer comes back into your pane as `[deep-answer WI-NNN] …` — present + speak it then. Capped at 2 in flight.',
  capability: 'operator:read',
  guidance: {
    when: `The user asked something that needs REAL investigation (minutes of reading code/state/docs) and expects an ANSWER back in conversation. Delegate it, voice:say a short ack ("digging into that — I'll come back to you"), and stay responsive. When the [deep-answer WI-NNN] message arrives in your pane, present it: voice:say the speakable core + show the detail.`,
    notWhen: `Trivia you can answer now (just answer). Buildable WORK ("build X", "fix Y") — that's a Queen handoff, not a deep dive. More than 2 in flight — the tool refuses; tell the user one is already cooking.`,
    chaining: `voice:delegate_deep { question } → voice:say the ack → (later) the [deep-answer] arrives as pane input → voice:say the answer. Check progress via work_items:get on the returned workItemId.`,
    seeAlso: ['voice:say (speak the ack + the answer)', 'work_items:get (progress on a delegation)'],
  },
  requirePrincipal: false,
  // The pane Sentinel is the primary caller; the operator persona may delegate too.
  agentRoles: ['papercup', 'operator'],
  rolesQuota: { sentinel: { perRun: 50 }, papercup: { perRun: 50 }, operator: { perRun: 50 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  args: z.object({
    question: z.string().min(1).describe("The user's question, as asked — the whole ask, not a fragment."),
    brief: z
      .string()
      .optional()
      .describe('Optional context the agent needs (recent conversation excerpt, constraints, refs).'),
    harness: z
      .string()
      .optional()
      .describe('Harness the background agent spawns into (default: the hive home).'),
  }),
  async handler(args, ctx) {
    // Lazy imports keep the spawn/DBOS chain off the tool-mount path (the same
    // reason fleet/spawn.ts dynamic-imports operator-spawn).
    const [{ delegateDeep }, { defaultDeepDelegateDeps }, { activeWorkspaceId }] =
      await Promise.all([
        import('../../sentinel/sentinel-deep-delegate'),
        import('../../sentinel/sentinel-deep-delegate-deps'),
        import('../../workspace-registry'),
      ]);
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    const result = await delegateDeep(
      {
        question: args.question,
        brief: args.brief ?? null,
        harness: args.harness ?? null,
        workspaceId,
      },
      defaultDeepDelegateDeps(),
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
