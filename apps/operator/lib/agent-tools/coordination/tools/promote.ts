/**
 * plans:promote — promote a plan into a harness as new SPEC.md
 * criteria + (separately) features.
 *
 * agent-coordination-architecture-v2 §11. v0.5 scope:
 *
 *   - **Preview**: computes the new SPEC.md body (current + new
 *     [SC-NNN]-tagged criteria with provenance) and the per-feature
 *     covers mapping. Returns it as JSON so the caller can review,
 *     then PUT it to the operator's /spec endpoint themselves.
 *   - **plan_event**: records the promote in coord/plan-events.jsonl
 *     so the history viewer surfaces it.
 *
 * v0.5 deferred (becomes v1 — see commit message + implementation
 * report):
 *   - The actual `PUT /:slug/spec` + `POST /:slug/features/import`
 *     apply calls. Once /features/import supports omitted ids
 *     (allocating server-side) and PUT /spec carries optimistic-
 *     concurrency, the tool wires them in.
 *   - Marking the promoted plan items via withPlanLock + set-status.
 *   - Scoper coverage set-diff (so MODE=replan won't dup features).
 *
 * Reads the plan via `parsePlan` to validate the slug exists and to
 * surface item IDs back in the preview.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { buildSpecMutation, type PromoteFeatureInput } from '../promote';
import { emitPlanEventForCaller } from '../plan-events';
import { readPlanBySlug } from '../../plans/source';

const FEATURE_INPUT = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  acceptance: z.array(z.string().min(1)).optional(),
  from_items: z
    .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
    .optional(),
});

export default defineTool({
  name: 'plans:promote',
  description:
    'Promote a `plans:*` plan into a harness — compute the SPEC.md mutation (new [SC-NNN]-tagged criteria with provenance) and the per-feature covers mapping. v0.5: preview-only (returns the new SPEC body + covers JSON; the apply path is a documented follow-up). Always emits a `plan_event` of kind=promoted so the history viewer records it.',
  guidance: {
    when: 'A plan is ready to enter the harness — you and the human (and any expert agents) have settled the feature list and acceptance criteria.',
    notWhen: 'Routine plan edits — plans:set-now / plans:add-item already cover those. Mid-debate — promote only once the design is settled.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).describe('Plan slug to promote.'),
    harness_slug: z
      .string()
      .min(1)
      .describe('Target harness slug. SPEC.md lives at that harness root.'),
    current_spec: z
      .string()
      .describe('The current contents of the target harness SPEC.md (read by the caller; the tool does not fetch).'),
    features: z.array(FEATURE_INPUT).min(1).max(40),
    feature_ids: z
      .array(z.string().regex(/^F-[A-Za-z0-9-]+$/))
      .optional()
      .describe('Optional caller-allocated F-NNN ids per feature. When omitted, the preview reports covers without a feature_id binding.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    // Validate the plan exists.
    const planFile = await readPlanBySlug(args.slug);
    if (!planFile) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'plan_not_found',
              detail: `no plan with slug ${args.slug}`,
            }),
          },
        ],
        isError: true,
      };
    }
    const planTitle =
      (planFile.parsed.frontmatter as { title?: string } | null)?.title ??
      args.slug;

    const features: PromoteFeatureInput[] = args.features.map((f) => ({
      title: f.title,
      body: f.body,
      acceptance: f.acceptance,
      from_items: f.from_items,
    }));

    const mutation = buildSpecMutation({
      currentSpec: args.current_spec,
      planSlug: args.slug,
      authorOwnerId: identity.ownerId,
      features,
      featureIds: args.feature_ids,
    });

    // History event — recorded whether or not anyone applies the mutation.
    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'promoted',
      after: {
        harness_slug: args.harness_slug,
        feature_count: args.features.length,
        sc_ids: mutation.criteria.map((c) => c.id),
      },
      detail: `promoted to ${args.harness_slug}: ${args.features.length} feature(s), ${mutation.criteria.length} criteria`,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            plan_title: planTitle,
            preview: {
              new_spec: mutation.newSpec,
              added_criteria: mutation.criteria,
              per_feature_covers: mutation.perFeatureCovers,
            },
            apply_hint: {
              spec_put_endpoint: `/api/harness/${args.harness_slug}/spec`,
              features_import_endpoint: `/api/harness/${args.harness_slug}/features/import`,
              note:
                'v0.5: this tool returns the computed preview. To apply, PUT the new_spec to spec_put_endpoint ({spec: new_spec}) and POST {features: [...with metadata.source_plan + metadata.covers...]} to features_import_endpoint. Wiring those calls into this tool is a documented follow-up.',
            },
          }),
        },
      ],
    };
  },
});
