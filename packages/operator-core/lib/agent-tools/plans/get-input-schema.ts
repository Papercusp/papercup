/**
 * plans:get-input-schema — read a plan's declared input schema, which fields are
 * REQUIRED, and which of those are currently unsatisfied
 * (plan-structured-inputs-2026-08-01 P-003).
 *
 * The structured read complement of plans:set-input-schema. Deliberately returns
 * `missing` alongside the schema: "what does this plan need before it can start"
 * is the question every caller of this verb actually has — a UI rendering the input
 * form, an agent about to launch a plan, a human staring at a refused start — and
 * making them re-derive it from `required` minus the keys of `templateData` would
 * be three call sites re-implementing the gate's own rule slightly differently.
 * The value comes from the SAME helper the start gate uses, so the answer here and
 * the refusal there cannot disagree.
 *
 * Also reports `source` so a caller can tell the two schema sources apart without
 * inferring it: 'input-schema' (plan-authored JSON Schema), 'template' (a
 * code-registry zod type), or 'none'. Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';
import {
  jsonSchemaRequiredKeys,
  missingRequiredJsonSchemaKeys,
} from '../../json-schema-validation';

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe('Plan slugs to read in one call.'),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  });

export default defineTool({
  name: 'plans:get-input-schema',
  description:
    "Read a plan's declared input schema (the `input_schema` jsonb), its REQUIRED field names, and which required fields are still missing from the supplied values. Returns { source: 'input-schema'|'template'|'none', inputSchema, template, required, missing, version }. `missing` is computed by the same helper the start gate uses, so it cannot disagree with a refusal. Read-only.",
  guidance: {
    when: "Finding out what a plan needs before it can start — rendering an input form, or checking why a start was refused. `missing` answers it directly.",
    notWhen:
      'Declaring the schema — plans:set-input-schema. Supplying the values — plans:set-template-data. Reading the values themselves — plans:get-template-data.',
    chaining:
      'plans:get-input-schema { slug } → plans:set-template-data { slug, data } to fill `missing` → plans:start.',
    seeAlso: [
      'plans:set-input-schema (declare it)',
      'plans:get-template-data (the values this schema constrains)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const row = await getPlanRow(slug, opts);
        if (!row) return { ok: false as const, slug, error: 'not_found' };
        const schema = (row.inputSchema ?? null) as Record<string, unknown> | null;
        // A registry `template` type carries its required-ness in code (its zod
        // schema), not in a readable array — so `required`/`missing` are reported
        // for the plan-authored source only, and `source` says which you have.
        // The start gate still enforces the registry path; it just surfaces the
        // failure as invalid_data issues rather than a name list.
        const source = schema ? 'input-schema' : row.template ? 'template' : 'none';
        return {
          ok: true as const,
          slug: row.planSlug,
          source,
          inputSchema: schema,
          template: row.template,
          required: jsonSchemaRequiredKeys(schema),
          missing: missingRequiredJsonSchemaKeys(schema, row.templateData),
          version: row.version,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
