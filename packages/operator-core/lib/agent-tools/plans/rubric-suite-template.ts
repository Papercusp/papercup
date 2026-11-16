/** A rubric suite is structured data on a plan, never a second membership store. */
import { z } from 'zod';
import { registerPlanTemplate } from './template-registry';

export const RUBRIC_SUITE_TEMPLATE_NAME = 'rubric-suite';

// Identities are retained intact. In particular, do not trim a rubric ref into
// a different identity or silently discard an unrecognized member field.
const identity = z.string().min(1).refine(
  (value) => value === value.trim() && !/[\r\n]/.test(value),
  'An identity must be nonempty and contain no surrounding whitespace or line breaks',
);

export const rubricSuiteTemplateDataSchema = z.object({
  purpose: z.string().min(1),
  owner: identity,
  members: z.array(z.object({ rubricRef: identity }).strict()),
  rescoreIntervalMs: z.number().int().positive().safe().optional(),
}).strict().superRefine((suite, ctx) => {
  const seen = new Set<string>();
  for (const [index, member] of suite.members.entries()) {
    if (seen.has(member.rubricRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'rubricRef'],
        message: `Duplicate suite member: ${member.rubricRef}`,
      });
    }
    seen.add(member.rubricRef);
  }
});

export type RubricSuiteTemplateData = z.infer<typeof rubricSuiteTemplateDataSchema>;

registerPlanTemplate({
  name: RUBRIC_SUITE_TEMPLATE_NAME,
  description: 'A named group of rubrics with one worst-member verdict; membership lives on this plan.',
  schema: rubricSuiteTemplateDataSchema,
});
