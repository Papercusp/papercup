import { getOrgPg } from '@papercusp/db-org';
import {
  CompletionSettlementManifestSchema,
  TERMINAL_COMPLETION_EVIDENCE_KEY,
  type CompletionSettlementManifest,
  type CompletionTreeStamp,
} from '../../coord-lifecycle/records';
import {
  completionBlobHistoryContains,
  completionHeadBlobMap,
  completionWorkingTreeBlobSha,
  type HeadBlobResolution,
} from '../../agent-tools/work_items/completion-freshness';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { emitAwaitedEvent } from '../../events/await/engine';
import {
  COMPLETION_SETTLEMENT_HEALTH_KEY,
  recordCompletionSettlementHealth,
  type SettlementFireObservation,
} from './completion-settlement-health';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_CANDIDATES = 200;
const SETTLEMENT_CONCURRENCY = 8;

/**
 * `superseded-before-commit` (WI-10004711) is `content-mismatch` with the one fact that
 * decides the remedy: the close-time blob is in no commit since the close AND the working
 * tree no longer holds it, so no sweep can ever land it. Plain `content-mismatch` keeps
 * the cases where waiting can still work (the working tree still holds the blob, or it
 * could not be read). It is a verdict on the CURRENT state: a later commit that restores
 * the exact content still settles the row, because every pass re-checks history.
 */
export type SettlementResidualReason =
  | 'identity-unavailable'
  | 'missing-from-commit'
  | 'content-mismatch'
  | 'superseded-before-commit';
export type SettlementResidualPath = { path: string; reason: SettlementResidualReason };
/** Current working-tree blob of one path: null = absent, undefined = could not read. */
type CompletionWorkingTreeLookup = (repoRoot: string, path: string, shaLength: number) => string | null | undefined;
type CompletionHeadBlobLookup = (
  repoRoot: string,
  headSha: string,
  paths: readonly string[],
  opts?: { signal?: AbortSignal },
) => ReadonlyMap<string, HeadBlobResolution> | undefined | Promise<ReadonlyMap<string, HeadBlobResolution> | undefined>;
type CompletionBlobHistoryLookup = typeof completionBlobHistoryContains;
type SettlementHistoryPathAttestation = {
  path: string;
  workingTreeBlobSha: string;
  fromHeadSha: string;
  toCommitSha: string;
  proof: 'exact-path-blob-history';
};
type SettlementHistoryAttestation = {
  version: 1;
  generation: number;
  evidenceHash: string;
  repositoryRoot: string;
  closeHeadSha: string;
  emittedCommitSha: string;
  paths: SettlementHistoryPathAttestation[];
};

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
  historyLookup?: CompletionBlobHistoryLookup,
  onHistoryMatch?: (path: string, workingTreeBlobSha: string) => void,
  /** WI-10004711: opt-in. Without it a mismatch stays `content-mismatch` (never stranded). */
  workingTreeLookup?: CompletionWorkingTreeLookup,
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
  const residualPaths: SettlementResidualPath[] = [];
  for (const path of receipt.normalizedPaths) {
    const expected = closeIdentity.get(path);
    if (!expected) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    const actual = committed.get(path);
    // WI-42441: a path the lookup could not RESOLVE is `identity-unavailable`, never
    // `missing-from-commit`. The two carry opposite remedies — one is the server's to
    // fix, the other asks the closer to go re-commit work that is already committed —
    // and an unreadable submodule used to land in the second.
    if (!actual || actual.status === 'unresolvable') {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    if (expected.deletion === true) {
      // A deletion is settled by a definitive absence in the emitted commit.
      // Do not let a malformed deletion entry with a non-null close identity
      // become proof merely because the path happens to be absent.
      if (expected.workingTreeBlobSha !== null || expected.headBlobSha !== null) {
        residualPaths.push({ path, reason: 'identity-unavailable' });
        continue;
      }
      if (actual.status !== 'absent') residualPaths.push({ path, reason: 'content-mismatch' });
      continue;
    }
    const expectedSha = expected.workingTreeBlobSha;
    if (expectedSha == null) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    if (actual.status === 'absent') {
      residualPaths.push({ path, reason: 'missing-from-commit' });
      continue;
    }
    if (actual.sha === expectedSha) continue;
    const foundInHistory = historyLookup
      ? await historyLookup(
          receipt.repositoryRoot,
          receipt.headSha,
          commitSha,
          path,
          expectedSha,
          signal ? { signal } : undefined,
        )
      : false;
    if (signal?.aborted) return undefined;
    if (foundInHistory === true) {
      onHistoryMatch?.(path, expectedSha);
      continue;
    }
    if (foundInHistory === undefined) {
      residualPaths.push({ path, reason: 'identity-unavailable' });
      continue;
    }
    // WI-10004711: `stranded` needs BOTH halves measured. History must have been
    // CONSULTED (a skipped history read defaults to false above, which proves nothing),
    // and the working tree must be READ and differ: if it still holds the close-time blob,
    // the next sweep lands it (e.g. a path the last commit excluded while it was locked).
    const current = historyLookup ? workingTreeLookup?.(receipt.repositoryRoot, path, commitSha.length) : undefined;
    residualPaths.push({
      path,
      reason: current !== undefined && current !== expectedSha ? 'superseded-before-commit' : 'content-mismatch',
    });
  }
  return residualPaths;
}

type CandidateRow = { feature_id: string; harness_slug: string; payload: unknown; terminal_owner?: string | null };

/** WI-10004711: what the closer is told when their close can no longer settle by waiting. */
export type SettlementStrandedNotice = {
  workItemId: string;
  harness: string;
  workspaceId: string;
  /** The row's recorded closer; null when the row carries none (the notice is then logged only). */
  terminalOwner: string | null;
  strandedPaths: string[];
  commitSha: string;
  generation: number;
};

const SETTLEMENT_SYSTEM_OWNER = 'system:git-sync-completion-settlement';

/**
 * Production notice: one coord message to the closer. Best-effort by contract — the
 * caller swallows a failure, because a notice must never fail the settlement pass.
 */
export async function notifySettlementStranded(notice: SettlementStrandedNotice): Promise<void> {
  if (!notice.terminalOwner) {
    console.warn(
      `[git-sync-completion-settlement] ${notice.workItemId} is stranded (${notice.strandedPaths.join(', ')}) ` +
        'but carries no terminal_owner to notify',
    );
    return;
  }
  const identity: AgentIdentity = {
    ownerId: SETTLEMENT_SYSTEM_OWNER,
    ownerLabel: 'system · completion settlement',
    source: 'principal',
    workspaceId: notice.workspaceId,
    userId: null,
  };
  const paths = notice.strandedPaths.map((path) => `\`${path}\``).join(', ');
  await sendMessage(identity, {
    to: [notice.terminalOwner],
    harnessSlug: notice.harness,
    summary:
      `${notice.workItemId}: your close cannot settle by waiting. ${notice.strandedPaths.length} path(s) changed ` +
      'again before git-sync committed the content you closed with. Re-verify, then re-send work_items:complete.',
    body:
      `Your close of ${notice.workItemId} (harness ${notice.harness}) recorded blobs for ${paths} that never ` +
      `reached a commit: each path was edited again before git-sync swept it, so the recorded content is in ` +
      `no commit since your close (checked through ${notice.commitSha.slice(0, 12)}) and no longer in the ` +
      `working tree. The close stays authority 'proposed', not counted toward burn-down, until you act; ` +
      `waiting cannot settle it. Check that each path's CURRENT content still carries your change (someone ` +
      `else may have edited it). If it does, re-call work_items:complete { id: '${notice.workItemId}', ` +
      `harness: '${notice.harness}' } with your completion evidence: that records the current blobs, and the ` +
      `next git-sync commit settles it. If your change is gone, reopen the item instead.`,
    extra: {
      settlementStranded: true,
      workItemId: notice.workItemId,
      generation: notice.generation,
      strandedPaths: notice.strandedPaths,
    },
  });
}

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
 * A zero residual count can now come from either an exact emitted-tree match or a
 * path-history match. Only the former can refresh treeStamp: a superseded historical
 * blob is not the emitted commit's current head blob. This function therefore checks
 * the emitted tree map independently and refuses to synthesize a false head identity.
 * The database floor still requires exact tree identity; historical-only authority
 * needs a corresponding floor extension before it can persist.
 */
function confirmedTreeStampForSettlement(
  manifest: CompletionSettlementManifest,
  commitSha: string,
  emittedTree: ReadonlyMap<string, HeadBlobResolution>,
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
  // History can prove settlement after a later commit has superseded a path,
  // but that does not make the older blob part of commitSha's exact tree. Only
  // refresh treeStamp when the emitted tree itself still matches every identity.
  const exactTreeMatches = contentIdentity.every((entry) => {
    if ((entry as SettlementIdentity).deletion === true) {
      return emittedTree.get(entry.path)?.status === 'absent';
    }
    const actual = emittedTree.get(entry.path);
    return actual?.status === 'resolved' && actual.sha === entry.workingTreeBlobSha;
  });
  if (!exactTreeMatches) return undefined;
  return { repositoryRoot: manifest.repositoryRoot, headSha: commitSha, contentIdentity };
}

export interface CompletionSettlementReconcilerDeps {
  /** Exact-tree lookup seam used by focused reconciliation tests. */
  lookup?: CompletionHeadBlobLookup;
  /** Exact-path history proof seam. Production uses the emitted commit's Git history. */
  historyLookup?: CompletionBlobHistoryLookup;
  /** Await-event seam; production uses the durable, per-key latched emitter. */
  emit?: typeof emitAwaitedEvent;
  /** Database seam for focused tests. */
  sql?: ReturnType<typeof getOrgPg>['sql'];
  /** Called once per candidate so the action liveness timer can observe batch progress. */
  onProgress?: (progress: { completed: number; total: number; featureId: string }) => void | Promise<void>;
  /** Cancels an in-flight Git child and prevents late settlement writes after timeout. */
  signal?: AbortSignal;
  /**
   * WI-10004400 standing-guard seam: receives one observation per measured fire. Production
   * (no `sql` injected) persists it on the git-sync routine's metadata; a test that injects
   * `sql` without this seam records nothing, so the pre-existing fixtures stay hermetic.
   */
  recordHealth?: (observation: SettlementFireObservation) => Promise<void>;
  /**
   * WI-10004711: current working-tree blob seam. Production reads the checkout; like
   * `historyLookup`, it is off when only the tree-only `lookup` seam is injected.
   */
  workingTreeLookup?: CompletionWorkingTreeLookup;
  /**
   * WI-10004711: tells a closer their close can no longer settle by waiting. Production
   * (no `sql` injected) sends a coord message; injected `sql` without this seam sends
   * nothing, so hermetic fixtures never reach the real coord log.
   */
  notifyStranded?: (notice: SettlementStrandedNotice) => Promise<void>;
}

type ReconcileResult = {
  inspected: number;
  upgraded: string[];
  residual: number;
  unreadable: string[];
  /** Zero residual but the SQL authority floor kept the row 'proposed' — a TS/SQL proof disagreement. */
  floorRejected: string[];
  /** WI-10004711: rows that newly gained a `superseded-before-commit` path on this pass. */
  stranded: string[];
};

/**
 * Reconcile a bounded batch of proposed code completions against the exact emitted commit,
 * and record the fire's outcome for the standing guard (WI-10004400): this function's
 * per-fire result used to be DISCARDED by its only caller, so a regression of the
 * never-attempted-first ordering or the floor-rejection fix was invisible until a hand census.
 */
export async function reconcileProposedCompletionsAtCommit(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps = {},
): Promise<ReconcileResult> {
  // A no-op call (bad sha / blank root) measured nothing, so it is not a fire to judge.
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return reconcileProposedCompletionsCore(commitSha, scope, deps);
  }
  // EI-24758680272435881: stamped BEFORE the candidate SELECT. Only a never-attempted row
  // last written before this instant was visible to that SELECT (and, tier-first, would
  // have been among the first rows this pass started). A close that lands mid-pass is
  // the NEXT pass's to attempt, so it must not count against this one.
  const passStartedAtMs = Date.now();
  let result: ReconcileResult;
  try {
    result = await reconcileProposedCompletionsCore(commitSha, scope, deps);
  } catch (error) {
    // The pass was cut short (budget / action timeout abort, or a failure), so its per-row
    // stats are unknown — the guard records that as null, never as a fabricated zero.
    await observeSettlementFire(scope, deps, passStartedAtMs, {
      outcome: deps.signal?.aborted ? 'budget-exceeded' : 'error',
      neverAttemptedRemaining: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await observeSettlementFire(scope, deps, passStartedAtMs, {
    outcome: 'completed',
    inspected: result.inspected,
    upgraded: result.upgraded.length,
    residual: result.residual,
    unreadable: result.unreadable.length,
    floorRejected: result.floorRejected.length,
    neverAttemptedRemaining: null,
  });
  return result;
}

/**
 * Fill in the DB-measured never-attempted count (measurable even for a cut-short pass),
 * then hand the observation to the recorder. Never throws: a guard that could fail the
 * settlement pass it watches would be worse than no guard.
 */
async function observeSettlementFire(
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps,
  passStartedAtMs: number,
  observation: SettlementFireObservation,
): Promise<void> {
  // Injected `sql` without an injected recorder = an existing hermetic fixture: stay out.
  if (!deps.recordHealth && deps.sql) return;
  try {
    const neverAttemptedRemaining = await countNeverAttemptedCandidates(scope, {
      sql: deps.sql,
      eligibleBeforeMs: passStartedAtMs,
    }).catch(() => null);
    const measured = { ...observation, neverAttemptedRemaining } as SettlementFireObservation;
    if (deps.recordHealth) {
      await deps.recordHealth(measured);
      return;
    }
    const { sql } = getOrgPg();
    await recordCompletionSettlementHealth(measured, {
      readPrevious: async () => {
        const rows = await sql<{ h: unknown }[]>`
          SELECT metadata -> ${COMPLETION_SETTLEMENT_HEALTH_KEY}::text AS h
            FROM harness_shared.routines
           WHERE install_slug = ${scope.installSlug} AND workspace_id = ${scope.workspaceId}
             AND target_role = 'system:git-sync'
           LIMIT 1`;
        return rows[0]?.h ?? null;
      },
      // The same top-level JSONB merge git-sync's own patchRoutineMetadata performs — a
      // `<subsystem>_health` key is what routines:list projects with no reader change.
      write: async (patch) => {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, updated_at = now()
           WHERE install_slug = ${scope.installSlug} AND workspace_id = ${scope.workspaceId}
             AND target_role = 'system:git-sync'`;
      },
    });
  } catch (error) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: could not record the standing-guard observation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function reconcileProposedCompletionsCore(
  commitSha: string,
  scope: { installSlug: string; workspaceId: string; repositoryRoot: string },
  deps: CompletionSettlementReconcilerDeps,
): Promise<ReconcileResult> {
  if (!SHA_RE.test(commitSha) || !scope.repositoryRoot.trim()) {
    return { inspected: 0, upgraded: [], residual: 0, unreadable: [], floorRejected: [], stranded: [] };
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const lookup = deps.lookup ?? completionHeadBlobMap;
  // A custom exact-tree lookup is the unit-test seam for the older tree-only
  // contract. Tests opt into history explicitly; production uses the safe Git reader.
  const historyLookup = deps.historyLookup ?? (deps.lookup ? undefined : completionBlobHistoryContains);
  const workingTreeLookup = deps.workingTreeLookup ?? (deps.lookup ? undefined : completionWorkingTreeBlobSha);
  const notifyStranded = deps.notifyStranded ?? (deps.sql ? undefined : notifySettlementStranded);
  const emit = deps.emit ?? emitAwaitedEvent;
  // EI-24710716781971154: two-tier selection. A row whose manifest has no `residualPaths`
  // key has NEVER been attempted — it is the only kind a fresh close can be, and the
  // only kind that can still settle at this commit for the first time. Every attempt
  // bumps `updated_ts`, so ordering by it alone put a new close behind a FULL rotation
  // of every row that cannot settle (measured 2026-09-30: 527 of 555 candidates, one
  // rotation ≈ 2.4h at ~66 rows per 90s fire). Never-attempted rows go first; attempted
  // rows follow in the same oldest-touched-first rotation as before. The tier is
  // NULL-safe on purpose: an absent key makes `jsonb_typeof(...) = 'array'` NULL, and
  // NULLs sort LAST ascending, which would have put the fresh rows at the back.
  const rows = await sql<CandidateRow[]>`
    SELECT feature_id, harness_slug, payload, terminal_owner
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
     ORDER BY (jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'residualPaths']}::text[]) IS NOT DISTINCT FROM 'array') ASC,
              updated_ts ASC, feature_id ASC
     LIMIT ${MAX_CANDIDATES}`;

  if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');

  const upgradedByIndex: Array<string | undefined> = [];
  const residualByIndex: number[] = [];
  // WI-1409142: a candidate this pass could not READ is the failure mode that hurts
  // most, because it is indistinguishable from one that settled cleanly: the row is
  // skipped, no residualPaths are written, and it therefore shows up in NEITHER the
  // settled nor the unsettled count. 110 closes sat permanently stuck that way for
  // four days with not one line of output. Skipping is still correct — one malformed
  // row must not stall the batch — but it must never again be SILENT.
  const unreadableByIndex: Array<string | undefined> = [];
  // Zero residual, UPDATE matched, yet the authority floor kept the row 'proposed'.
  const floorRejectedByIndex: Array<string | undefined> = [];
  const strandedByIndex: Array<string | undefined> = [];
  let completed = 0;
  const settleRow = async (row: CandidateRow, index: number): Promise<void> => {
    try {
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      let payload: Record<string, unknown>;
      try {
        payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : (row.payload as Record<string, unknown>);
      } catch {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      const evidence = payload?.[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown> | undefined;
      const manifest = evidence?.settlementManifest;
      const parsed = CompletionSettlementManifestSchema.safeParse(normalizeStoredSettlementManifest(manifest));
      if (!parsed.success) {
        unreadableByIndex[index] = row.feature_id;
        return;
      }
      let emittedTree: ReadonlyMap<string, HeadBlobResolution> | undefined;
      const captureLookup: CompletionHeadBlobLookup = async (root, sha, paths, opts) => {
        emittedTree = await lookup(root, sha, paths, opts);
        return emittedTree;
      };
      const historyMatches = new Map<string, string>();
      const residualPaths = await residualPathsForCommit(
        parsed.data,
        commitSha,
        captureLookup,
        deps.signal,
        historyLookup,
        (path, workingTreeBlobSha) => historyMatches.set(path, workingTreeBlobSha),
        workingTreeLookup,
      );
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('completion settlement aborted');
      if (!residualPaths) return;
      residualByIndex[index] = residualPaths.length;
      const nextManifest = { ...parsed.data, residualPaths };
      // EI-24710716781971154: the migration-1207 floor requires a proof for EVERY identity
      // entry whose close-time working blob differs from head — not only the ones a later
      // commit superseded. A MIXED row (some paths still exact in the emitted tree, some
      // superseded) cannot refresh treeStamp (see confirmedTreeStampForSettlement) and used
      // to attest only its history matches, so the floor rejected the exact-tree paths:
      // the UPDATE to 'committed' was reverted by the trigger on every rotation (134 of 555
      // candidates, measured 2026-09-30). Attest those paths too. It is truthful: a path
      // whose emitted-tree blob IS the close-time blob trivially held it within
      // [closeHead, emittedCommit]. The selection mirrors the floor's own inputs
      // (treeStamp.contentIdentity entries it would still call unproven), so a path the floor
      // does not read is never attested — an extra entry that failed the floor's binding
      // checks would invalidate the whole attestation and downgrade rows that pass today.
      const attestedPaths = new Map(historyMatches);
      if (residualPaths.length === 0 && historyMatches.size > 0 && emittedTree) {
        const stampIdentity = (evidence?.treeStamp as { contentIdentity?: unknown } | undefined)?.contentIdentity;
        if (Array.isArray(stampIdentity)) {
          const declaredByPath = new Map(parsed.data.contentIdentity.map((entry) => [entry.path, entry as SettlementIdentity]));
          const normalizedPaths = new Set(parsed.data.normalizedPaths);
          for (const raw of stampIdentity) {
            const entry = (raw ?? {}) as Record<string, unknown>;
            const path = entry.path;
            const blob = entry.workingTreeBlobSha;
            if (typeof path !== 'string' || typeof blob !== 'string' || attestedPaths.has(path)) continue;
            if (entry.deletion === true || entry.outOfRepoArtifact === true) continue;
            if (entry.headBlobSha === blob) continue; // exact-proven at close; the floor needs nothing more
            const declared = declaredByPath.get(path);
            if (!normalizedPaths.has(path) || declared?.workingTreeBlobSha !== blob || declared.deletion === true) continue;
            const actual = emittedTree.get(path);
            if (actual?.status === 'resolved' && actual.sha === blob) attestedPaths.set(path, blob);
          }
        }
      }
      const historyAttestation: SettlementHistoryAttestation | null =
        residualPaths.length === 0 && attestedPaths.size > 0
          ? {
              version: 1,
              generation: parsed.data.generation,
              evidenceHash: parsed.data.evidenceHash,
              repositoryRoot: parsed.data.repositoryRoot,
              closeHeadSha: parsed.data.headSha,
              emittedCommitSha: commitSha,
              paths: [...attestedPaths.entries()].map(([path, workingTreeBlobSha]) => ({
                path,
                workingTreeBlobSha,
                fromHeadSha: parsed.data.headSha,
                toCommitSha: commitSha,
                proof: 'exact-path-blob-history' as const,
              })),
            }
          : null;
      // WI-1053550: refresh treeStamp only when the emitted tree itself matches every
      // close-time blob. A history-only settlement cannot truthfully claim that the
      // superseded blob is still in the emitted tree.
      const confirmedTreeStamp =
        residualPaths.length === 0 && emittedTree
          ? confirmedTreeStampForSettlement(parsed.data, commitSha, emittedTree)
          : undefined;
      const nextPayload = {
        ...payload,
        [TERMINAL_COMPLETION_EVIDENCE_KEY]: {
          ...evidence,
          settlementManifest: nextManifest,
          historyAttestation,
          ...(confirmedTreeStamp ? { treeStamp: confirmedTreeStamp } : {}),
        },
      };
      const result = await sql<{ feature_id: string; authority?: string }[]>`
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
       RETURNING feature_id, authority`;
      // EI-24710716781971154: RETURNING reflects the row AFTER migration 972/1207's
      // `downgrade_unproven_committed_close` trigger, which silently reverts an
      // unproven 'committed' to 'proposed' on this very write. A returned row is therefore
      // NOT proof of an upgrade: only `authority === 'committed'` is. Counting it anyway
      // reported a settlement and fired `work-item:settled:<id>` for a row the floor had
      // rejected, again on every rotation. Track it instead, so it is visible.
      if (residualPaths.length === 0 && result[0] && result[0].authority !== 'committed') {
        floorRejectedByIndex[index] = result[0].feature_id;
      }
      // WI-10004711: tell the closer ONCE, on the transition into stranded. The prior
      // residue is this same generation's stored manifest, so a later pass that re-derives
      // the same stranded set stays silent, and a re-sent close (new generation, no stored
      // residue) starts clean. A missed CAS (result empty) is someone else's write: silent.
      const priorStranded = new Set(
        (parsed.data.residualPaths ?? [])
          .filter((entry) => entry.reason === 'superseded-before-commit')
          .map((entry) => entry.path),
      );
      const newlyStranded = residualPaths
        .filter((entry) => entry.reason === 'superseded-before-commit' && !priorStranded.has(entry.path))
        .map((entry) => entry.path);
      if (result[0] && newlyStranded.length > 0) {
        strandedByIndex[index] = result[0].feature_id;
        try {
          await notifyStranded?.({
            workItemId: result[0].feature_id,
            harness: row.harness_slug,
            workspaceId: scope.workspaceId,
            terminalOwner: row.terminal_owner ?? null,
            strandedPaths: residualPaths
              .filter((entry) => entry.reason === 'superseded-before-commit')
              .map((entry) => entry.path),
            commitSha,
            generation: parsed.data.generation,
          });
        } catch (error) {
          console.warn(
            `[git-sync-completion-settlement] ${scope.installSlug}: could not notify the closer of stranded ` +
              `${result[0].feature_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (residualPaths.length === 0 && result[0] && result[0].authority === 'committed') {
        const id = result[0].feature_id;
        upgradedByIndex[index] = id;
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
      completed += 1;
      await deps.onProgress?.({ completed, total: rows.length, featureId: row.feature_id });
    }
  };
  // Each candidate has its own generation/evidence CAS. Run a bounded group of
  // independent Git lookups and writes together so old proposed completions do
  // not consume the entire per-fire settlement budget one at a time. Drain every
  // worker before this reconciler returns, including after an error.
  let nextIndex = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < rows.length) {
      const index = nextIndex++;
      try {
        await settleRow(rows[index]!, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(SETTLEMENT_CONCURRENCY, rows.length) }, () => worker()),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const upgraded = upgradedByIndex.filter((id): id is string => id !== undefined);
  const unreadable = unreadableByIndex.filter((id): id is string => id !== undefined);
  const floorRejected = floorRejectedByIndex.filter((id): id is string => id !== undefined);
  const stranded = strandedByIndex.filter((id): id is string => id !== undefined);
  const residualCount = residualByIndex.reduce((sum, count) => sum + count, 0);
  if (stranded.length > 0) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${stranded.length} of ${rows.length} ` +
        'proposed completion(s) became unsettleable by waiting (a declared path was edited again before ' +
        'any commit captured the close-time blob); their closers were told to re-send: ' +
        `${stranded.slice(0, 10).join(', ')}${stranded.length > 10 ? ` (+${stranded.length - 10} more)` : ''}`,
    );
  }
  if (floorRejected.length > 0) {
    console.warn(
      `[git-sync-completion-settlement] ${scope.installSlug}: ${floorRejected.length} of ${rows.length} ` +
        'proposed completion(s) proved settled by the reconciler but were kept proposed by the ' +
        'completion authority floor (migration 1207); the TS proof and the SQL floor disagree for: ' +
        `${floorRejected.slice(0, 10).join(', ')}${floorRejected.length > 10 ? ` (+${floorRejected.length - 10} more)` : ''}`,
    );
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
  return { inspected: rows.length, upgraded, residual: residualCount, unreadable, floorRejected, stranded };
}

/**
 * WI-10004400: how many proposed candidates for this checkout have NEVER been attempted —
 * the tier `reconcileProposedCompletionsAtCommit` orders first (its manifest carries no
 * `residualPaths` array). Same scope predicate as the candidate SELECT above, deliberately
 * uncapped by MAX_CANDIDATES: the standing guard needs the true waiting population, and a
 * count of the capped batch would read 200 forever and hide a starved tail. Measurable even
 * when the pass itself was cut short by its budget, which is exactly when it is needed.
 */
export async function countNeverAttemptedCandidates(
  scope: { workspaceId: string; repositoryRoot: string },
  deps: {
    sql?: ReturnType<typeof getOrgPg>['sql'];
    /**
     * EI-24758680272435881: count only rows last written BEFORE this instant — the fire's
     * start. Without it the count included closes that landed mid-pass, after the candidate
     * SELECT, so under steady close traffic the population never read zero and the
     * consecutive-fires streak grew forever (measured 2026-10-01: a fully healthy pass that
     * wrote its first row still recorded `failing`, remaining 1, streak 32, because two
     * fresh closes arrived during it). Omitted = no cutoff (an all-time census).
     */
    eligibleBeforeMs?: number;
  } = {},
): Promise<number> {
  const sql = deps.sql ?? getOrgPg().sql;
  // One parameterized predicate either way (no conditional fragment): the "no cutoff" case
  // binds a ceiling no millisecond timestamp reaches.
  const eligibleBeforeMs = deps.eligibleBeforeMs ?? Number.MAX_SAFE_INTEGER;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND authority = 'proposed'
       AND payload #>> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'repositoryRoot']}::text[] = ${scope.repositoryRoot}
       AND payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest']}::text[] IS NOT NULL
       AND jsonb_typeof(payload #> ${[TERMINAL_COMPLETION_EVIDENCE_KEY, 'settlementManifest', 'residualPaths']}::text[]) IS DISTINCT FROM 'array'
       AND updated_ts < ${eligibleBeforeMs}`;
  return Number(rows[0]?.n ?? 0);
}
