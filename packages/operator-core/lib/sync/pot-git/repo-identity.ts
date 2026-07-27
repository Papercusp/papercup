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
  /** The PINNED federated repoKey — see {@link canonicalRepoKey}. When set it
   *  wins over every derivation below, permanently. */
  pot_repo_key?: string;
}

/** A repoKey is used verbatim as a filesystem path component AND as a git ref
 *  component (`hiveGitRepoPath` / the wire `req` frame), so a pin read back
 *  from the registry is validated against the same charset `storage.ts`'s
 *  `assertSafeComponent` enforces. Checked here rather than imported so this
 *  module stays pure (no fs). A malformed pin is IGNORED, not thrown — this
 *  runs inside a git-sync tick, which must never die on bad stored state. */
const SAFE_REPO_KEY = /^[A-Za-z0-9._-]{1,200}$/;
function validPin(v: unknown): v is string {
  return typeof v === 'string' && SAFE_REPO_KEY.test(v) && v !== '.' && v !== '..';
}

/** Sanitize an owner/repo pair into a single safe path/ref component. GitHub
 *  owner/repo charset is `[A-Za-z0-9-]` (plus `.`/`_` in repo names), so this
 *  is defense-in-depth, not expected to ever actually strip anything. */
function safeSegment(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * DERIVE a repoKey from `entry`'s current upstream coords — the three-step
 * ladder in the module header. Exported for the PIN-MINTING sites only
 * (`pinRepoKey`); everything on a hot path must call {@link canonicalRepoKey},
 * which honours an existing pin first.
 */
export function deriveRepoKey(entry: RepoIdentityEntry): string {
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

/**
 * The canonical cross-device repoKey for `entry` — see module header. Pure
 * (no IO): callers already have `entry` from `loadHarnessRegistry()`.
 *
 * PIN-FIRST (EI-18788176839043286, 2026-07-27). A repoKey names BOTH the bare
 * store on disk and the repo on the wire, so it must be STABLE for the life of
 * the repo. Deriving it fresh on every call made it a function of MUTABLE local
 * registry state, which produced a silent, total federation failure:
 *
 *   A pot minted local-only (`ensure-papercusp-hive` creates the canonical
 *   `papercusp` home with NO upstream coords) derives step 3, the bare `slug`.
 *   The day THAT device acquires an upstream binding it starts deriving
 *   `gh-<id>` instead — a different store path and a different wire key — so it
 *   silently abandons its old store and orphans every peer still keyed on the
 *   old one. Live: the tower re-keyed `papercusp` → `gh-1223568103` on
 *   2026-07-20 and the P-302 rig, whose entry never gained the id, sat on
 *   `papercusp` converging the tower's ABANDONED store for 7 days while
 *   reporting `ok:true`. Same class for any user's pot created local-first and
 *   published to GitHub later: every existing member is orphaned.
 *
 * So a pin, once minted, WINS over every derivation — permanently, including
 * over a `github_repository_id` that shows up later. The ladder below is only
 * for a repo that has never been pinned.
 */
export function canonicalRepoKey(entry: RepoIdentityEntry): string {
  if (validPin(entry.pot_repo_key)) return entry.pot_repo_key;
  return deriveRepoKey(entry);
}

/**
 * The value to persist as `entry.pot_repo_key` when minting/joining a repo:
 * the existing pin when there is one (NEVER re-mint — that is the bug this
 * exists to prevent), else today's derivation. Idempotent, so a caller may run
 * it on every boot to backfill entries that predate pinning.
 *
 * NOTE for the one-time reconcile of ALREADY-diverged installs: adopting a
 * peer's key must go through the pot's announced identity (`member_repos`,
 * hive-announce.ts), not through this function — this only freezes what the
 * device would compute for itself right now.
 */
export function pinRepoKey(entry: RepoIdentityEntry): string {
  return validPin(entry.pot_repo_key) ? entry.pot_repo_key : deriveRepoKey(entry);
}
