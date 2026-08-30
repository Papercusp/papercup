import { getOrgPg } from '@papercusp/db-org';
import {
  CompletionSettlementManifestSchema,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  type CompletionSettlementManifest,
  type CompletionTreeStamp,
} from '../../coord-lifecycle/records';
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
    // WI-42441: a path the lookup could not RESOLVE is `identity-unavailable`, never
    // `missing-from-commit`. The two carry opposite remedies — one is the server's to
    // fix, the other asks the closer to go re-commit work that is already committed —
    // and an unreadable submodule used to land in the second.
    if (!actual || actual.status === 'unresolvable') return [{ path, reason: 'identity-unavailable' }];
    if (actual.status === 'absent') return [{ path, reason: 'missing-from-commit' }];
    return actual.sha === expected ? [] : [{ path, reason: 'content-mismatch' }];
  });
}

type CandidateRow = { feature_id: string; payload: unknown };

/**
 * WI-1053550: the treeStamp this reconciler's authority upgrade needs to SURVIVE
 * migration 972's `completion_authority_floor_trg`. That trigger polices ONLY
 * `_completionEvidence.treeStamp.contentIdentity` (mirroring
 * `completionTreeContentIdentityMatches()`) — a surface this reconciler never
 * wrote before this fix. It refreshed `settlementManifest` only, so an upgrade
 * to `committed` was downgraded straight back by the trigger on the very same
 * write: the trigger re-read the ORIGINAL close-time treeStamp (captured before
 * git-sync had landed the commit, so headBlobSha routinely didn't match yet)
 * and found it still unproven, no matter how conclusively the manifest's own
 * exact-commit lookup had just settled the row.
 *
 * `residualPaths.length === 0` is exactly the proof this needs: every declared
 * path's close-time `workingTreeBlobSha` was found, byte-for-byte, at `commitSha`
 * (see `residualPathsForCommit`). That makes `workingTreeBlobSha` and the NOW-true
 * `headBlobSha` identical by construction — precisely what
 * `completion_content_identity_proven` / `completionTreeContentIdentityMatches`
 * require. Filtered to `normalizedPaths` (the exact set the proof covers) with a
 * defensive non-null guard; per the manifest's construction this never drops an
 * entry when residualPaths is empty.
 */
function confirmedTreeStampForSettlement(
  manifest: CompletionSettlementManifest,
  commitSha: string,
): CompletionTreeStamp | undefined {
  const normalized = new Set(manifest.normalizedPaths);
  const contentIdentity = manifest.contentIdentity
    .filter((entry) => normalized.has(entry.path) && entry.workingTreeBlobSha !== null)
    .map((entry) => ({
      path: entry.path,
      workingTreeBlobSha: entry.workingTreeBlobSha,
      headBlobSha: entry.workingTreeBlobSha,
    }));
  if (contentIdentity.length === 0) return undefined;
  return { repositoryRoot: manifest.repositoryRoot, headSha: commitSha, contentIdentity };
}

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
    // WI-1053550: only when settlement is COMPLETE (about to set authority='committed'
    // below) does the trigger's floor apply to this write — refresh treeStamp so the
    // upgrade survives it instead of being downgraded straight back. See
    // confirmedTreeStampForSettlement's doc for why this is a sound proof, not a bypass.
    const confirmedTreeStamp = residualPaths.length === 0
      ? confirmedTreeStampForSettlement(parsed.data, commitSha)
      : undefined;
    const nextPayload = {
      ...payload,
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: {
        ...evidence,
        settlementManifest: nextManifest,
        ...(confirmedTreeStamp ? { treeStamp: confirmedTreeStamp } : {}),
      },
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
