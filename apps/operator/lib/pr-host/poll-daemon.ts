/**
 * pr-host/poll-daemon — GitHub PR poll daemon (Phase 7 P-042).
 *
 * Polls every 60s per harness that has ≥1 open PR. Updates
 * harness_shared.pr_check_status_cache (LOCAL bucket). Handles:
 *   - P-042b: bulk `listOpenPrs` per harness
 *   - P-042c: exponential backoff on 5xx (max 5min)
 *   - P-042d: honors X-RateLimit-Reset via retry_after_ms in PrHostError
 *   - P-042e: 401 surfaces alert toast; polls resume but auth is flagged
 *   - P-042f: 404 on a known PR → mark gone → demote completion_ref
 */

import { ensurePrCheckStatusCacheTable, ensureAutoReviewAuditTable } from '../ensure-schema-dogfood';
import { getOrgPg } from '@papercusp/db-org';
import type { PrHost, PrHostError, Pr } from './types';
import { isRetryableError } from './types';
import { emitPrOpened } from '../harness/usage-emitters';

const POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface PollDaemonOptions {
  /** Harness slugs to poll. Reload on each tick if a live query is preferred. */
  harnessRemotes: () => Promise<Array<{ harnessSlug: string; remote: string }>>;
  /** PrHost implementation to use (injectable for tests). */
  host: PrHost;
  /** Optional callback when the PR list for a harness updates. */
  onUpdate?: (harnessSlug: string, prs: Pr[]) => void;
  /** Optional callback on auth failure (surfaced as a toast in production). */
  onAuthFailure?: (harnessSlug: string, error: PrHostError) => void;
  /** Optional callback on a PR going gone (P-042f). */
  onPrGone?: (harnessSlug: string, prNumber: number) => void;
  /** Override poll interval in ms (for tests). */
  _pollIntervalMs?: number;
}

interface HarnessState {
  consecutiveErrors: number;
  nextAllowedAt: number;
  lastKnownPrNumbers: Set<number>;
  /** P-070: false until the first successful poll seeds the baseline, so a
   *  daemon restart doesn't re-emit `pr_opened` for already-open PRs. */
  seeded: boolean;
}

const daemonState = new Map<string, HarnessState>();

function getState(harnessSlug: string): HarnessState {
  if (!daemonState.has(harnessSlug)) {
    daemonState.set(harnessSlug, {
      consecutiveErrors: 0,
      nextAllowedAt: 0,
      lastKnownPrNumbers: new Set(),
      seeded: false,
    });
  }
  return daemonState.get(harnessSlug)!;
}

function computeBackoffMs(consecutiveErrors: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  const exp = Math.min(consecutiveErrors, 5);
  return Math.min(POLL_INTERVAL_MS * Math.pow(2, exp - 1), MAX_BACKOFF_MS);
}

async function pollHarness(
  harnessSlug: string,
  remote: string,
  opts: PollDaemonOptions,
): Promise<void> {
  const state = getState(harnessSlug);
  if (Date.now() < state.nextAllowedAt) return;

  const result = await opts.host.listOpenPrs({ remote });

  if (!result.ok) {
    const error = result.error;
    state.consecutiveErrors++;

    if (error.kind === 'unauthorized') {
      opts.onAuthFailure?.(harnessSlug, error);
      // Don't backoff on auth errors — surface immediately, but stop polling
      // until the next normal tick (avoiding a tight loop on revoked tokens).
      state.nextAllowedAt = Date.now() + POLL_INTERVAL_MS;
      return;
    }

    if (error.kind === 'not_found') {
      // Harness repo deleted/moved — mark all known PRs as gone.
      for (const prNum of state.lastKnownPrNumbers) {
        opts.onPrGone?.(harnessSlug, prNum);
      }
      state.lastKnownPrNumbers.clear();
      state.nextAllowedAt = Date.now() + MAX_BACKOFF_MS;
      return;
    }

    if (isRetryableError(error)) {
      const backoff = computeBackoffMs(state.consecutiveErrors, error.retry_after_ms);
      state.nextAllowedAt = Date.now() + backoff;
      return;
    }

    // Non-retryable, non-auth, non-not_found: back off once then give up until next tick.
    state.nextAllowedAt = Date.now() + POLL_INTERVAL_MS;
    return;
  }

  // Success path.
  state.consecutiveErrors = 0;
  state.nextAllowedAt = 0;

  const freshPrs = result.data;
  const freshNumbers = new Set(freshPrs.map((p) => p.ref.number));

  // P-042f: detect PRs that disappeared (gone).
  for (const known of state.lastKnownPrNumbers) {
    if (!freshNumbers.has(known)) {
      opts.onPrGone?.(harnessSlug, known);
    }
  }
  // P-070: emit pr_opened for PRs newly observed after the baseline exists. The
  // first successful poll only SEEDS the baseline (those PRs were already open —
  // not opened now), so a daemon restart doesn't re-emit pr_opened for each one.
  if (state.seeded) {
    for (const pr of freshPrs) {
      if (!state.lastKnownPrNumbers.has(pr.ref.number)) {
        void emitPrOpened(harnessSlug, pr.ref.number, {
          headRef: pr.head_ref,
          baseRef: pr.base_ref,
        });
      }
    }
  } else {
    state.seeded = true;
  }
  state.lastKnownPrNumbers = freshNumbers;

  opts.onUpdate?.(harnessSlug, freshPrs);

  // Persist check status cache rows (lightweight: only open PRs).
  await persistCheckStatus(harnessSlug, freshPrs);
}

async function persistCheckStatus(harnessSlug: string, prs: Pr[]): Promise<void> {
  if (prs.length === 0) return;
  try {
    await ensurePrCheckStatusCacheTable();
    await ensureAutoReviewAuditTable();
    const { sql } = getOrgPg();
    // Upsert head_sha + state; we don't fetch per-check details here
    // (those are lazy-loaded on UI expand per §7.4). We just stamp
    // that this head_sha was seen open at this timestamp.
    for (const pr of prs) {
      await sql.unsafe(
        `INSERT INTO harness_shared.pr_check_status_cache
           (workspace_id, harness_slug, head_sha, check_name, status, conclusion, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (workspace_id, harness_slug, head_sha, check_name)
         DO UPDATE SET status = EXCLUDED.status, conclusion = EXCLUDED.conclusion, fetched_at = now()`,
        ['', harnessSlug, pr.head_sha, '__pr_open__', 'completed', 'open'],
      );
    }
  } catch {
    // Non-fatal: cache miss just means the UI shows no check detail.
  }
}

export interface PollDaemon {
  start(): void;
  stop(): void;
}

/**
 * Create and return a PR poll daemon. Call `.start()` to begin polling.
 */
export function createPollDaemon(opts: PollDaemonOptions): PollDaemon {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    let remotes: Array<{ harnessSlug: string; remote: string }>;
    try {
      remotes = await opts.harnessRemotes();
    } catch {
      return;
    }
    for (const { harnessSlug, remote } of remotes) {
      await pollHarness(harnessSlug, remote, opts);
    }
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), opts._pollIntervalMs ?? POLL_INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Reset internal state (for tests). */
export function _resetDaemonState(): void {
  daemonState.clear();
}
