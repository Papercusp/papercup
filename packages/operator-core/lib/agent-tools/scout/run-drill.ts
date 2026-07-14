/** blender:run-drill — deployed, provenance-isolated P-013 release probe. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

import { runBlenderRubricDrill } from '../../scout/rubric-live-drill';

export const runDrillArgs = z
  .object({
    harnessSlug: z
      .string()
      .min(1)
      .default('papercusp')
      .describe('harness whose deployed Blender composition to exercise'),
    sourceHive: z
      .string()
      .min(1)
      .optional()
      .describe('source-hive tag for the planted rubric ref (default: harnessSlug)'),
  })
  .strict();

export default defineTool({
  name: 'blender:run-drill',
  description:
    "Run the deployed P-013 Blender rubric-seeding health drill now: plant an origin='drill' broken-criterion scorecard, drive the production digest→ideation→routing composition with a bounded deterministic model seam, persist + grade origin='drill' routes, and prove the organic routed/tick/lens counters did not change. Synthetic artifacts remain excluded from organic learning and work queues. Returns ok only when every live assertion passes.",
  capability: 'harness:write',
  guidance: {
    when:
      'Before a public release, after a Blender pipeline change, or when blender-release-readiness requires fresh deployed origin=drill evidence.',
    notWhen:
      'Measuring organic idea quality or generating a real proposal — use blender:success-metrics / the normal Scout cadence. This is a synthetic, provenance-isolated health probe.',
    chaining:
      "blender:run-drill → require ok:true and evidence.organicMetricsUnchanged:true → score blender-release-readiness → scorecards:list/rubrics:trend.",
    seeAlso: [
      'blender:success-metrics (organic program done-check)',
      'blender:grade-idea (grade a real routed idea)',
      'scorecards:list (release scorecard evidence)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: runDrillArgs,
  async handler(args) {
    const result = await runBlenderRubricDrill(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
