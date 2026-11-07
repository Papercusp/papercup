/** P-022: declared work, separate from completion evidence and body prose. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CompletionVerifiedHowSchema } from './coord-lifecycle/records';

const text = z.string().trim().min(1).max(4000);
const entries = z.array(text).max(100);

export const WorkItemDefinitionSchema = z.object({
  acceptanceCriteria: entries.min(1).optional(),
  scope: z.object({ inScope: entries, outOfScope: entries }).strict().optional(),
  verificationTarget: z.object({
    target: text,
    verifiedHow: CompletionVerifiedHowSchema.optional(),
  }).strict().optional(),
  firstUnit: text.optional(),
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
