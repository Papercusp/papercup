import { getOrgPg } from '@papercusp/db-org';
import {
  CompletionSettlementManifestSchema,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  type CompletionSettlementManifest,
  type CompletionTreeStamp,
} from '../../coord-lifecycle/records';
import { completionHeadBlobMap, type HeadBlobResolution } from '../../agent-tools/work_items/completion-freshness';
import { emitAwaitedEvent } from '../../events/await/engine';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 200;

export type SettlementResidualReason = 'identity-unavailable' | 'missing-from-commit' | 'content-mismatch';
export type SettlementResidualPath = { path: string; reason: SettlementResidualReason };
type CompletionHeadBlobLookup = (
  repoRoot: string,
  headSha: string,
  paths: readonly string[],
  opts?: { signal?: AbortSignal },
) => ReadonlyMap<string, HeadBlobResolution> | undefined | Promise<ReadonlyMap<string, HeadBlobResolution> | undefined>;

/** EI-22344624691081449: manifest entries may describe an intentional deletion. */
type SettlementIdentity = CompletionSettlementManifest['contentIdentity'][number] & {
  deletion?: true;
};

/**
 * WI-1409142: restore the two blob-sha keys the terminal payload write used to drop.
 *
 * `jsonb_strip_nulls` is RECURSIVE. Applied to completion evidence it deleted
 * `contentIdentity[].headBlobSha` / `.workingTreeBlobSha` whenever the value was a
 * meaningful `null` — a declared path not yet in HEAD, which is simply what a close
 * looks like before git-sync sweeps. `CompletionSettlementManifestSchema` requires
 * those keys, so the stored manifest failed `safeParse`, `residualPathsForCommit`
 * returned undefined, and the reconciler skipped the row: 110 closes could never
 * settle, and showed up in neither the settled nor the unsettled count.
 *
 * Both write sites now exempt the evidence subtree, so new rows keep their nulls.
 * This exists for the rows ALREADY on disk — it lets them settle on the next pass
 * instead of needing a backfill. An absent key and an explicit null mean the same
 * thing here ("this side was not resolved"), so filling one in loses nothing.
 *
 * Defaults are spread FIRST so a key that IS present — including an explicit null —
 * always wins; only a genuinely missing key is filled.
 */
export function normalizeStoredSettlementManifest(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const manifest = raw as { contentIdentity?: unknown };
  if (!Array.isArray(manifest.contentIdentity)) return raw;
  return {
    ...manifest,
    contentIdentity: manifest.contentIdentity.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { workingTreeBlobSha: null, headBlobSha: null, ...(entry as Record<string, unknown>) }
        : entry,
    ),
  };
}

export async function residualPathsForCommit(
  manifest: unknown,
  commitSha: string,
  lookup: CompletionHeadBlobLookup = completionHeadBlobMap,
  signal?: AbortSignal,
): Promise<SettlementResidualPath[] | undefined> {
  const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
  if (!parsed.success || !SHA_RE.test(commitSha)) return undefined;
  const receipt = parsed.data;
  const committed = await (signal
    ? lookup(receipt.repositoryRoot, commitSha, receipt.normalizedPaths, { signal })
    : lookup(receipt.repositoryRoot, commitSha, receipt.normalizedPaths));
  if (signal?.aborted) return undefined;
  if (!committed) {
    return receipt.normalizedPaths.map((path) => ({ path, reason: 'identity-unavailable' }));
  }
  const closeIdentity = new Map<string, SettlementIdentity>(
    receipt.contentIdentity.map((entry) => [entry.path, entry as SettlementIdentity]),
  );
  return receipt.normalizedPaths.flatMap((path): SettlementResidualPath[] => {
    const expected = closeIdentity.get(path);
    if (!expected) return [{ path, reason: 'identity-unavailable' }];
    const actual = committed.get(path);
    // WI-42441: a path the lookup could not RESOLVE is `identity-unavailable`, never
    // `missing-from-commit`. The two carry opposite remedies — one is the server's to
    // fix, the other asks the closer to go re-commit work that is already committed —
    // and an unreadable submodule used to land in the second.
    if (!actual || actual.status === 'unresolvable') return [{ path, reason: 'identity-unavailable' }];
    if (expected.deletion === true) {
      // A deletion is settled by a definitive absence in the emitted commit.
      // Do not let a malformed deletion entry with a non-null close identity
      // become proof merely because the path happens to be absent.
      if (expected.workingTreeBlobSha !== null || expected.headBlobSha !== null) {
        return [{ path, reason: 'identity-unavailable' }];
      }
      return actual.status === 'absent' ? [] : [{ path, reason: 'content-mismatch' }];
    }
    const expectedSha = expected.workingTreeBlobSha;
    if (expectedSha == null) return [{ path, reason: 'identity-unavailable' }];
    if (actual.status === 'absent') return [{ path, reason: 'missing-from-commit' }];
    return actual.sha === expectedSha ? [] : [{ path, reason: 'content-mismatch' }];
  });
}

type CandidateRow = { feature_id: string; harness_slug: string; payload: unknown };

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
    // WI-1409142: `!= null` also excludes an ABSENT key. The schema now accepts a
    // missing sha as null, so a strict `!== null` would let `undefined` through and
    // write a treeStamp entry whose shas are undefined — which
    // completionTreeContentIdentityMatches would then have to reject, silently
    // undoing the very upgrade this function exists to make survive the trigger.
    .filter((entry) => {
      if (!normalized.has(entry.path)) return false;
      const deletion = (entry as SettlementIdentity).deletion === true;
      return deletion || entry.workingTreeBlobSha != null;
    })
    .map((entry) => {
      const deletion = (entry as SettlementIdentity).deletion === true;
      return {
        path: entry.path,
        workingTreeBlobSha: deletion ? null : entry.workingTreeBlobSha,
        headBlobSha: deletion ? null : entry.workingTreeBlobSha,
        ...(deletion ? { deletion: true as const } : {}),
      };
    });
  if (contentIdentity.length === 0) return undefined;
  return { repositoryRoot: manifest.repositoryRoot, headSha: commitSha, contentIdentity };
}

export interface CompletionSettlementReconcilerDeps {
  /** Exact-tree lookup seam used by focused reconciliation tests. */
  lookup?: CompletionHeadBlobLookup;
  /** Await-event seam; production uses the durable, per-key latched emitter. */
  emit?: typeof emitAwaitedEvent;
  /** Database seam for focused tests. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
  /** Called once per candidate so the action liveness timer can observe batch progress. */
  onProgress?: (progress: { completed: number; total: number; featureId: string }) => void | Promise<void>;
  /** Cancels an in-flight Git child and prevents late settlement writes after timeout. */
  signal?: AbortSignal;
}

/** Reconcile a bounded batch of proposed code completions against the exact emitted commit. */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps = {},
): Promise<{ inspected: number; upgraded: string[]; residual: number; unreadable: string[] }> {
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return { inspected: 0, upgraded: [], residual: 0, unreadable: [] };
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const lookup = deps.lookup ?? completionHeadBlobMap;
  const emit = deps.emit ?? emitAwaitedEvent;
  const rows = await sql<CandidateRow[]>`
    SELECT feature_id, harness_slug, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
     ORDER BY updated_ts ASC, feature_id ASC
     LIMIT ${MAX_CANDIDATES}`;

  if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');

  const upgraded: string[] = [];
  let residualCount = 0;
  // WI-1409142: a candidate this pass could not READ is the failure mode that hurts
  // most, because it is indistinguishable from one that settled cleanly: the row is
  // skipped, no residualPaths are written, and it therefore shows up in NEITHER the
  // settled nor the unsettled count. 110 closes sat permanently stuck that way for
  // four days with not one line of output. Skipping is still correct — one malformed
  // row must not stall the batch — but it must never again be SILENT.
  const unreadable: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    try {
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      let payload: Record<string, unknown>;
      try {
        payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : (row.payload as Record<string, unknown>);
      } catch {
        unreadable.push(row.feature_id);
        continue;
      }
      const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
      const manifest = evidence?.settlementManifest;
      const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
      if (!parsed.success) {
        unreadable.push(row.feature_id);
        continue;
      }
      const residualPaths = await residualPathsForCommit(parsed.data, commitSha, lookup, deps.signal);
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      if (!residualPaths) continue;
      residualCount += residualPaths.length;
      const nextManifest = { ...parsed.data, residualPaths };
      // WI-1053550: only when settlement is COMPLETE (about to set authority='committed'
      // below) does the trigger's floor apply to this write — refresh treeStamp so the
      // upgrade survives it instead of being downgraded straight back. See
      // confirmedTreeStampForSettlement's doc for why this is a sound proof, not a bypass.
      const confirmedTreeStamp =
        residualPaths.length === 0 ? confirmedTreeStampForSettlement(parsed.data, commitSha) : undefined;
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
         AND harness_slug = ${row.harness_slug}
         AND authority = 'proposed'
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'generation']}::text[] = ${String(parsed.data.generation)}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'evidenceHash']}::text[] = ${parsed.data.evidenceHash}
         AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
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
            harness: row.harness_slug,
            commitSha,
            generation: parsed.data.generation,
            evidenceHash: parsed.data.evidenceHash,
          },
          source: 'git-sync-completion-settlement',
          workspaceId: scope.workspaceId,
        });
      }
    } finally {
      await deps.onProgress?.({ completed: index + 1, total: rows.length, featureId: row.feature_id });
    }
  }
  if (unreadable.length > 0) {
    // Named ids, not just a count: the whole point is that someone can go LOOK at one.
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${unreadable.length} of ${rows.length} ` +
        'proposed completion(s) carry a settlementManifest this pass could not read; they were skipped ' +
        'and stay unsettled, counted as neither settled nor residual: ' +
        `${unreadable.slice(0, 10).join(', ')}${unreadable.length > 10 ? ` (+${unreadable.length - 10} more)` : ''}`,
    );
  }
  return { inspected: rows.length, upgraded, residual: residualCount, unreadable };
}
