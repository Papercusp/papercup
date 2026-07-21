/**
 * Pot-membership resolution + enforcement (pot-membership-enforcement-2026-07-20,
 * P-005). Owner directive (VERIFIED — interactive, 2026-07-20 11:21, sess
 * a5e7a6e8): "AUDIT ALL WORK ITEMS THEY SHOULD ALL BE PART OF A REAL POT ...
 * papercusp-workspace ISNT A PART ... WE ADDED SOMETHING TO ENFORCE WORK ITEMS
 * TO BE PART OF A REAL POT, RIGHT?"
 *
 * Every work item's `harness_slug` is meant to name the row's real Pot
 * (`harness_shared.pots.pot_home_slug`). Historically the create paths let a row
 * land under a NON-pot slug — a workspace-global scope label (`operator:<ws>`,
 * `*`, `@singleton`, `papercusp-workspace`, ...) or an outright made-up slug —
 * which is exactly the drift migration 649 had to back-fill away. This module is
 * the WRITE-TIME resolver that stops the drift for good:
 *
 *   1. an explicit slug that IS a real Pot (canonicalized, member→home collapsed)
 *      → use it;
 *   2. no scope / a workspace-global label → home to the workspace PLATFORM pot
 *      (the Pot whose home slug is {@link PLATFORM_POT_SLUG} in that workspace),
 *      so "operator" issues belong to the platform Pot — the owner's model
 *      ("operator bugs and harness:<platform> bugs are the same product");
 *   3. an explicit, non-global slug that is NOT a real Pot → REJECT
 *      ({@link PotMembershipError}) — a typo / made-up Pot is a loud error, not a
 *      silent drift into the catch-all;
 *   4. FAIL-OPEN when the workspace has no platform Pot (isolated test fixtures /
 *      an un-potted tenant) → return the raw slug unchanged, so those tenants are
 *      never broken by enforcement.
 *
 * The resolver is PURE over an injected {@link PotLookup} (no PG) so it unit-tests
 * without a database — the gym:judge / DI pattern used across lib/. The
 * PG-backed lookup ({@link pgPotLookup}) is the production default. The DB-layer
 * backstop (P-006, a trigger on `harness_shared.work_items`) enforces the same
 * invariant for any writer that bypasses this layer.
 */
import { getOrgPg } from '@papercusp/db-org';
import { potHomeSlugForHarness } from './hive-federation';

/**
 * The canonical dogfood / platform Pot slug — a workspace's own "self" Pot. Mirrors
 * `harness-registry`'s `CANONICAL_DOGFOOD_SLUG` and the migration-649 backfill
 * catch-all target. A workspace-global ("operator") work item homes here.
 */
export const PLATFORM_POT_SLUG = 'papercusp';

/**
 * Workspace-global scope labels a work item might carry INSTEAD of a real Pot slug
 * — the recurring drift sources migration 649 re-homed. `operator:<ws>` matches via
 * the `operator:` prefix; the bare workspace id (e.g. `papercusp-workspace`) is not a
 * Pot either and is caught by the `=== workspaceId` check in {@link isWorkspaceGlobalLabel}.
 */
const WORKSPACE_GLOBAL_LABELS: ReadonlySet<string> = new Set([
  'operator',
  '*',
  '@singleton',
  'all',
  'hive-canary',
]);

/**
 * Is `slug` a workspace-global / non-Pot scope label rather than a concrete Pot?
 * A null/blank slug is the operator (workspace-global) scope. The workspace id
 * itself (`papercusp-workspace`) is a partition, not a Pot.
 */
export function isWorkspaceGlobalLabel(
  slug: string | null | undefined,
  workspaceId?: string | null,
): boolean {
  if (slug == null) return true;
  const s = slug.trim();
  if (s === '') return true;
  if (s.startsWith('operator:')) return true;
  if (workspaceId && s === workspaceId.trim()) return true;
  return WORKSPACE_GLOBAL_LABELS.has(s);
}

/**
 * TS mirror of `harness_shared.canonical_harness_slug` (SQL migration 359): the
 * legacy dogfood repo name folds to the platform Pot; everything else is unchanged.
 * Keep aligned with the SQL function and the P-006 backstop migration.
 */
export function canonicalPotSlug(slug: string): string {
  return slug === 'papercup' || slug === 'papercup-hive' ? PLATFORM_POT_SLUG : slug;
}

/** Injectable Pot lookup (no PG) so {@link resolveWorkItemPot} unit-tests purely. */
export interface PotLookup {
  /**
   * Resolve a raw slug to a REAL Pot home slug in this workspace, or null if it does
   * not name (nor collapse to) one. Should canonicalize + collapse a member harness
   * to its Pot home before checking membership.
   */
  resolveRealPot(rawSlug: string): Promise<string | null>;
  /** The workspace's platform Pot slug, or null when the workspace has no platform Pot. */
  platformPot(): Promise<string | null>;
}

/** Thrown when an explicit, non-global slug does not name a real Pot (P-005 reject). */
export class PotMembershipError extends Error {
  readonly code = 'pot_not_found';
  constructor(
    readonly rawSlug: string,
    readonly workspaceId: string,
  ) {
    super(
      `pot '${rawSlug}' is not a real Pot in workspace '${workspaceId}' — every work item must belong to a real Pot. ` +
        `Pass a Pot home slug that exists (see pot:list), or omit it to file under the workspace platform Pot.`,
    );
    this.name = 'PotMembershipError';
  }
}

export interface ResolveWorkItemPotArgs {
  /** The caller-supplied Pot/harness slug (null/undefined = operator/workspace-global scope). */
  rawSlug: string | null | undefined;
  /** The workspace the item lands in. '*'/blank ⇒ unscoped SU: nothing to enforce against. */
  workspaceId: string | null | undefined;
  /** Injected for tests; defaults to the PG-backed lookup for `workspaceId`. */
  lookup?: PotLookup;
}

/**
 * Resolve a work item's effective Pot slug at write time (see the module doc for the
 * four-case contract). Returns the real Pot slug to store, or `null` meaning "keep the
 * caller's operator/workspace-global scope" (the fail-open path when the workspace has
 * no platform Pot). Throws {@link PotMembershipError} for an explicit, non-global slug
 * that is not a real Pot.
 */
export async function resolveWorkItemPot(args: ResolveWorkItemPotArgs): Promise<string | null> {
  const ws = args.workspaceId?.trim();
  // Unscoped SU (no concrete workspace) — no per-workspace Pot set to enforce against.
  if (!ws || ws === '*') return args.rawSlug?.trim() || null;

  const lookup = args.lookup ?? pgPotLookup(ws);
  const raw = args.rawSlug?.trim() ? args.rawSlug.trim() : null;
  const isGlobal = isWorkspaceGlobalLabel(raw, ws);

  if (raw && !isGlobal) {
    // (1) explicit, concrete slug → use it iff it resolves to a real Pot.
    const real = await lookup.resolveRealPot(raw);
    if (real) return real;
    // Not a real Pot. Enforce (reject) when this workspace HAS a platform Pot;
    // otherwise fail open (un-potted tenant / test fixture).
    const platform = await lookup.platformPot();
    if (platform) throw new PotMembershipError(raw, ws);
    return raw;
  }

  // (2)/(4) operator / workspace-global / no scope → home to the platform Pot,
  // or fail open (null) when the workspace has no platform Pot.
  return lookup.platformPot();
}

/** Production PG-backed {@link PotLookup} for one workspace. */
export function pgPotLookup(workspaceId: string): PotLookup {
  return {
    async resolveRealPot(rawSlug: string): Promise<string | null> {
      const canon = canonicalPotSlug(rawSlug.trim());
      if (await potExists(workspaceId, canon)) return canon;
      // A member harness is not itself a Pot home — collapse it to its Pot home (D-009).
      try {
        const home = await potHomeSlugForHarness(workspaceId, canon);
        if (home) {
          const canonHome = canonicalPotSlug(home);
          if (await potExists(workspaceId, canonHome)) return canonHome;
        }
      } catch {
        /* no org-PG / resolver miss → not resolvable to a real Pot here */
      }
      return null;
    },
    async platformPot(): Promise<string | null> {
      return (await potExists(workspaceId, PLATFORM_POT_SLUG)) ? PLATFORM_POT_SLUG : null;
    },
  };
}

/**
 * Does a Pot with home slug `slug` exist in `workspaceId`? FAILS OPEN (returns false)
 * on any DB error — an unreadable/absent `harness_shared.pots` (a bare test schema, a
 * transient pool error) must never turn write-time enforcement into a hard create
 * failure. A false here cascades to the fail-open path in {@link resolveWorkItemPot}
 * (platformPot → null ⇒ no reject); the P-006 DB trigger remains the hard guarantee.
 */
async function potExists(workspaceId: string, slug: string): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one
        FROM harness_shared.pots
       WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${slug}
       LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}
