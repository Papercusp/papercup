/**
 * hive-git/scope-repo.ts — per-scope bare-repo provisioning (FS-D3, ratified
 * D-017; p2p-work-distribution-2026-07-02 P-006 §6 / P-108 option (b)).
 *
 * A FederationScope's git-plane unit is its OWN bare repo under the hive-git
 * root — NOT ref-filtering inside the hive repo. Rationale (D-017/D-018): git's
 * transport then structurally cannot leak sibling scopes' refs (upload-pack
 * inside one repo advertises only that repo), M14/H16 hold by construction,
 * the foreign/canonical boundary is provenance (a different repo) rather than
 * path parsing, and scope repos are independently GC-able/deletable on fleet
 * archive (H10) so rejected or expired foreign work never permanently bloats
 * the hive repo (X4).
 *
 * SCOPE ID (FS-D2): the canonical scope id is `fleet:<numeric-gh-user-id>/<slug>`
 * — grantor keyed by NUMERIC GitHub user id (X9: logins are mutable+reusable),
 * slug owner-prefixed (H5). Because the id contains `:` and `/` it is neither a
 * safe single path component nor a legal single git-ref segment, so this module
 * owns BOTH encodings (the one place the mapping lives, mirroring
 * `deviceNamespaceKey` discipline):
 *
 *   - PATH:  <hiveGitRoot>/<hiveHomeSlug>/scopes/fleet-<uid>/<slug>.git
 *   - REF:   a single segment `fleet-<uid>--<slug>` for the foreign-marked
 *            tracking family `refs/foreign/<segment>/…` — preserving the landed
 *            `isForeignMarkedRef` contract (foreign-merge-admission.ts), whose
 *            parser requires exactly one `[^/]+` segment after `refs/foreign/`.
 *
 * Serving a scope repo stays inside `hiveGitRoot()`, so fetch-transport's
 * `assertServeableRepo` backstop already covers it; the ROSTER serve-gate
 * (design §5.3/§6 — refuse a non-member's fetch with a P-004 receipt) wires in
 * the announce/disclosure stage (5.2) and consumes `parseScopeId` from here.
 *
 * Pure over storage.ts's RunGit seam; unit-tests without git, integration-tests
 * against a real temp bare repo (the storage.ts pattern).
 */

import { join } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { type RunGit, defaultRunGit, hiveGitRoot } from './storage';

/** A parsed FederationScope id (FS-D2). */
export interface ScopeId {
  kind: 'fleet';
  /** Grantor/owner GitHub NUMERIC user id (X9 — never a login). */
  ownerGithubUserId: number;
  /** Fleet slug (H5 owner-prefixed namespace; `^[a-z0-9][a-z0-9-]*$`). */
  slug: string;
}

/** Canonical wire form: `fleet:<uid>/<slug>`. */
export function formatScopeId(s: ScopeId): string {
  return `fleet:${s.ownerGithubUserId}/${s.slug}`;
}

const SCOPE_ID_RE = /^fleet:([1-9][0-9]{0,18})\/([a-z0-9][a-z0-9-]*)$/;
const SLUG_MAX = 100;

/**
 * Parse + validate a canonical scope id. Returns null on ANY malformation —
 * callers on enforcement paths must treat null as a refusal, never a fallback
 * (fail-closed; D-004 no-silent-drops: the refusal is the caller's receipt).
 */
export function parseScopeId(scopeId: string): ScopeId | null {
  if (typeof scopeId !== 'string' || scopeId.length > 32 + SLUG_MAX) return null;
  const m = SCOPE_ID_RE.exec(scopeId);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  if (m[2].length > SLUG_MAX) return null;
  return { kind: 'fleet', ownerGithubUserId: uid, slug: m[2] };
}

/**
 * The single git-ref-safe segment for a scope — used by the foreign-marked
 * tracking family. `fleet-<uid>--<slug>`: no `:`/`/`, unambiguous (the `--`
 * separator cannot appear in `<uid>` and the slug charset has no `--`-free
 * guarantee, so we parse from the LEFT: `fleet-` + digits + first `--`).
 */
export function scopeRefSegment(scope: ScopeId): string {
  return `fleet-${scope.ownerGithubUserId}--${scope.slug}`;
}

const SEGMENT_RE = /^fleet-([1-9][0-9]{0,18})--([a-z0-9][a-z0-9-]*)$/;

/** Round-trip a `scopeRefSegment` back to a ScopeId (null = not a scope segment). */
export function parseScopeRefSegment(segment: string): ScopeId | null {
  const m = SEGMENT_RE.exec(segment);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  return { kind: 'fleet', ownerGithubUserId: uid, slug: m[2] };
}

/**
 * The foreign-marked tracking ref for a scope deliverable:
 * `refs/foreign/<segment>/<name>` — one segment after `refs/foreign/`, so the
 * landed `isForeignMarkedRef` / `foreignFleetFromRef` contract holds verbatim.
 */
export function scopeForeignRef(scope: ScopeId, name: string): string {
  if (!name || name.startsWith('/') || name.includes('..') || name.includes('\0')) {
    throw new Error(`scope-repo: unsafe foreign ref name: ${JSON.stringify(name)}`);
  }
  return `refs/foreign/${scopeRefSegment(scope)}/${name}`;
}

function assertSafeComponent(v: string, what: string): void {
  if (!v || v.includes('/') || v.includes('\\') || v.includes('..') || v.includes('\0')) {
    throw new Error(`scope-repo: unsafe ${what} path component: ${JSON.stringify(v)}`);
  }
}

/**
 * The bare-repo path for (hive home slug, scope). Lives under `hiveGitRoot()`
 * so the fetch-transport serve backstop covers it:
 * `<root>/<hive>/scopes/fleet-<uid>/<slug>.git`.
 */
export function scopeRepoPath(hiveHomeSlug: string, scope: ScopeId): string {
  assertSafeComponent(hiveHomeSlug, 'hiveHomeSlug');
  // Components are structurally safe by the ScopeId parse, but re-assert —
  // defense in depth against a hand-built ScopeId.
  const owner = `fleet-${scope.ownerGithubUserId}`;
  assertSafeComponent(owner, 'scope owner');
  assertSafeComponent(scope.slug, 'scope slug');
  return join(hiveGitRoot(), hiveHomeSlug, 'scopes', owner, `${scope.slug}.git`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the scope's bare repo exists (`git init --bare -q` when absent).
 * Idempotent, storage.ts `ensureHiveGitRepo` semantics. Throws only on a
 * genuine init failure (disk/permissions).
 */
export async function ensureScopeRepo(
  hiveHomeSlug: string,
  scope: ScopeId,
  runGit: RunGit = defaultRunGit,
): Promise<string> {
  const repoPath = scopeRepoPath(hiveHomeSlug, scope);
  if (await pathExists(join(repoPath, 'HEAD'))) return repoPath;
  await mkdir(repoPath, { recursive: true });
  const r = await runGit(['init', '--bare', '-q', repoPath], hiveGitRoot());
  if (r.code !== 0) {
    throw new Error(`scope-repo: init --bare failed for ${repoPath}: ${r.stderr.trim()}`);
  }
  return repoPath;
}
