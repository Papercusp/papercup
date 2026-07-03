/**
 * scout:ideation-feedback — the SU IDEATE-pass read of "your own past graded proposals".
 *
 * su-loop-capability-parity-2026-07-03 P-005 (D-009): SU sessions ORIGINATE feature ideas
 * (improvements:capture kind:'feature'), which now earn `origin='su-ideate'` rows on the routed
 * ledger. This returns the owner/Queen grades + critiques on those su-ideate ideas as the SAME
 * grader-feedback PRIMING block Scout's own ideators consume (reuses formatGraderFeedbackPriming
 * via gatherGraderFeedbackPriming) — so an IDEATE pass builds on what landed and what the grader
 * flagged, instead of a cold start. Read-only, origin-scoped to 'su-ideate', so it NEVER touches
 * Scout's per-lens weight learning (which reads origin='scout').
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { gatherGraderFeedbackPriming } from '../../scout/ideator-feedback-priming';

export default defineTool({
  name: 'scout:ideation-feedback',
  description:
    "Your IDEATE-pass read of your OWN past graded proposals: the owner/Queen grades + critiques on features you filed (improvements:capture kind:'feature'), formatted as a grader-feedback priming block (newest-first; owner grades outrank Queen volume grades). Read-only; su-ideate origin only — never touches Scout's lens-weight learning.",
  capability: 'curation:read',
  guidance: {
    when: 'Opening an IDEATE-mode grounding pre-pass — pull this to see how your past feature proposals were graded, so the pass builds on what landed / what the grader flagged rather than starting cold. Pairs with curation:state-of-hive + rubrics:list + scorecards:freshness as the IDEATE grounding reads.',
    notWhen:
      "Grading an idea — that is scout:grade-idea. Reading Scout's OWN lens-routed ideas or lens weights — a different, lens-learning surface; this returns your su-ORIGINATED ideas only.",
    chaining:
      'curation:state-of-hive + rubrics:list + scorecards:freshness + scout:ideation-feedback → your IDEATE pass, grounded.',
    seeAlso: [
      'scout:grade-idea (record a grade on a routed idea)',
      'improvements:capture (file a kind:"feature" — it becomes a su-ideate ledger row)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('scope to one harness (default: the whole workspace)'),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('window size (default 10, newest-first)'),
  }),
  async handler(args) {
    const { priming, entries } = await gatherGraderFeedbackPriming({
      origin: 'su-ideate',
      ...(args.harness ? { harnessSlug: args.harness } : {}),
      ...(args.maxEntries ? { maxEntries: args.maxEntries } : {}),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            priming:
              priming ||
              'No graded su-ideate proposals yet — file features (improvements:capture kind:"feature") and they appear here once the owner/Queen grades them.',
            entries,
            count: entries.length,
          }),
        },
      ],
    };
  },
});
