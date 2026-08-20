/** plans:evaluate-spec-quality — exact current plan-spec quality scorecard draft. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts, resolveEffectiveHarnessSlug } from './_ctx-opts';
import { readPlanBySlug } from './source';
import { listSpecClauses } from './spec-clauses-store';
import { evaluatePlanSpecQuality } from './spec-quality';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z.enum(PLAN_CLASS_RUBRIC_REFS),
});

export default defineTool({
  name: 'plans:evaluate-spec-quality',
  description:
    'Grade a plan\'s exact current first-class spec set against the reusable spec-quality rubric, specialized by plan class. Returns a scorecards:emit-compatible draft, exact specSetHash, and every would-block reason; read-only.',
  guidance: {
    when: 'Before plans:start or direct item promotion for a plan that has adopted first-class spec clauses.',
    notWhen: 'Authoring clauses — use plans:set-specs. Grading implementation proof — use plans:evaluate-spec-test-adequacy.',
    chaining:
      'plans:get-specs → plans:evaluate-spec-quality { classRef } → scorecards:emit the returned draft → plans:start. Any spec revision changes specSetHash and requires a fresh scorecard.',
    seeAlso: ['plans:get-specs', 'scorecards:emit', 'rubrics:get spec-quality'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const read = await readPlanBySlug(args.slug, await ctxToPlanSourceOpts(sctx));
    if (!read) {
      return { data: { ok: false, error: 'plan_not_found', slug: args.slug, harnessSlug } };
    }
    const planItemIds = (read.row.items.length ? read.row.items : read.parsed.items).map((item) => item.id);
    const clauses = await listSpecClauses({ harnessSlug, planSlug: args.slug });
    const evaluation = evaluatePlanSpecQuality({
      planSlug: args.slug,
      planItemIds,
      clauses,
      classRef: args.classRef,
    });
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        ...evaluation,
      },
    };
  },
});
