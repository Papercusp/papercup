/**
 * completion-ref-verifier — Phase 2 P-016 of papercusp-dogfood-v5.
 *
 * Background daemon that polls every harness's `completion_ref`-tagged
 * features against the remote (via `git ls-remote`) and stamps a
 * verification timestamp. Source of truth for the tier-B ✓ badge per
 * §17 / D-030.
 *
 * Design notes
 * ────────────
 *
 *  - No GitHub API: `git ls-remote <remote-url> <sha>` uses git's
 *    native auth (credential helper / SSH agent) and connection pool.
 *    No rate-limit risk, no PAT plumbing.
 *
 *  - Divergence signal lives on the feature row (`verifier_last_error`),
 *    NOT in `harness_escalations`. The latter is a per-(slug, phase)
 *    file-mirror — wrong shape for a per-feature signal. The
 *    FeatureDetail UI (P-017) reads `verifier_last_error` directly
 *    and renders a ⚠ warning card.
 *
 *  - Dependency injection on `runGitLsRemote` lets tests stub the
 *    network without spawning real git or mocking child_process.
 *
 *  - Cadence: 60s default. Per-harness coalesce inside the tick (only
 *    poll harnesses with ≥1 pending_done or recently-shipped feature).
 *
 *  - Recency cutoff for shipped features: 24h. Long-tail divergence
 *    is rare and an explicit "Re-check" button covers it (P-017c).
 *    Q-2 (7d vs 24h) resolved to 24h to match P-016d spec; revise if
 *    real dogfood shows late-divergence is a real problem.
 *
 *  - Network errors don't poison the row: they bump
 *    `verifier_last_checked_at` so the daemon knows it tried, but
 *    leave `verifier_last_error` untouched (so we don't false-positive
 *    a transient outage as divergence).
 */

import { spawn } from 'node:child_process';
import { getOrgPg } from '@restart/db-org';

export type CompletionRef = {
  remote: string;
  branch: string;
  commit_sha: string;
  pr_url?: string;
  pr_number?: number;
};

export type GitLsRemoteResult =
  | { kind: 'found'; sha: string }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

export type RunGitLsRemote = (
  remote: string,
  sha: string,
  opts?: { timeoutMs?: number },
) => Promise<GitLsRemoteResult>;

export type VerificationOutcome = 'verified' | 'divergent' | 'error';

export type VerificationResult = {
  harnessSlug: string;
  checked: number;
  verified: number;
  divergent: number;
  errors: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const SHIPPED_RECENCY_HOURS = 24;
const SHIPPED_RECENCY_MS = SHIPPED_RECENCY_HOURS * 60 * 60 * 1000;

/**
 * Parse the stdout of `git ls-remote <remote> <sha>`. The command
 * prints one line per matching ref: "<sha>\t<refname>". If the
 * sha doesn't exist on the remote, the output is empty.
 *
 * Exported for testing — the parse rule is the part that's worth
 * pinning behavior on.
 */
export function parseLsRemoteOutput(
  stdout: string,
  expectedSha: string,
): GitLsRemoteResult {
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(expectedSha)) {
      return { kind: 'found', sha: expectedSha };
    }
  }
  return { kind: 'not_found' };
}

/**
 * Decide what to do with a single feature row given the git result.
 * Pure function — the SQL-writing layer maps the outcome to columns.
 *
 * Exported for testing — the decision table is small but the rule
 * "network errors don't write divergence" is load-bearing.
 */
export function decideVerificationOutcome(
  result: GitLsRemoteResult,
): VerificationOutcome {
  if (result.kind === 'found') return 'verified';
  if (result.kind === 'not_found') return 'divergent';
  return 'error';
}

/**
 * Default `git ls-remote` runner. Spawns the system git binary. Uses
 * git's native auth (no env-var fiddling). Resolves with a parsed
 * GitLsRemoteResult; never rejects.
 */
export const defaultRunGitLsRemote: RunGitLsRemote = (remote, sha, opts = {}) =>
  new Promise<GitLsRemoteResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proc = spawn('git', ['ls-remote', remote, sha], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      resolve({ kind: 'error', reason: err.message });
    });
    proc.on('close', (code, signal) => {
      if (signal !== null) {
        resolve({ kind: 'error', reason: 'signal ' + signal });
        return;
      }
      if (code !== 0) {
        const reason = stderr.trim() || 'exit ' + String(code);
        resolve({ kind: 'error', reason });
        return;
      }
      resolve(parseLsRemoteOutput(stdout, sha));
    });
  });

type FeatureRow = {
  feature_id: string;
  completion_ref: CompletionRef;
};

/**
 * Fetch the per-harness feature rows that need verification:
 *  - any pending_done with a completion_ref, regardless of age
 *  - any shipped with a completion_ref updated within 24h
 */
async function selectVerifiableFeatures(
  harnessSlug: string,
): Promise<FeatureRow[]> {
  const { sql } = getOrgPg();
  const recencyCutoffMs = Date.now() - SHIPPED_RECENCY_MS;
  return sql<FeatureRow[]>`
    SELECT feature_id, completion_ref
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug}
       AND completion_ref IS NOT NULL
       AND (
         status = 'pending_done'
         OR (status = 'shipped' AND COALESCE(updated_ts, 0) > ${recencyCutoffMs})
       )
  `;
}

async function applyOutcomeToRow(
  harnessSlug: string,
  featureId: string,
  outcome: VerificationOutcome,
): Promise<void> {
  const { sql } = getOrgPg();
  if (outcome === 'verified') {
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET verified_done_at_remote_ts = NOW(),
             verifier_last_error = NULL,
             verifier_last_checked_at = NOW()
       WHERE harness_slug = ${harnessSlug}
         AND feature_id = ${featureId}
    `;
    return;
  }
  if (outcome === 'divergent') {
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET verifier_last_error = 'sha_not_found',
             verifier_last_checked_at = NOW()
       WHERE harness_slug = ${harnessSlug}
         AND feature_id = ${featureId}
    `;
    return;
  }
  // 'error' — transient network/timeout; bump the checked-at so the UI
  // can show "last attempted" but don't poison verifier_last_error.
  await sql`
    UPDATE harness_shared.harness_features_consolidated
       SET verifier_last_checked_at = NOW()
     WHERE harness_slug = ${harnessSlug}
       AND feature_id = ${featureId}
  `;
}

export type VerifyHarnessFeaturesDeps = {
  runGitLsRemote?: RunGitLsRemote;
};

/**
 * Verify completion_refs for one harness. Reads pending_done +
 * recently-shipped features with non-null completion_ref, polls the
 * remote for each, updates the row with the result.
 *
 * On-demand callable from the UI "Re-check verification" button
 * (P-017c) — should return within ~5s for a harness with <50 features.
 */
export async function verifyHarnessFeatures(
  harnessSlug: string,
  deps: VerifyHarnessFeaturesDeps = {},
): Promise<VerificationResult> {
  const runGit = deps.runGitLsRemote ?? defaultRunGitLsRemote;
  const rows = await selectVerifiableFeatures(harnessSlug);
  let verified = 0;
  let divergent = 0;
  let errors = 0;
  for (const row of rows) {
    const result = await runGit(row.completion_ref.remote, row.completion_ref.commit_sha);
    const outcome = decideVerificationOutcome(result);
    await applyOutcomeToRow(harnessSlug, row.feature_id, outcome);
    if (outcome === 'verified') verified += 1;
    else if (outcome === 'divergent') divergent += 1;
    else errors += 1;
  }
  return { harnessSlug, checked: rows.length, verified, divergent, errors };
}

/**
 * Find the harness slugs that have ≥1 feature needing verification.
 * Coalesces the per-tick work to harnesses with actual activity.
 */
async function selectHarnessesWithVerifiableWork(): Promise<string[]> {
  const { sql } = getOrgPg();
  const recencyCutoffMs = Date.now() - SHIPPED_RECENCY_MS;
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT DISTINCT harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE completion_ref IS NOT NULL
       AND (
         status = 'pending_done'
         OR (status = 'shipped' AND COALESCE(updated_ts, 0) > ${recencyCutoffMs})
       )
  `;
  return rows.map((r) => r.harness_slug);
}

type StartOpts = {
  pollIntervalMs?: number;
  runGitLsRemote?: RunGitLsRemote;
};

type Singleton = { __completionRefVerifierTimer?: NodeJS.Timeout | null };
const _g = globalThis as unknown as Singleton;

/**
 * Start the periodic verifier. Idempotent across HMR / multiple
 * instrumentation.register() calls — second call is a no-op.
 */
export function startCompletionRefVerifier(opts: StartOpts = {}): void {
  if (_g.__completionRefVerifierTimer) return;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runGit = opts.runGitLsRemote;
  const tick = async (): Promise<void> => {
    try {
      const slugs = await selectHarnessesWithVerifiableWork();
      for (const slug of slugs) {
        await verifyHarnessFeatures(slug, { runGitLsRemote: runGit });
      }
    } catch (err) {
      console.warn(
        '[completion-ref-verifier] tick failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, interval);
  if (typeof timer.unref === 'function') timer.unref();
  _g.__completionRefVerifierTimer = timer;
}

export function stopCompletionRefVerifier(): void {
  if (_g.__completionRefVerifierTimer) {
    clearInterval(_g.__completionRefVerifierTimer);
    _g.__completionRefVerifierTimer = null;
  }
}
