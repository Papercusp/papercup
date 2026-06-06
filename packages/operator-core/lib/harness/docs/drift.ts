/**
 * drift — "has the code under this doc moved since the doc's baseline?"
 *
 * Plan: harness-docs-integration-2026-06-05 (P-001 / D-001). Staleness reduces to
 * plain git: `git log <baseline_sha>..HEAD -- <resolved paths>` non-empty. The
 * baseline is `generated_from_sha` (generated docs) or `last_verified_sha`
 * (manual docs); the resolved paths come from the doc's subject_ref.
 *
 * Honest edges (D-001), all covered by drift.test.ts:
 *   - renames: a single concrete `path` / `symbol` file uses `--follow`.
 *   - whitespace/comment-only commits cause a false "stale" nudge — ACCEPTED:
 *     a false nudge beats silent rot. (Refine later with --ignore-all-space /
 *     a per-symbol content hash.)
 *   - `symbol` precision: `git log -L :name:file` traces just the function's
 *     lines, so an unrelated edit elsewhere in the file does NOT flag the doc;
 *     a file-level `--follow` fallback runs when `-L` can't (renamed/removed).
 */

import type { GitRunner, SubjectRef, FeatureCommitLookup } from './subject-ref';
import { resolveAnchorPaths } from './subject-ref';

export interface DriftResult {
  /** True when code under the subject_ref changed since the baseline. */
  stale: boolean;
  /** Repo-relative files that changed in the baseline..HEAD range (best-effort). */
  changedPaths: string[];
  /** Which strategy actually ran. */
  method: 'path' | 'symbol' | 'symbol-fallback' | 'feature' | 'none';
  /**
   * Set when the check could NOT be performed (no baseline, unresolved feature,
   * unknown/invalid baseline SHA, git error). The caller maps this to a
   * "can't tell" status rather than a confident fresh/stale.
   */
  error?: string;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/** Collect unique non-blank file paths from `git log --name-only` stdout. */
function collectNameOnly(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split('\n')) {
    const f = line.trim();
    // --name-only with --format=%H emits SHA lines too; skip 40/64-hex-only lines.
    if (!f) continue;
    if (/^[0-9a-f]{40}$/i.test(f) || /^[0-9a-f]{64}$/i.test(f)) continue;
    files.add(f);
  }
  return [...files];
}

/** Is `sha` a single concrete (non-glob) path? Then `--follow` is valid. */
function isConcretePath(p: string): boolean {
  return !/[*?[\]{}]/.test(p);
}

/**
 * Compute drift for one subject ref against a baseline SHA.
 *
 * Returns `stale:false, error:'no-baseline'` when baselineSha is blank — an
 * un-baselined doc is "not drift-tracked", not fresh-or-stale (the caller renders
 * that distinctly). Returns `error` (stale:false) on any git failure so a bad
 * baseline never spams false stales; the caller surfaces it as needs-attention.
 */
export async function checkSubjectRefDrift(
  ref: SubjectRef,
  baselineSha: string,
  opts: { runGit: GitRunner; repoRoot: string; resolveFeatureCommits?: FeatureCommitLookup },
): Promise<DriftResult> {
  const { runGit, repoRoot } = opts;
  const baseline = baselineSha.trim();
  if (!baseline) return { stale: false, changedPaths: [], method: 'none', error: 'no-baseline' };
  if (!SHA_RE.test(baseline)) {
    return { stale: false, changedPaths: [], method: 'none', error: 'invalid-baseline' };
  }

  const range = `${baseline}..HEAD`;

  if (ref.kind === 'symbol') {
    // Precise: trace just the function's line range across history.
    const lRes = await runGit(
      ['log', range, '-L', `:${ref.name}:${ref.file}`, '-s', '--format=%H'],
      repoRoot,
    );
    if (lRes.code === 0) {
      const commits = lRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      return { stale: commits.length > 0, changedPaths: commits.length ? [ref.file] : [], method: 'symbol' };
    }
    // `-L` failed (file renamed/removed, or the symbol regex didn't match a
    // function in the current tree). Fall back to file-level drift with --follow.
    const fRes = await runGit(
      ['log', range, '--follow', '--name-only', '--format=%H', '--', ref.file],
      repoRoot,
    );
    if (fRes.code !== 0) {
      return { stale: false, changedPaths: [], method: 'symbol-fallback', error: gitErr(fRes) };
    }
    const changed = collectNameOnly(fRes.stdout);
    return { stale: changed.length > 0, changedPaths: changed, method: 'symbol-fallback' };
  }

  // path / feature both resolve to a path set, then a single `git log -- <paths>`.
  const paths = await resolveAnchorPaths(ref, opts);
  if (ref.kind === 'feature' && paths.length === 0) {
    return { stale: false, changedPaths: [], method: 'feature', error: 'unresolved-feature' };
  }
  if (paths.length === 0) {
    return { stale: false, changedPaths: [], method: 'none', error: 'no-paths' };
  }

  // --follow is only valid for a single concrete file pathspec; use it to survive
  // renames in that case, plain pathspec(s) otherwise.
  const single = paths.length === 1 && isConcretePath(paths[0]);
  const args = single
    ? ['log', range, '--follow', '--name-only', '--format=%H', '--', paths[0]]
    : ['log', range, '--name-only', '--format=%H', '--', ...paths];
  const res = await runGit(args, repoRoot);
  if (res.code !== 0) {
    return { stale: false, changedPaths: [], method: ref.kind === 'feature' ? 'feature' : 'path', error: gitErr(res) };
  }
  const changed = collectNameOnly(res.stdout);
  return {
    stale: changed.length > 0,
    changedPaths: changed,
    method: ref.kind === 'feature' ? 'feature' : 'path',
  };
}

/**
 * Drift for a doc with possibly-many subject refs: stale if ANY ref is stale.
 * `error` only when EVERY ref errored (i.e. nothing could be checked) — a mix of
 * one clean + one errored ref still yields a confident stale:false.
 */
export async function checkDocDrift(
  refs: SubjectRef[],
  baselineSha: string,
  opts: { runGit: GitRunner; repoRoot: string; resolveFeatureCommits?: FeatureCommitLookup },
): Promise<DriftResult> {
  if (refs.length === 0) {
    return { stale: false, changedPaths: [], method: 'none', error: 'unanchored' };
  }
  const results = await Promise.all(refs.map((r) => checkSubjectRefDrift(r, baselineSha, opts)));
  const stale = results.find((r) => r.stale);
  if (stale) return stale;
  const clean = results.find((r) => !r.error);
  if (clean) return clean;
  // All errored — propagate the first error (e.g. no-baseline / unresolved).
  return results[0];
}

function gitErr(r: { code: number; stderr: string }): string {
  const msg = r.stderr.trim().split('\n')[0] || `git exited ${r.code}`;
  return `git-error: ${msg}`;
}
