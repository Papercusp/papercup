import { getOrgPg } from '@papercusp/db-org';
import { CompletionSettlementManifestSchema, TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { completionHeadBlobMap } from '../../agent-tools/work_items/completion-freshness';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 200;

export type SettlementResidualReason = 'identity-unavailable' | 'missing-from-commit' | 'content-mismatch';
export type SettlementResidualPath = { path: string; reason: SettlementResidualReason };

export function residualPathsForCommit(
  manifest: unknown,
  commitSha: string,
  lookup: typeof completionHeadBlobMap = completionHeadBlobMap,
): SettlementResidualPath[] | undefined {
  const parsed = CompletionSettlementManifestSchema.safeParse(manifest);
  if (!parsed.success || !SHA_RE.test(commitSha)) return undefined;
  const receipt = parsed.data;
  const committed = lookup(receipt.repositoryRoot, commitSha, receipt.normalizedPaths);
  if (!committed) {
    return receipt.normalizedPaths.map((path) => ({ path, reason: 'identity-unavailable' }));
  }
  const closeIdentity = new Map(receipt.contentIdentity.map((entry) => [entry.path, entry.workingTreeBlobSha]));
  return receipt.normalizedPaths.flatMap((path): SettlementResidualPath[] => {
    const expected = closeIdentity.get(path);
    if (!expected) return [{ path, reason: 'identity-unavailable' }];
    const actual = committed.get(path);
    if (!actual) return [{ path, reason: 'missing-from-commit' }];
    return actual === expected ? [] : [{ path, reason: 'content-mismatch' }];
  });
}

type CandidateRow = { feature_id: string; payload: unknown };

/** Reconcile a bounded batch of proposed code completions against the exact emitted commit. */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string },
): Promise<{ inspected: number; upgraded: string[]; residual: number }> {
  if (!SHA_RE.test(commitSha)) return { inspected: 0, upgraded: [], residual: 0 };
  const { sql } = getOrgPg();
  const rows = await sql<CandidateRow[]>`
    SELECT feature_id, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.installSlug}
       AND authority = 'proposed'
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
     ORDER BY updated_ts ASC, feature_id ASC
     LIMIT ${MAX_CANDIDATES}`;

  const upgraded: string[] = [];
  let residualCount = 0;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = typeof row.payload === 'string'
        ? JSON.parse(row.payload) as Record<string, unknown>
        : row.payload as Record<string, unknown>;
    } catch {
      continue;
    }
    const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
    const manifest = evidence?.settlementManifest;
    const parsed = CompletionSettlementManifestSchema.safeParse(manifest);
    if (!parsed.success) continue;
    const residualPaths = residualPathsForCommit(parsed.data, commitSha);
    if (!residualPaths) continue;
    residualCount += residualPaths.length;
    const nextManifest = { ...parsed.data, residualPaths };
    const nextPayload = {
      ...payload,
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: { ...evidence, settlementManifest: nextManifest },
    };
    const result = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = ${sql.json(nextPayload)},
             authority = CASE WHEN ${residualPaths.length} = 0 THEN 'committed' ELSE authority END,
             updated_ts = ${Date.now()}
       WHERE feature_id = ${row.feature_id}
         AND workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.installSlug}
         AND authority = 'proposed'
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'generation']}::text[] = ${String(parsed.data.generation)}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'evidenceHash']}::text[] = ${parsed.data.evidenceHash}
       RETURNING feature_id`;
    if (residualPaths.length === 0 && result[0]) upgraded.push(result[0].feature_id);
  }
  return { inspected: rows.length, upgraded, residual: residualCount };
}
