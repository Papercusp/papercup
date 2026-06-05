/**
 * Detect the harness slug for a papercusp-su shell session.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 1, P-002).
 *
 * Resolution order (D-003):
 *   1. `PAPERCUSP_HARNESS_SLUG` env var (explicit override)
 *   2. Walk cwd upward looking for a `.papercusp/slug` marker file
 *   3. Walk cwd upward looking for the Papercusp meta-repo marker
 *      (package.json whose name is "papercup" — this is the "I'm
 *      working on Papercusp itself" case; slug = `papercup`)
 *   4. Otherwise return null — memory injection falls back to user
 *      scope only
 *
 * Async variant additionally consults the harness registry (PG /
 * workspace-registry file) for the cwd. Costs one async lookup;
 * caller decides whether to pay for it.
 *
 * Pure-sync helpers are testable without PG/FS mocking beyond
 * `node:fs` itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type DetectSource =
  | 'env'
  | 'marker-file'
  | 'meta-papercup'
  | 'registry'
  | null;

export interface DetectResult {
  slug: string | null;
  source: DetectSource;
}

/**
 * Maximum levels to walk upward from cwd before giving up. Most projects
 * sit ≤ 10 dirs deep from /; 32 is comfortable headroom.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Slug validation — kebab-case, 1+ alnum chars, no slashes / dots /
 * whitespace. Matches the existing harness-slug convention used in
 * harness_<slug> PG schema names.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function validSlug(s: string | null | undefined): s is string {
  return !!s && SLUG_RE.test(s);
}

function readSlugMarker(dir: string): string | null {
  const markerPath = path.join(dir, '.papercusp', 'slug');
  try {
    const raw = fs.readFileSync(markerPath, 'utf8').trim();
    return validSlug(raw) ? raw : null;
  } catch {
    return null;
  }
}

function looksLikePapercupRepo(dir: string): boolean {
  // Papercusp's own repo has package.json with name "papercup" at the root
  // PLUS a libs/papercusp submodule. Both checks together ~zero false-positive.
  const pkgPath = path.join(dir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg?.name !== 'papercup') return false;
  } catch {
    return false;
  }
  try {
    return fs.statSync(path.join(dir, 'libs', 'papercusp')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk `cwd` upward (inclusive). Returns each directory until either
 * the filesystem root or MAX_WALK_DEPTH ancestors are exhausted.
 */
function* walkUp(cwd: string): Generator<string> {
  let cur = path.resolve(cwd);
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    yield cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

/**
 * Synchronous detection — env var + marker file + meta-papercup check.
 *
 * Never throws; returns `{ slug: null, source: null }` if nothing
 * matches. Safe in any context.
 */
export function detectHarnessSlugSync(opts: {
  cwd: string;
  // Only `PAPERCUSP_HARNESS_SLUG` is read — a plain env record (not the
  // full `NodeJS.ProcessEnv`, which requires `NODE_ENV`) so callers/tests
  // can pass a partial `{ PAPERCUSP_HARNESS_SLUG }` map.
  env?: Record<string, string | undefined>;
}): DetectResult {
  const env = opts.env ?? process.env;

  // 1. Env override (highest precedence — explicit user/installer intent)
  const envSlug = env.PAPERCUSP_HARNESS_SLUG?.trim();
  if (validSlug(envSlug)) {
    return { slug: envSlug, source: 'env' };
  }

  // 2. Walk for .papercusp/slug marker
  for (const dir of walkUp(opts.cwd)) {
    const marker = readSlugMarker(dir);
    if (marker) return { slug: marker, source: 'marker-file' };
  }

  // 3. Walk for Papercusp meta-repo
  for (const dir of walkUp(opts.cwd)) {
    if (looksLikePapercupRepo(dir)) {
      return { slug: 'papercup', source: 'meta-papercup' };
    }
  }

  return { slug: null, source: null };
}

/**
 * Async detection — same as sync, but also consults the harness
 * registry as a final fallback. Pass `registryLookup` to consult PG /
 * the workspace registry file; if omitted, behaves like the sync
 * variant.
 *
 * The registryLookup callback shape lets callers wire either the
 * synchronous workspace-registry file reader OR the async PG query
 * without this module depending on either.
 */
export async function detectHarnessSlug(opts: {
  cwd: string;
  // Plain env record (not full NodeJS.ProcessEnv) — see detectHarnessSlugSync.
  env?: Record<string, string | undefined>;
  registryLookup?: (cwd: string) => Promise<string | null>;
}): Promise<DetectResult> {
  const sync = detectHarnessSlugSync(opts);
  if (sync.slug) return sync;

  if (opts.registryLookup) {
    try {
      const fromRegistry = await opts.registryLookup(opts.cwd);
      if (validSlug(fromRegistry)) {
        return { slug: fromRegistry, source: 'registry' };
      }
    } catch {
      // registry lookup failed — fall through to null
    }
  }

  return { slug: null, source: null };
}

export const _testing = {
  validSlug,
  readSlugMarker,
  looksLikePapercupRepo,
  walkUp,
  MAX_WALK_DEPTH,
};
