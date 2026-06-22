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
import { runGit, repoHeadSha, repoChangedPaths } from './git-runner';
import { makeFeatureCommitLookup } from './feature-commits';
import { sweepHarnessDocs, type SweepResult } from './freshness-sweep';
import { listDocRecords } from './doc-record';
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
        for (const p of changedPaths) {
          if (!/\.(md|mdx)$/i.test(p)) continue;
          if (prefix && !p.startsWith(prefix)) continue;
          const docId = prefix ? p.slice(prefix.length) : p;
          if (!docId || records.has(docId)) continue;
          const res = await anchorManualDoc({ harnessSlug, docId, verify: true, workspaceId });
          if (res.ok) records.set(docId, res.record);
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

  // P-008 doc-steward — dispatch the LLM consumer to FIX the newly-drifted docs against the
  // current code (the deterministic counterpart to detection). Best-effort + flag-gated; the
  // sweep already deduped (once per drift episode), so this fires ONE doc-steward for the batch.
  await dispatchDocStewardForDrift(harnessSlug, workspaceId, staleDocs);

  return result;
}
