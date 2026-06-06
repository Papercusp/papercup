/**
 * freshness-sweep — the drift-surfacing engine (P-003 / D-004).
 *
 * Two entry points over the same machinery:
 *   - recomputeDocStatus(record, deps) — the FORWARD "is THIS doc stale right now?"
 *     query (used on-demand by the per-doc view + the re-check action).
 *   - sweepHarnessDocs(opts) — the git-sync-tick sweep: intersect the tick's
 *     changed paths with the denormalised reverse index (anchor_paths), then
 *     precisely confirm only the candidates, flip their derived status, and
 *     CLOSE THE LOOP (D-004): a stale generated/augmented doc → enqueue a
 *     documenter regeneration; a stale manual doc → flag a human re-verify.
 *
 * The reverse index is the per-record `anchor_paths text[]` column (mig 172),
 * GIN-indexed — so the cheap prefilter is a set/glob intersection, and the
 * expensive git `-L`/`log` confirm runs only for docs the tick could have moved.
 */

import { minimatch } from 'minimatch';
import { checkDocDrift, type DriftResult } from './drift';
import type { GitRunner, FeatureCommitLookup, SubjectRef } from './subject-ref';
import {
  listDocRecords,
  setDocStatus,
  markRegenEnqueued,
  markReverifyFlagged,
  type HarnessDocRecord,
  type DocStatus,
} from './doc-record';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-id-constant';

/** The baseline SHA a doc's staleness is measured from. */
export function baselineFor(record: Pick<HarnessDocRecord, 'source' | 'generatedFromSha' | 'lastVerifiedSha'>): string {
  return (record.source === 'manual' ? record.lastVerifiedSha : record.generatedFromSha) ?? '';
}

/** Pure mapping: a drift result + the doc's ownership → the derived status + a why. */
export function classifyDrift(
  record: Pick<HarnessDocRecord, 'source' | 'subjectRef'>,
  drift: DriftResult,
): { status: DocStatus; detail: string | null } {
  if (!record.subjectRef || record.subjectRef.length === 0) {
    return { status: 'untracked', detail: 'not drift-tracked (no subject_ref)' };
  }
  if (drift.error === 'unanchored') return { status: 'untracked', detail: 'not drift-tracked (no subject_ref)' };
  if (drift.error === 'no-baseline') {
    return { status: 'review', detail: 'anchored but never verified — verify to set a baseline' };
  }
  if (drift.error) return { status: 'unknown', detail: drift.error };
  if (drift.stale) {
    const why = drift.changedPaths.length
      ? `code changed: ${drift.changedPaths.slice(0, 4).join(', ')}${drift.changedPaths.length > 4 ? ' …' : ''}`
      : 'subject code changed since baseline';
    // Generated bodies regenerate; manual bodies need a human's eye.
    return { status: record.source === 'manual' ? 'review' : 'stale', detail: why };
  }
  return { status: 'fresh', detail: null };
}

export interface DriftDeps {
  runGit: GitRunner;
  repoRoot: string;
  resolveFeatureCommits?: FeatureCommitLookup;
}

/** Forward on-demand: recompute one doc's status from git right now. */
export async function recomputeDocStatus(
  record: Pick<HarnessDocRecord, 'source' | 'subjectRef' | 'generatedFromSha' | 'lastVerifiedSha'>,
  deps: DriftDeps,
): Promise<{ status: DocStatus; detail: string | null; drift: DriftResult }> {
  const drift = await checkDocDrift(record.subjectRef ?? [], baselineFor(record), deps);
  const { status, detail } = classifyDrift(record, drift);
  return { status, detail, drift };
}

/** Does any changed path fall under any anchor (glob-aware reverse-index match)? */
export function anchorMatchesChanged(anchorPaths: string[], changedPaths: string[]): boolean {
  if (!anchorPaths.length || !changedPaths.length) return false;
  for (const anchor of anchorPaths) {
    const a = anchor.replace(/\/+$/, '');
    if (!a) continue;
    const isGlob = /[*?[\]{}()!+@]/.test(a);
    // A concrete dir/file anchor also matches files UNDER it (a/b → a/b/**).
    const patterns = isGlob ? [a] : [a, `${a}/**`];
    for (const changed of changedPaths) {
      for (const pat of patterns) {
        if (minimatch(changed, pat, { dot: true })) return true;
      }
    }
  }
  return false;
}

/**
 * Injectable store seam — defaults to the doc-record module bound to a workspace,
 * overridden in unit tests with in-memory fakes (no PG).
 */
export interface DocStore {
  load: () => Promise<HarnessDocRecord[]>;
  setStatus: (docId: string, status: DocStatus, detail: string | null) => Promise<void>;
  markRegen: (docId: string) => Promise<void>;
  markReverify: (docId: string) => Promise<void>;
}

export function pgDocStore(harnessSlug: string, workspaceId: string = DEFAULT_WORKSPACE_ID): DocStore {
  return {
    load: async () => [...(await listDocRecords(harnessSlug, workspaceId)).values()],
    setStatus: (docId, status, detail) => setDocStatus(harnessSlug, docId, status, detail, workspaceId),
    markRegen: (docId) => markRegenEnqueued(harnessSlug, docId, workspaceId),
    markReverify: (docId) => markReverifyFlagged(harnessSlug, docId, workspaceId),
  };
}

export interface SweepResult {
  candidates: number;
  flippedStale: number;
  flippedReview: number;
  regenEnqueued: string[];
  reverifyFlagged: string[];
  unchanged: number;
}

export interface SweepOpts extends DriftDeps {
  harnessSlug: string;
  workspaceId?: string;
  /** The tick's changed paths (repo-relative). Omit → recompute ALL anchored docs. */
  changedPaths?: string[];
  store?: DocStore;
  /** Close-the-loop hooks (D-004). Default: no-op (the status flip + the tab's
   *  regenerate/re-verify actions already drive the loop). */
  onRegenNeeded?: (doc: HarnessDocRecord, detail: string | null) => Promise<void> | void;
  onReverifyNeeded?: (doc: HarnessDocRecord, detail: string | null) => Promise<void> | void;
}

/**
 * Run the freshness sweep for one harness. Best-effort + idempotent: re-running
 * with the same inputs produces the same statuses and does NOT re-enqueue an
 * already-enqueued regeneration / re-flag an already-flagged re-verify.
 */
export async function sweepHarnessDocs(opts: SweepOpts): Promise<SweepResult> {
  const store = opts.store ?? pgDocStore(opts.harnessSlug, opts.workspaceId);
  const all = await store.load();
  const result: SweepResult = {
    candidates: 0,
    flippedStale: 0,
    flippedReview: 0,
    regenEnqueued: [],
    reverifyFlagged: [],
    unchanged: 0,
  };

  // Prefilter: with changed paths, only touch docs whose anchors the tick could
  // have moved (cheap reverse-index intersection). Without, recompute all anchored.
  const candidates = all.filter((d) => {
    if (!d.subjectRef || d.subjectRef.length === 0) return false; // untracked → skip
    if (!opts.changedPaths) return true;
    return anchorMatchesChanged(d.anchorPaths, opts.changedPaths);
  });
  result.candidates = candidates.length;

  for (const doc of candidates) {
    // Capture the prior status BEFORE any mutation — an in-memory store may alias
    // `doc`, and store.setStatus could otherwise change what we compare against.
    const priorStatus = doc.status;
    const { status, detail } = await recomputeDocStatus(doc, opts);
    if (status !== priorStatus || detail !== doc.statusDetail) {
      await store.setStatus(doc.docId, status, detail);
    }
    const becameStale = status === 'stale' && priorStatus !== 'stale';
    const becameReview = status === 'review' && priorStatus !== 'review';

    if (status === 'stale') {
      result.flippedStale += becameStale ? 1 : 0;
      if (!doc.regenEnqueuedAt) {
        await store.markRegen(doc.docId);
        await opts.onRegenNeeded?.({ ...doc, status, statusDetail: detail }, detail);
        result.regenEnqueued.push(doc.docId);
      }
    } else if (status === 'review') {
      result.flippedReview += becameReview ? 1 : 0;
      if (!doc.reverifyFlaggedAt) {
        await store.markReverify(doc.docId);
        await opts.onReverifyNeeded?.({ ...doc, status, statusDetail: detail }, detail);
        result.reverifyFlagged.push(doc.docId);
      }
    } else {
      result.unchanged += status === priorStatus ? 1 : 0;
    }
  }
  return result;
}
