/**
 * The built-in `rubric` plan-template (plan-templates-and-rubric-v2-2026-06-20 P-006).
 *
 * Phase 3's keystone: "a RUBRIC IS A PLAN" (D-002). A rubric-template plan carries
 * its STRUCTURED fields (characteristic, criteria, ratingScale, …) in the
 * `template_data` jsonb validated against THIS zod schema on write (P-005's
 * plans:set-template-data → validateTemplateData); its NARRATIVE model/method prose
 * lives in the plan body, and its top-level title in the plan frontmatter (so the
 * title has ONE home, not two). The re-pointed rubrics store (rubrics.ts) reconstructs
 * the v1 `Rubric` shape from a rubric-template plan + this validated templateData, so
 * rubrics:list/get/search + the Overwatch scorecard-emit read the SAME shape with the
 * backing changed (D-003, the scorecards.ts getRubric seam).
 *
 * This is a "schema definition" module the registry's own doc anticipates: it depends
 * only on zod + the (dependency-free) template-registry, and SELF-REGISTERS at module
 * load so both the write path (set-template-data) and the read path (the rubrics store)
 * find `rubric` without an explicit boot step. The agent-tools index also imports it
 * for side-effect (belt-and-suspenders + discoverability).
 */
import { z } from 'zod';
import { registerPlanTemplate, type PlanTemplate } from './template-registry';

/** The template TYPE name — a rubric-template plan's `template:` frontmatter/column. */
export const RUBRIC_TEMPLATE_NAME = 'rubric';

/**
 * One gradeable criterion of a rubric. Field-for-field the v1 `RubricCriterion`
 * (rubrics.ts) so the re-pointed store maps templateData → Rubric 1:1 with no drift
 * (a compile-time assignability check pins this in rubric-template.test.ts). A
 * structured observation's `ratings` Record is keyed by `key`.
 */
export const rubricCriterionSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .describe("stable kebab id; a structured observation's ratings Record is keyed by this"),
    title: z.string().min(1).describe('short human label for the criterion'),
    model: z.string().min(1).describe('how this criterion is supposed to work (the MODEL)'),
    method: z.string().min(1).describe('how to investigate it (the METHOD: signals / queries)'),
    driftMarkers: z.string().min(1).describe('what a degraded / broken state looks like'),
    ratingScale: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("optional per-criterion override of the rubric's default rating scale"),
  })
  .strict();

/**
 * The `rubric` template's structured data (the `template_data` jsonb). EXACTLY the
 * brief's fields — characteristic, criteria:[{key,title,model,method,driftMarkers}],
 * ratingScale — plus the optional methodRef + description the v1 Rubric also surfaces
 * (so the re-pointed reads return the full shape consumers depend on). `.strict()` so
 * an unknown/typo'd field fails loud on write (the D-004 fail-loud theme), never silent-
 * strips. NB: the rubric's top-level TITLE is NOT here — it derives from the plan
 * frontmatter title (one source of truth); the long-form narrative lives in the body.
 */
export const rubricTemplateDataSchema = z
  .object({
    characteristic: z
      .string()
      .min(1)
      .describe('umbrella domain, e.g. "hive-coordination" — Scout\'s digest groups by this'),
    criteria: z
      .array(rubricCriterionSchema)
      .min(1)
      .describe('the per-characteristic gradeable criteria (a structured observation grades each)'),
    ratingScale: z
      .array(z.string().min(1))
      .min(1)
      .describe('the rubric\'s default rating vocabulary, e.g. ["healthy","degraded","broken","unknown"]'),
    methodRef: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('agent-insights runbook slug holding the long-form METHOD (no prose duplication)'),
    description: z
      .string()
      .optional()
      .describe('one-line summary; the long-form narrative lives in the plan body'),
  })
  .strict();

/** The validated structured-data type for a `rubric` template instance. */
export type RubricTemplateData = z.infer<typeof rubricTemplateDataSchema>;

/** The registry entry for the `rubric` built-in template type. */
export const RUBRIC_TEMPLATE: PlanTemplate = {
  name: RUBRIC_TEMPLATE_NAME,
  description:
    'A shared STANDARD for a system characteristic: criteria (key/title/model/method/driftMarkers) that structured observations grade, plus a rating scale. A rubric IS a plan (template:rubric); rubrics:list/get/search query these.',
  schema: rubricTemplateDataSchema,
};

// Self-register at module load so the write path (plans:set-template-data →
// validateTemplateData) and the read path (the rubrics store re-point) both resolve
// `rubric` without a separate boot step. Idempotent (registerPlanTemplate is by name).
registerPlanTemplate(RUBRIC_TEMPLATE);
