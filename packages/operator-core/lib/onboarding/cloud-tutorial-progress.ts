import type { Sql } from 'postgres';
import { z } from 'zod';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION, type SavedTutorialProgress, type TutorialScope } from './cloud-tutorial-lesson';

const receipt = z.object({ sessionId: z.string().min(1).max(160), taskId: z.string().min(1).max(160), resultId: z.string().min(1).max(160) }).strict();
export const tutorialProgressUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative().safe(),
  mutationId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  disposition: z.enum(['active', 'paused', 'skipped', 'closed']),
  inspectedResult: receipt.optional(),
}).strict();
export type TutorialProgressUpdate = z.infer<typeof tutorialProgressUpdateSchema>;
export interface TutorialProgressRecord { revision: number; mutationId: string | null; progress: SavedTutorialProgress }
export class TutorialProgressConflict extends Error {
  constructor(readonly current: TutorialProgressRecord) { super('tutorial_progress_conflict'); }
}
function progressKey(scope: TutorialScope): string {
  return JSON.stringify([scope.workspaceId, CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION]);
}
function empty(scope: TutorialScope): TutorialProgressRecord {
  return { revision: 0, mutationId: null, progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition: 'active' } };
}
/** Never use the ambient workspace or an admin connection. A verified hosted
 * tenant transaction supplies these GUCs and the hosted_app RLS role. */
async function assertTransactionScope(tx: Sql, scope: TutorialScope): Promise<void> {
  const [binding] = await tx<{ organization: string; user: string; workspace: string }[]>`
    SELECT current_setting('app.organization_id', true) AS organization,
           current_setting('app.user_id', true) AS "user",
           current_setting('app.workspace_id', true) AS workspace`;
  if (!binding || binding.organization !== scope.tenantId || binding.user !== scope.userId || binding.workspace !== scope.workspaceId) throw new Error('tutorial_scope_mismatch');
}
function decode(scope: TutorialScope, value: unknown): TutorialProgressRecord {
  if (value === undefined || value === null) return empty(scope);
  const schema = z.object({ revision: z.number().int().positive().safe(), mutationId: z.string(), progress: z.object({
    lessonId: z.literal(CLOUD_TUTORIAL_ID), version: z.literal(CLOUD_TUTORIAL_VERSION),
    scope: z.object({ tenantId: z.literal(scope.tenantId), userId: z.literal(scope.userId), workspaceId: z.literal(scope.workspaceId) }).strict(),
    disposition: tutorialProgressUpdateSchema.shape.disposition, inspectedResult: receipt.optional(),
  }).strict() }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('tutorial_progress_invalid');
  return parsed.data;
}
export async function readTutorialProgress(tx: Sql, scope: TutorialScope): Promise<TutorialProgressRecord> {
  await assertTransactionScope(tx, scope);
  const [row] = await tx<{ record: unknown }[]>`
    SELECT profile #> ARRAY['cloudTutorial', ${progressKey(scope)}]::text[] AS record
    FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid`;
  return decode(scope, row?.record);
}
/** Caller must hold the surrounding tenant transaction: the row lock makes
 * CAS atomic across tabs and preserves unrelated profile keys/workspaces. */
export async function updateTutorialProgress(tx: Sql, scope: TutorialScope, input: TutorialProgressUpdate): Promise<TutorialProgressRecord> {
  const patch = tutorialProgressUpdateSchema.parse(input);
  await assertTransactionScope(tx, scope);
  await tx`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id)
    VALUES (${scope.tenantId}::uuid, ${scope.userId}::uuid) ON CONFLICT (organization_id, user_id) DO NOTHING`;
  const [row] = await tx<{ profile: Record<string, unknown> }[]>`
    SELECT profile FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid FOR UPDATE`;
  if (!row) throw new Error('tutorial_progress_denied');
  const records = (row.profile.cloudTutorial ?? {}) as Record<string, unknown>;
  const key = progressKey(scope);
  const current = decode(scope, records[key]);
  if (current.mutationId === patch.mutationId) {
    // An idempotency key cannot be reused for a different write.
    if (current.progress.disposition !== patch.disposition || JSON.stringify(current.progress.inspectedResult ?? null) !== JSON.stringify(patch.inspectedResult ?? null)) throw new Error('tutorial_mutation_reused');
    return current;
  }
  if (current.revision !== patch.expectedRevision) throw new TutorialProgressConflict(current);
  const next: TutorialProgressRecord = { revision: current.revision + 1, mutationId: patch.mutationId,
    progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition: patch.disposition,
      ...(patch.inspectedResult ? { inspectedResult: patch.inspectedResult } : {}) } };
  await tx`UPDATE papercusp_auth.hosted_user_preferences
    SET profile = jsonb_set(profile, '{cloudTutorial}', COALESCE(profile->'cloudTutorial', '{}'::jsonb) || ${JSON.stringify({ [key]: next })}::jsonb), updated_at = now()
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid`;
  return next;
}
