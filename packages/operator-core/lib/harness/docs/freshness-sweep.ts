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

// ── Doc-steward retry policy (mig 386) ──────────────────────────────────────────
// The dispatch latch (regen_enqueued_at / reverify_flagged_at) used to be a fire-ONCE
// gate with no retry: a steward that died (e.g. its first model call 429'd during an
// account-wide rate-limit storm — recorded `done` with no `harness_docs:verify`) left
// the doc flagged forever, and NO later sweep re-dispatched it because the latch was
// already set. So a transient failure became a permanent stall. The fix: treat the
// latch timestamp as a RETRY CLOCK and the attempt counter as a GIVE-UP cap.
export const STEWARD_RETRY_BASE_MS = 30 * 60_000; // first retry after 30min
export const STEWARD_RETRY_MAX_MS = 6 * 60 * 60_000; // backoff caps at 6h
export const STEWARD_MAX_ATTEMPTS = 5; // after 5 dispatches, give up → needs manual verify

/** Exponential backoff between steward dispatches for the same unhealed episode. */
export function stewardBackoffMs(attempts: number): number {
  const n = Math.max(0, attempts - 1);
  return Math.min(STEWARD_RETRY_BASE_MS * 2 ** n, STEWARD_RETRY_MAX_MS);
}

/**
 * Is a (re-)dispatch due for an unhealed doc? First episode (no latch) → yes; already
 * gave up (attempts ≥ cap) → no (it'll show a give-up status_detail instead); otherwise
 * only once the backoff window since the last dispatch has elapsed.
 */
export function dispatchDue(latchAt: string | null, attempts: number, now: number): boolean {
  if (!latchAt) return true;
  if (attempts >= STEWARD_MAX_ATTEMPTS) return false;
  const age = now - Date.parse(latchAt);
  return Number.isFinite(age) && age >= stewardBackoffMs(attempts);
}

/** The latch/attempt pair that governs a doc's steward retries, by derived status. */
function retryStateFor(doc: HarnessDocRecord): { latchAt: string | null; attempts: number } | null {
  if (doc.status === 'stale') return { latchAt: doc.regenEnqueuedAt, attempts: doc.regenAttempts ?? 0 };
  if (doc.status === 'review') return { latchAt: doc.reverifyFlaggedAt, attempts: doc.reverifyAttempts ?? 0 };
  return null;
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
  /** Submodule roots (repo-relative). Anchors under a submodule are drift-checked
   *  inside it against its own baseline (#3); omitted → superproject-only. */
  submodulePaths?: string[];
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
  /** Wall-clock for the steward retry backoff (mig 386). Injectable for tests. */
  now?: number;
}

/**
 * Run the freshness sweep for one harness. Best-effort + idempotent: re-running
 * with the same inputs produces the same statuses and does NOT re-enqueue an
 * already-enqueued regeneration / re-flag an already-flagged re-verify.
 */
export async function sweepHarnessDocs(opts: SweepOpts): Promise<SweepResult> {
  const store = opts.store ?? pgDocStore(opts.harnessSlug, opts.workspaceId);
  const now = opts.now ?? Date.now();
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
    if (anchorMatchesChanged(d.anchorPaths, opts.changedPaths)) return true;
    // Retry leg (mig 386): also re-consider an ALREADY-flagged doc whose steward
    // never healed it and that is now due for another dispatch — even if THIS tick
    // didn't touch its anchor. The retry CLOCK, not the current diff, gates it; the
    // recompute below re-confirms it's still drifted (its baseline never advanced).
    // Bounded to docs already in stale/review, so the extra git confirms are few.
    const retry = retryStateFor(d);
    return retry != null && dispatchDue(retry.latchAt, retry.attempts, now);
  });
  result.candidates = candidates.length;

  for (const doc of candidates) {
    // Capture the prior status BEFORE any mutation — an in-memory store may alias
    // `doc`, and store.setStatus could otherwise change what we compare against.
    const priorStatus = doc.status;
    const { status, detail: baseDetail } = await recomputeDocStatus(doc, opts);

    // Attempt counter for THIS doc's drift family (read pre-dispatch).
    const attempts = status === 'stale' ? (doc.regenAttempts ?? 0)
      : status === 'review' ? (doc.reverifyAttempts ?? 0) : 0;
    const latchAt = status === 'stale' ? doc.regenEnqueuedAt
      : status === 'review' ? doc.reverifyFlaggedAt : null;
    const due = (status === 'stale' || status === 'review') && dispatchDue(latchAt, attempts, now);
    const gaveUp = (status === 'stale' || status === 'review') && attempts >= STEWARD_MAX_ATTEMPTS;

    // Surface a give-up in the persisted status_detail so a permanently-failing
    // auto-heal is VISIBLE (and stops silently re-flagging) rather than invisibly stuck.
    const detail = gaveUp
      ? `${baseDetail ?? 'subject code changed'} — auto-heal gave up after ${STEWARD_MAX_ATTEMPTS} attempts; run harness_docs:verify`
      : baseDetail;
    if (status !== priorStatus || detail !== doc.statusDetail) {
      await store.setStatus(doc.docId, status, detail);
    }
    const becameStale = status === 'stale' && priorStatus !== 'stale';
    const becameReview = status === 'review' && priorStatus !== 'review';

    if (status === 'stale') {
      result.flippedStale += becameStale ? 1 : 0;
      if (due) {
        await store.markRegen(doc.docId);
        await opts.onRegenNeeded?.({ ...doc, status, statusDetail: detail }, detail);
        result.regenEnqueued.push(doc.docId);
      }
    } else if (status === 'review') {
      result.flippedReview += becameReview ? 1 : 0;
      if (due) {
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
