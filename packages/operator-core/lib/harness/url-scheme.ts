/**
 * url-scheme — parse `papercusp://harness?...` links (P-009a).
 *
 * Canonical URL shape per v5 §3 Entry 4:
 *   papercusp://harness?topic=<64-char-hex>&github=<owner>/<repo>&repo_id=<n>
 *
 * Strict rules:
 *   - Protocol must be `papercusp:`.
 *   - Host must be `harness` (the Hyperswarm bootstrap authority keyword).
 *   - Exactly three params: `topic`, `github`, `repo_id`. Extra params rejected.
 *   - `topic`: 64 lowercase hex chars (32-byte Hyperswarm topic).
 *   - `github`: `<owner>/<repo>` both matching GitHub's actual rules
 *     (1-100 chars, alphanum/dash/underscore/dot, no leading/trailing dot).
 *   - `repo_id`: positive integer (GitHub's stable numeric repository id).
 *
 * Returns `null` on any malformed input — callers display a human-readable
 * error by checking for null. Never throws on invalid input.
 */

/** Parsed representation of a `papercusp://harness?...` link. */
export interface HarnessLink {
  /** 64-char lowercase hex Hyperswarm topic. */
  topic: string;
  /** Full `owner/repo` GitHub name (GitHub-rename-fragile; use `repoId`
   * for stable lookup). */
  github: string;
  /** Derived from `github`. */
  repoOwner: string;
  /** Derived from `github`. */
  repoName: string;
  /** GitHub's stable numeric repository id (never recycled on renames). */
  repoId: number;
}

/** Exact set of accepted query-param keys. Any extra key → null. */
const ALLOWED_PARAMS = new Set(['topic', 'github', 'repo_id']);

/** 64-char lowercase hex. */
const TOPIC_RE = /^[0-9a-f]{64}$/;

/**
 * GitHub owner/repo segment: 1–100 chars, alphanum + hyphen + underscore + dot,
 * no leading or trailing dot. Intentionally permissive for org names; the
 * upstream GitHub API rejects truly invalid names.
 */
const GH_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,98}[A-Za-z0-9_-]$|^[A-Za-z0-9_-]$/;

/**
 * Parse a `papercusp://harness?...` URL. Returns `HarnessLink` on success,
 * `null` on any malformed input. Never throws.
 */
export function parseHarnessLink(url: string): HarnessLink | null {
  if (typeof url !== 'string') return null;

  // Fast prefix check before constructing a URL object.
  if (!url.startsWith('papercusp://')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'papercusp:') return null;
  if (parsed.host !== 'harness') return null;

  // Reject extra params.
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return null;
  }

  const topic = parsed.searchParams.get('topic');
  const github = parsed.searchParams.get('github');
  const repoIdStr = parsed.searchParams.get('repo_id');

  if (!topic || !TOPIC_RE.test(topic)) return null;
  if (!github) return null;

  const slashIdx = github.indexOf('/');
  if (slashIdx <= 0 || slashIdx === github.length - 1) return null;
  const repoOwner = github.slice(0, slashIdx);
  const repoName = github.slice(slashIdx + 1);

  if (!GH_SEGMENT_RE.test(repoOwner) || !GH_SEGMENT_RE.test(repoName)) return null;
  // Reject extra slashes in the github param.
  if (repoName.includes('/')) return null;

  if (!repoIdStr || !/^\d+$/.test(repoIdStr)) return null;
  const repoId = parseInt(repoIdStr, 10);
  if (!Number.isFinite(repoId) || repoId <= 0 || repoId > Number.MAX_SAFE_INTEGER) return null;

  return { topic, github, repoOwner, repoName, repoId };
}

/**
 * Build a `papercusp://harness?...` URL from a HarnessLink. Inverse of
 * `parseHarnessLink`. Caller is responsible for providing valid values.
 */
export function formatHarnessLink(link: HarnessLink): string {
  const p = new URLSearchParams({
    topic: link.topic,
    github: link.github,
    repo_id: String(link.repoId),
  });
  return 'papercusp://harness?' + p.toString();
}
