import { getOrgPg } from '@papercusp/db-org';
import { CompletionSettlementManifestSchema, TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { completionHeadBlobMap } from '../../agent-tools/work_items/completion-freshness';
import { emitAwaitedEvent } from '../../events/await/engine';

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

export interface CompletionSettlementReconcilerDeps {
  /** Exact-tree lookup seam used by focused reconciliation tests. */
  lookup?: typeof completionHeadBlobMap;
  /** Await-event seam; production uses the durable, per-key latched emitter. */
  emit?: typeof emitAwaitedEvent;
  /** Database seam for focused tests. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
}

/** Reconcile a bounded batch of proposed code completions against the exact emitted commit. */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string },
  deps: CompletionSettlementReconcilerDeps = {},
): Promise<{ inspected: number; upgraded: string[]; residual: number }> {
  if (!SHA_RE.test(commitSha)) return { inspected: 0, upgraded: [], residual: 0 };
  const sql = deps.sql ?? getOrgPg().sql;
  const lookup = deps.lookup ?? completionHeadBlobMap;
  const emit = deps.emit ?? emitAwaitedEvent;
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
    const residualPaths = residualPathsForCommit(parsed.data, commitSha, lookup);
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
    if (residualPaths.length === 0 && result[0]) {
      const id = result[0].feature_id;
      upgraded.push(id);
      // D-003: the generation/evidence-scoped CAS above is the exact-once gate.
      // Replays and stale generations miss RETURNING and therefore cannot re-fire.
      await emit({
        key: `work-item:settled:${id}`,
        summary: `${id} settlement committed at ${commitSha.slice(0, 12)}`,
        payload: {
          id,
          harness: scope.installSlug,
          commitSha,
          generation: parsed.data.generation,
          evidenceHash: parsed.data.evidenceHash,
        },
        source: 'git-sync-completion-settlement',
        workspaceId: scope.workspaceId,
      });
    }
  }
  return { inspected: rows.length, upgraded, residual: residualCount };
}
