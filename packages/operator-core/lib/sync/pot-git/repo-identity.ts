/**
 * pot-git/repo-identity.ts — the CANONICAL cross-device repoKey for a managed
 * (member) repo (WI-5168, cross-machine-coord-parity-and-trust-2026-07-01's
 * G-8 sibling defect).
 *
 * BUG THIS FIXES: every device's LOCAL harness-registry `slug` for the SAME
 * repo can differ — `join-pot` derives it from that device's own local
 * registry, so a slug collision on one device forces a different slug there
 * (e.g. a tower registers `hello-world-3`, a joining VM registers
 * `hello-world` for the same `octocat/Hello-World`). git-sync-action.ts used
 * to key BOTH the bare-store path (`hiveGitRepoPath`) and the wire `req`
 * frame's `repoKey` (serve-wiring.ts) on this local slug directly, so a G-8
 * fetch asked the peer for a repoKey the peer's own store was never created
 * under — the fetch NEVER rendezvouses for any two devices whose install
 * slugs differ (i.e. nearly always).
 *
 * FIX: derive the wire+store repoKey from a FEDERATED identity both devices
 * agree on — GitHub's immutable numeric repository id — exactly the same
 * identity `deriveHiveMemberRepoRefs`/`hiveMatchesRepo` (hive-member-repos.ts)
 * already treat as authoritative for cross-device repo correlation, and for
 * the same reason. Encoded `gh-<id>` (a legal, safe single git-ref/path
 * component per storage.ts's `assertSafeComponent`).
 *
 * `github_repository_id` is itself best-effort (harness-registry.ts: "needs
 * API auth at registration"), so this degrades in two steps, each still
 * IDENTICAL across devices for the same upstream:
 *   1. `github_repository_id` present (the common case — hive homes publish
 *      to GitHub by DEFAULT per hive-repo-init.ts) → `gh-<id>`.
 *   2. Else `github_remote` resolves to `owner/repo` → `gh-<owner>--<repo>`
 *      (lowercased, sanitized) — still a genuine cross-device match as long
 *      as both sides parsed the same upstream URL, just without the
 *      collision-immunity an id-keyed identity gives against a rename.
 *   3. Else (no upstream known at all — a genuinely local-only repo) falls
 *      back to the local `slug`, same as before this fix: a repo with no
 *      shared upstream identity cannot rendezvous cross-device regardless of
 *      key scheme, so this is a pre-existing limitation, not a regression.
 */

import { parseGithubUrl } from '../../harness/clone-github';

/** The minimal shape this needs from a harness-registry `ProjectEntry`. */
export interface RepoIdentityEntry {
  slug: string;
  github_repository_id?: number;
  github_remote?: string;
}

/** Sanitize an owner/repo pair into a single safe path/ref component. GitHub
 *  owner/repo charset is `[A-Za-z0-9-]` (plus `.`/`_` in repo names), so this
 *  is defense-in-depth, not expected to ever actually strip anything. */
function safeSegment(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * The canonical cross-device repoKey for `entry` — see module header. Pure
 * (no IO): callers already have `entry` from `loadHarnessRegistry()`.
 */
export function canonicalRepoKey(entry: RepoIdentityEntry): string {
  const id = entry.github_repository_id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
    return `gh-${id}`;
  }
  if (entry.github_remote) {
    const parsed = parseGithubUrl(entry.github_remote);
    if (parsed) {
      return `gh-${safeSegment(parsed.owner)}--${safeSegment(parsed.repo)}`;
    }
  }
  return entry.slug;
}
