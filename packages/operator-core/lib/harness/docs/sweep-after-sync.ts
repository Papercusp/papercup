/**
 * sweep-after-sync — the git-sync-tick → doc-freshness-sweep bridge (P-003/D-004).
 *
 * After a harness repo syncs (git-sync `synced`), the paths that moved between the
 * pre-sync HEAD and the new HEAD are exactly the commit's changed paths. We diff
 * them, intersect with each doc's denormalised anchor_paths (the reverse index),
 * and flip the matched docs' freshness — enqueuing a documenter regeneration for
 * stale generated docs and flagging a re-verify for stale manual docs.
 *
 * Fully best-effort: any failure here is swallowed (it must never wedge git-sync),
 * lazily imported by the action so it adds nothing to the hot path until a sync
 * actually completes.
 */

import { projectDirForSlug } from '../../operator-notes';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { relative } from 'node:path';
import { runGit, repoHeadSha, repoChangedPaths, listSubmodulePaths } from './git-runner';
import { makeFeatureCommitLookup } from './feature-commits';
import { sweepHarnessDocs, recomputeDocStatus, type SweepResult } from './freshness-sweep';
import { listDocRecords, setDocStatus } from './doc-record';
import { resolveHarnessDocPaths } from './harness-repo';
import { anchorManualDoc } from './manual-anchor';
import { dispatchDocStewardForDrift, type DriftedDoc } from './doc-steward-dispatch';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

const DOCS_IDENTITY: AgentIdentity = {
  ownerId: 'system:doc-freshness',
  ownerLabel: 'doc-freshness',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Read a harness repo's current HEAD sha (captured pre-sync to bound the diff). */
export async function captureHeadSha(harnessSlug: string): Promise<string | null> {
  const repoRoot = await projectDirForSlug(harnessSlug);
  if (!repoRoot) return null;
  return repoHeadSha(repoRoot);
}

export interface SweepAfterSyncInput {
  harnessSlug: string;
  workspaceId: string;
  /** HEAD before the sync (omit/blank → recompute all anchored docs). */
  prevSha?: string;
  /** HEAD after the sync. */
  headSha?: string;
}

/**
 * Run the freshness sweep for a harness after a git-sync. Returns the sweep
 * result (or null when there were no doc records / nothing to do).
 */
export async function runDocFreshnessSweepAfterSync(input: SweepAfterSyncInput): Promise<SweepResult | null> {
  const { harnessSlug } = input;
  // A harness's docs live in its workspace — derive it (never a silent 'default'). This
  // whole sweep is best-effort (the caller swallows any throw), so a derive failure for an
  // unregistered harness degrades to "no sweep", never a silent cross-workspace read (D-003).
  const workspaceId = await resolveWorkspaceForHarness(harnessSlug, input.workspaceId);

  const repoRoot = await projectDirForSlug(harnessSlug);
  if (!repoRoot) return null;

  // Submodule roots, so the drift checker routes a submodule anchor's `git log` into
  // the submodule against its own baseline (#3) instead of a superproject log that
  // can't see inside it (silent rot). Best-effort; [] = superproject-only behavior.
  const submodulePaths = await listSubmodulePaths(repoRoot).catch(() => [] as string[]);

  // Derive the changed paths for the prefilter AND the self-bootstrap. prevSha==headSha
  // → nothing moved.
  let changedPaths: string[] | undefined;
  const prev = (input.prevSha ?? '').trim();
  const head = (input.headSha ?? '').trim();
  if (prev && head) {
    if (prev === head) return null;
    const diff = await repoChangedPaths(repoRoot, prev, head);
    if (diff) {
      if (diff.length === 0) return null;
      changedPaths = diff;
    }
  }

  const records = await listDocRecords(harnessSlug, workspaceId);

  // Self-bootstrap (owner 2026-06-22): once a harness is doc-tracked (≥1 record — e.g.
  // from the harness:create seed), a doc TOUCHED in this commit that has no record yet
  // is registered NOW — so tracking grows page-by-page with zero `harness_docs:record`
  // ceremony. Reuses anchorManualDoc (deterministic, no LLM — D-006). Bounded to the
  // commit's changed doc-paths (cheap). A never-tracked / opted-out harness keeps 0
  // records, so the bail below holds and the sweep never auto-starts it.
  if (records.size > 0 && changedPaths?.length) {
    try {
      const paths = await resolveHarnessDocPaths(harnessSlug);
      if (paths) {
        const docsRel = relative(paths.repoRoot, paths.docsRoot);
        const prefix = docsRel && docsRel !== '.' ? docsRel.replace(/\/?$/, '/') : '';
        const reanchorDeps = {
          runGit,
          repoRoot,
          resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
          submodulePaths,
        };
        for (const p of changedPaths) {
          if (!/\.(md|mdx)$/i.test(p)) continue;
          if (prefix && !p.startsWith(prefix)) continue;
          const docId = prefix ? p.slice(prefix.length) : p;
          if (!docId) continue;
          if (!records.has(docId)) {
            // NEW doc → register + set the verify baseline (page-by-page tracking growth).
            const res = await anchorManualDoc({ harnessSlug, docId, verify: true, workspaceId });
            if (res.ok) records.set(docId, res.record);
            continue;
          }
          // TRACKED doc whose FILE changed this commit → its `documents:` frontmatter may
          // have changed, so RE-DERIVE its anchors — the cache must never drift from the
          // frontmatter (docs-audit #2; before this, anchors were only derived on the FIRST
          // bootstrap, so a later `documents:` edit silently left a stale anchor cache and
          // the sweep matched the wrong paths). anchorManualDoc (no verify) re-parses the
          // frontmatter and upserts subject_ref/anchor_paths; the upsert COALESCEs
          // last_verified_sha (baseline preserved). We then recompute status from the FRESH
          // anchors so a pure-frontmatter edit doesn't stick at the transient 'review'
          // anchorManualDoc writes for an un-verified anchor.
          const res = await anchorManualDoc({ harnessSlug, docId, workspaceId });
          if (res.ok) {
            const { status, detail } = await recomputeDocStatus(res.record, reanchorDeps);
            await setDocStatus(harnessSlug, docId, status, detail, workspaceId);
            records.set(docId, { ...res.record, status, statusDetail: detail });
          }
        }
      }
    } catch {
      // best-effort: a self-bootstrap failure must never wedge the sweep / git-sync.
    }
  }

  // A harness with no doc records (and none newly registered) can't have any drift.
  if (records.size === 0) return null;

  // The NEWLY-drifted docs this sweep — the callbacks fire once per drift episode
  // (sweepHarnessDocs gates them on !regenEnqueuedAt/!reverifyFlaggedAt), so this is a
  // deduped batch for the doc-steward (P-008).
  const staleDocs: DriftedDoc[] = [];

  const result = await sweepHarnessDocs({
    harnessSlug,
    workspaceId,
    repoRoot,
    runGit,
    changedPaths,
    submodulePaths,
    resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
    onRegenNeeded: async (doc, detail) => {
      staleDocs.push({ docId: doc.docId, anchorPaths: doc.anchorPaths, reason: detail ?? 'subject code changed', source: doc.source });
      await sendMessage(DOCS_IDENTITY, {
        to: ['*'],
        summary: `📄 ${harnessSlug}: generated doc ${doc.docId} is STALE (${detail ?? 'subject code changed'}) — regeneration enqueued`,
        category: 'doc-drift',
      }).catch(() => {});
    },
    onReverifyNeeded: async (doc, detail) => {
      staleDocs.push({ docId: doc.docId, anchorPaths: doc.anchorPaths, reason: detail ?? 'subject code changed', source: doc.source });
      await sendMessage(DOCS_IDENTITY, {
        to: ['*'],
        summary: `📄 ${harnessSlug}: manual doc ${doc.docId} needs RE-VERIFY (${detail ?? 'subject code changed'})`,
        category: 'doc-drift',
      }).catch(() => {});
    },
  });

  // P-005 (doc-drift attribution): enrich each drifted doc with the work-item(s) that recently
  // changed its anchored code (from git_sync_commit_attribution) so the doc-steward knows WHY the
  // code drifted (D-006: derived, no extra agent call). Deterministic + best-effort; ONE query.
  if (staleDocs.length > 0) {
    try {
      const { lookupDriftCauseWorkItems } = await import('../../edit-attribution');
      const causes = await lookupDriftCauseWorkItems(
        [...new Set(staleDocs.flatMap((d) => d.anchorPaths))],
        { harnessSlug },
      );
      if (causes.size > 0) {
        for (const d of staleDocs) {
          const wis = [...new Set(d.anchorPaths.flatMap((f) => causes.get(f) ?? []))];
          if (wis.length > 0) d.workItems = wis;
        }
      }
    } catch {
      /* best-effort: attribution enrichment must never break the sweep */
    }
  }

  // P-008 doc-steward — dispatch the LLM consumer to FIX the newly-drifted docs against the
  // current code (the deterministic counterpart to detection). Best-effort + flag-gated; the
  // sweep already deduped (once per drift episode), so this fires ONE doc-steward for the batch.
  await dispatchDocStewardForDrift(harnessSlug, workspaceId, staleDocs);

  return result;
}

export interface ReconcileAnchorsResult {
  /** Anchor-derived docs examined (manual/augmented records). */
  scanned: number;
  /** Docs whose denormalised anchor cache DIFFERED from the freshly-derived frontmatter anchors
   *  (the stale-cache the re-anchor-on-change path missed) and was rewritten. */
  reconciled: number;
  /** Re-anchor failures (a doc whose harness/doc paths couldn't be resolved). */
  failed: number;
}

/**
 * PERIODIC FULL doc-anchor RECONCILE (#5 PART B) — the safety net for the re-anchor-on-change path.
 *
 * `runDocFreshnessSweepAfterSync` re-derives a doc's anchors ONLY when its FILE changed in a git-sync
 * tick (the self-bootstrap loop above). That misses a stale anchor cache that slipped past
 * re-anchor-on-change — e.g. a `documents:` frontmatter edit committed in a tick whose diff range the
 * sweep never saw (a force-push / squash / a sync without prev↔head, a record seeded before the
 * re-anchor logic existed, or a partial-failure that left the cache half-written). A stale anchor cache
 * silently makes the reverse-index match the WRONG paths → the freshness sweep both misses real drift
 * and false-flags unrelated changes.
 *
 * This re-derives anchors from the CURRENT frontmatter for ALL anchor-derived (manual/augmented) docs and
 * rewrites the cache where it drifted — reusing the EXACT `anchorManualDoc` + `recomputeDocStatus` path the
 * self-bootstrap loop already uses, so reconcile and re-anchor-on-change share one code path. Generated
 * docs are NOT touched: their anchors come from the documenter regeneration (provenance.ts, with a
 * `generated_from_sha` baseline), not author frontmatter — re-anchoring them as manual would wipe that
 * baseline. Best-effort + idempotent: a clean cache is a no-op (the upsert rewrites identical anchors and
 * `recomputeDocStatus` lands the same status), so it is safe to run on a periodic routine.
 */
export async function reconcileAllDocAnchors(
  harnessSlug: string,
  workspaceId?: string,
): Promise<ReconcileAnchorsResult> {
  const ws = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const out: ReconcileAnchorsResult = { scanned: 0, reconciled: 0, failed: 0 };

  const repoRoot = await projectDirForSlug(harnessSlug);
  if (!repoRoot) return out;
  const submodulePaths = await listSubmodulePaths(repoRoot).catch(() => [] as string[]);
  const reanchorDeps = {
    runGit,
    repoRoot,
    resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, ws),
    submodulePaths,
  };

  const records = await listDocRecords(harnessSlug, ws);
  for (const [docId, record] of records) {
    // Only anchor-derived docs (manual/augmented) carry frontmatter-derived anchors; a generated doc's
    // anchors + baseline belong to the documenter regeneration path, so skip it (see the doc-comment).
    if (record.source === 'generated') continue;
    out.scanned += 1;
    const before = [...record.anchorPaths].sort();
    // Re-derive from CURRENT frontmatter (no verify → preserves the last_verified_sha baseline via the
    // upsert COALESCE), exactly like the self-bootstrap re-anchor-on-change branch.
    const res = await anchorManualDoc({ harnessSlug, docId, workspaceId: ws });
    if (!res.ok) {
      out.failed += 1;
      continue;
    }
    const after = [...res.record.anchorPaths].sort();
    const drifted = before.length !== after.length || before.some((p, i) => p !== after[i]);
    if (drifted) out.reconciled += 1;
    // Recompute status from the FRESH anchors so a pure-frontmatter change doesn't stick at the
    // transient 'review' anchorManualDoc writes for an un-verified anchor (mirrors the bootstrap loop).
    const { status, detail } = await recomputeDocStatus(res.record, reanchorDeps);
    await setDocStatus(harnessSlug, docId, status, detail, ws);
  }

  return out;
}
