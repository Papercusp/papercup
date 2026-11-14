/** P-022: declared work, separate from completion evidence and body prose. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CompletionVerifiedHowSchema } from './coord-lifecycle/records';

const text = z.string().trim().min(1).max(4000);
const entries = z.array(text).max(100);

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const WorkDefinitionAssessmentSchema = z.object({
  rubricRef: text,
  rubricRevision: z.number().int().positive(),
  criteriaHash: hash,
  subject: z.object({
    kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'fleet', 'rubric', 'scorecard']),
    ref: text,
    windowStart: instant,
    windowEnd: instant,
  }).strict().refine(s => Date.parse(s.windowStart) < Date.parse(s.windowEnd), {
    message: 'assessment window must have positive duration',
  }),
  criterionKeys: entries.min(1).refine(keys => new Set(keys).size === keys.length, {
    message: 'assessment criterion keys must be unique',
  }),
}).strict();
export type WorkDefinitionAssessment = z.infer<typeof WorkDefinitionAssessmentSchema>;
export const WorkDefinitionApprovalSourceSchema = z.object({
  directiveId: z.number().int().positive(),
  principalId: text,
  sourceTurnRef: text.regex(/^session_turn:(?:claude|codex|omp|agent_chat):[^:]+:[0-9]+$/),
  bodySha256: hash,
  /** D-009: optional exact immutable proposal selected by the captured owner turn. */
  proposal: z.object({ reportId: text.max(200), bodySha256: hash }).strict().optional(),
}).strict();
export type WorkDefinitionApprovalSource = z.infer<typeof WorkDefinitionApprovalSourceSchema>;

/** The approval signs these fields plus the assessment tuple. Its source hash
 * is metadata, excluded from its own signed body to avoid a recursive hash. */
export const WorkItemDefinitionFieldsSchema = z.object({
  acceptanceCriteria: entries.min(1).optional(),
  scope: z.object({ inScope: entries, outOfScope: entries }).strict().optional(),
  verificationTarget: z.object({
    target: text,
    verifiedHow: CompletionVerifiedHowSchema.optional(),
  }).strict().optional(),
  firstUnit: text.optional(),
}).strict();
export type WorkItemDefinitionFields = z.infer<typeof WorkItemDefinitionFieldsSchema>;
export const WorkItemDefinitionSchema = WorkItemDefinitionFieldsSchema.extend({
  assessmentScope: z.object({ assessment: WorkDefinitionAssessmentSchema,
    source: WorkDefinitionApprovalSourceSchema }).strict().optional(),
}).strict().refine((value) => Object.values(value).some((v) => v !== undefined), {
  message: 'definition must declare at least one work field',
});

export type WorkItemDefinition = z.infer<typeof WorkItemDefinitionSchema>;
export const WORK_ITEM_DEFINITION_KEY = 'workDefinition';

export class WorkItemDefinitionChangedError extends Error {
  readonly code = 'work_definition_changed';

  constructor() {
    super('The work definition changed after completion validation. Re-read it and verify the current criteria before closing. No completion record or state transition was written.');
    this.name = 'WorkItemDefinitionChangedError';
  }
}

/** Compare raw JSON, including an absent legacy definition, while the caller holds its write fence. */
export function assertWorkItemDefinitionUnchanged(payload: unknown, expected: unknown): void {
  const actual = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[WORK_ITEM_DEFINITION_KEY] : undefined;
  if (!isDeepStrictEqual(actual ?? null, expected ?? null)) throw new WorkItemDefinitionChangedError();
}

/** No fallback to headings: legacy prose is converted explicitly by P-019. */
export function readWorkItemDefinition(payload: unknown): WorkItemDefinition | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[WORK_ITEM_DEFINITION_KEY];
  const parsed = WorkItemDefinitionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
