/**
 * blender:success-metrics — the blender-self-learning program's DONE-CHECK, as a tool
 * (blender-self-learning-2026-07-12 P-015).
 *
 * P-015 asked for the program's success metrics to become a QUERYABLE check. This is that
 * surface: it reads the ledgers the program itself shipped (scout_ticks + the routed-idea
 * ledger, su-ideate partition) and answers the five bars the plan set, each PASS / FAIL /
 * UNKNOWN with the measurement behind it.
 *
 * Why a tool and not a routine: the program's own founding defect was a metric nobody could
 * SEE (the rubric grounding lane sat at zero for its entire life while every test stayed
 * green). A check that only a background routine can run reproduces that failure — the
 * scout quality-degradation watchdog next door was built, tested, and never wired to a
 * caller, so it has never once run. An agent-callable verb is what makes the gate real.
 *
 * Read-only. Never throws on an empty window: an empty denominator is reported as UNKNOWN,
 * which is NOT a pass — an unrun program must never certify itself done.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { buildProgramSuccessReport, type ProgramSuccessReport } from '../../scout/success-metrics';

export const successMetricsArgs = z
  .object({
    harnessSlug: z
      .string()
      .min(1)
      .optional()
      .describe('scope the ledger + tick reads to one harness (default: the whole workspace)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'max routed-idea ledger rows to read (default 500). A read that hits this cap reports the reconciliation bar as UNKNOWN rather than failing on rows it never fetched — raise it to judge a longer history.',
      ),
    tickLimit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        'optional safety cap inside the default 48h scout_ticks time box. Omit to read the complete time box; this is not the release window definition.',
      ),
    maxErrorRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('cycle error-rate bar (default 0.05 — the plan\'s <5%, down from the historical ~30%)'),
  })
  .strict();
export type SuccessMetricsArgs = z.infer<typeof successMetricsArgs>;

export async function runSuccessMetrics(
  args: SuccessMetricsArgs,
): Promise<{ ok: true; report: ProgramSuccessReport } | { ok: false; error: string }> {
  try {
    const report = await buildProgramSuccessReport({
      ...(args.harnessSlug ? { harnessSlug: args.harnessSlug } : {}),
      ...(args.limit != null ? { limit: args.limit } : {}),
      ...(args.tickLimit != null ? { tickLimit: args.tickLimit } : {}),
      ...(args.maxErrorRate != null ? { maxErrorRate: args.maxErrorRate } : {}),
    });
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

export default defineTool({
  name: 'blender:success-metrics',
  description:
    "The blender-self-learning program's done-check, over the LIVE ledgers: six bars — rubric-grounded routed ideas >0, zero score-0 cycles fired, cycle error rate <5% over a time-boxed 48h singleton-tick window, ledger rows reconcile with tick routed counts (per cycle), >=1 grader suggestion adopted with attribution, and recent lens diversity — each PASS/FAIL/UNKNOWN with the measurement behind it. verdict='pass' only when every bar passes; 'incomplete' when a bar has no evidence yet (an empty window never certifies the program done); 'fail' on any real regression. Read-only.",
  capability: 'curation:read',
  guidance: {
    when: "Checking whether the self-learning substrate is actually WORKING on real rows — closing out the blender-self-learning program, or auditing whether rubric-grounded ideation / volume-mode cadence / grading throughput are live rather than merely shipped.",
    notWhen:
      'Asking whether Scout ideas are getting BETTER over time (that is the quality/degradation report — this is an absolute done-check, not a trend). Grading an individual idea (blender:grade-idea).',
    chaining:
      "blender:success-metrics → read `verdict`: 'incomplete' names which bar lacks evidence (act on THAT bar's unknownReason); 'fail' names the regression + the rows behind it.",
    seeAlso: ['blender:ideation-feedback (your own graded-idea priming)', 'blender:grade-idea (grade one routed idea)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: successMetricsArgs,
  async handler(args) {
    const out = await runSuccessMetrics(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      ...(out.ok ? {} : { isError: true }),
    };
  },
});
