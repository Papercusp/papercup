import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';

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
