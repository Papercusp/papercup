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
import { runGit, repoHeadSha, repoChangedPaths } from './git-runner';
import { makeFeatureCommitLookup } from './feature-commits';
import { sweepHarnessDocs, type SweepResult } from './freshness-sweep';
import { listDocRecords } from './doc-record';
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

  // Cheap early-out: a harness with no doc records can't have any drift.
  const records = await listDocRecords(harnessSlug, workspaceId);
  if (records.size === 0) return null;

  const repoRoot = await projectDirForSlug(harnessSlug);
  if (!repoRoot) return null;

  // Derive the changed paths for the prefilter. prevSha==headSha → nothing moved.
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

  return sweepHarnessDocs({
    harnessSlug,
    workspaceId,
    repoRoot,
    runGit,
    changedPaths,
    resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
    onRegenNeeded: async (doc, detail) => {
      await sendMessage(DOCS_IDENTITY, {
        to: ['*'],
        summary: `📄 ${harnessSlug}: generated doc ${doc.docId} is STALE (${detail ?? 'subject code changed'}) — regeneration enqueued`,
        category: 'doc-drift',
      }).catch(() => {});
    },
    onReverifyNeeded: async (doc, detail) => {
      await sendMessage(DOCS_IDENTITY, {
        to: ['*'],
        summary: `📄 ${harnessSlug}: manual doc ${doc.docId} needs RE-VERIFY (${detail ?? 'subject code changed'})`,
        category: 'doc-drift',
      }).catch(() => {});
    },
  });
}
