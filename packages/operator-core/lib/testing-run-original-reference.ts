import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import type { TestRunExecutionDetails } from '@papercusp/test-config/execution-details';

/** A valid reporter payload belongs to this ledger row only when its recorded identity agrees. */
export function executionForTestRunRow(details: TestRunExecutionDetails | undefined, row: {
  file_path: string | null; run_group_id: string | null | undefined;
  commit_sha: string | null; worktree_dirty: boolean | null;
  workspace_id: string | null; harness_slug: string | null;
}): TestRunExecutionDetails | null {
  if (details && details.filePath === row.file_path && details.runGroupId === row.run_group_id
    && details.commitSha === row.commit_sha && details.worktreeDirty === row.worktree_dirty
    && details.workspaceId === row.workspace_id && details.harnessSlug === row.harness_slug) return details;
  return null;
}

/** Content address of a complete original outcome, before diagnostic shaping.
 * A reference identifies bytes; it grants no manifest, reset or reuse authority. */
export function originalTestRunReference(run: Record<string, unknown>) {
  const fields = ['id', 'workspaceId', 'harnessSlug', 'filePath', 'status', 'framework',
    'startedAt', 'finishedAt', 'durationMs', 'commitSha', 'runGroupId', 'source', 'branch',
    'worktreeDirty', 'isScratchConfig', 'executionDetails', 'configurationFingerprint'] as const;
  if (!run.executionDetails || !run.configurationFingerprint || fields.some(key => run[key] === undefined)
    || !Number.isSafeInteger(run.id) || (run.id as number) <= 0
    || typeof run.startedAt !== 'string' || typeof run.finishedAt !== 'string'
    || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.finishedAt))
    || !Number.isSafeInteger(run.durationMs) || (run.durationMs as number) < 0) return null;
  try {
    const scope = 'original-test-run-outcome-execution-and-configuration' as const;
    return { schemaVersion: 'original-test-run-reference-v2' as const, scope,
      testRunId: String(run.id), sha256: createHash('sha256').update(canonicalJson([
        'original-test-run-reference-v2', scope, Object.fromEntries(fields.map(key => [key, run[key]])),
      ])).digest('hex') };
  } catch { return null; }
}
