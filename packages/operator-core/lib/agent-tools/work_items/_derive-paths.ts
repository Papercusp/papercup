/**
 * _derive-paths — auto-derive `payload.paths` from a work-item's title/summary text
 * when the caller didn't supply any (EI-16028).
 *
 * The scheduler's live self-affinity rank term (`affinity(bee.held_paths,
 * item.paths)` in `scheduler/get-next.ts`) orders a claimable pool by how much a
 * bee's already-open files overlap `payload.paths` — but that field is caller-
 * supplied only, and ~90% of work-items never set it, so the term silently
 * collapses to NEUTRAL for almost the entire pool even though 28+ live claim
 * specs (plus the DEFAULT spec) reference it. Rather than requiring every
 * `work_items:create` caller to remember to pass `payload.paths` explicitly,
 * derive a best-effort candidate set from repo-relative paths already mentioned
 * in the item's own title/summary (the same signal `codeSmellsLikeCode` in
 * `create.ts` already uses to detect "this smells like code work", just
 * extracting the matched paths instead of a boolean).
 *
 * Deliberately NOT wired into `improvements:capture` — that surface's `paths`
 * field also feeds the protected-path classification gate (`classifyImprovement`),
 * a materially different consumer where an over-eager text-derived path could
 * silently change routing/review behavior. This module only feeds the
 * `work_items:create` payload.paths → scheduler-affinity path.
 */

/** Repo-relative path prefixes worth extracting (mirrors `codeSmellsLikeCode`'s net). */
const REPO_PATH_PATTERN = /\b(?:packages|libs|apps|src|scripts|sql)\/[\w./-]+/g;

/** Trailing prose punctuation a path mention commonly picks up ("...in foo/bar.ts.", "(foo/bar.ts)"). */
const TRAILING_PUNCT_RE = /[.,;:'"`)\]]+$/;

/**
 * Extract a deduped, order-preserving list of repo-relative paths mentioned in
 * `text`. Pure and cheap — used at work-item creation time as a fallback ONLY
 * when the caller supplied no explicit `payload.paths`. Best-effort: a false
 * positive here just adds a harmless affinity candidate, never blocks anything.
 */
export function deriveRepoPathsFromText(text: string, opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 12;
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(REPO_PATH_PATTERN)) {
    let p = m[0].replace(TRAILING_PUNCT_RE, '').replace(/\/+$/, '');
    // Require at least one path separator beyond the prefix dir itself (drop a bare
    // "packages/" match with nothing meaningful after trailing-punct stripping).
    if (!p.includes('/') || p.split('/').some((seg) => seg.length === 0)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
