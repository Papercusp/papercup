/**
 * plans:get-template-data — read a plan's template TYPE + its STRUCTURED instance
 * data (the `template_data` jsonb), WITHOUT loading/parsing the markdown
 * (plan-templates-and-rubric-v2-2026-06-20 P-005).
 *
 * The structured read complement of plans:set-template-data: agents consume a
 * template-instance plan's data structured, never by scraping markdown. Returns the
 * `template` type (frontmatter-derived column), the `template_data` jsonb (null
 * until set), and the row `version`. Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:get-template-data',
  description:
    "Read a plan's template TYPE + its STRUCTURED instance data (the `template_data` jsonb) — the structured read complement of plans:set-template-data, without parsing the markdown. Returns { template, templateData, version }; templateData is null until set. Read-only.",
  guidance: {
    when: 'Reading a template-instance plan\'s structured data (e.g. a rubric instance\'s fields) to consume it programmatically — never scrape it out of the markdown.',
    notWhen:
      'You need the whole plan (Now / items / decisions / prose) — plans:get. Writing the data — plans:set-template-data. Listing plans of a template type — plans:list { template }.',
    chaining: 'plans:get-template-data { slug } → plans:set-template-data { slug, data } to update it.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  // + overwatch (read-only, like plans:get-item) so the supervisor can ground on template instances.
  agentRoles: [...SU_ROLES, 'overwatch'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const row = await getPlanRow(args.slug, opts);
    if (!row) return text({ error: 'not_found', slug: args.slug }, true);

    return text({
      ok: true,
      slug: row.planSlug,
      template: row.template,
      templateData: row.templateData ?? null,
      version: row.version,
    });
  },
});
