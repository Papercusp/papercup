/**
 * workspace-filter-coverage.test.ts — the EXPLICIT-WORKSPACE-FILTER coverage guard
 * for sync-resolver reads (the read-side half of findings-rls-coverage.md).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Workspace isolation has two enforcement paths (findings-rls-coverage.md):
 *   1. RLS on the `harness_app` / `withWorkspace()` connection, and
 *   2. an explicit `workspace_id` predicate in the query.
 * The `rls-coverage.integration.test.ts` guard covers path (1) at the table grain.
 * This covers path (2) — and it matters because the sync-resolver reads run on
 * `getOrgPg()`, which is the `harness_admin` BYPASSRLS connection (connection.ts
 * 421-431; mig-016). On that connection RLS is NOT enforced, so a resolver that
 * reads a workspace-scoped table by `harness_slug` ALONE returns rows from EVERY
 * workspace that shares that slug (`harness_slug` is per-workspace-unique, NOT
 * global) — a cross-tenant read in any multi-tenant deployment. This is the class
 * the collaborative audit in findings-rls-coverage.md confirmed (issuesConsolidated.
 * bySlug + a bulk of sibling `.bySlug` resolves). Nothing guards it: the read still
 * returns data, it's just unscoped.
 *
 * WHAT IT ASSERTS
 * ---------------
 * Source-pattern check over `index.ts` (no DB; same approach as
 * `connection-cache.test.ts`). For each resolver block it flags those that:
 *   - read on `getOrgPg(` (the BYPASSRLS connection), AND
 *   - filter by `eq(t.harnessSlug, harnessSlug)`, AND
 *   - contain NO `workspaceId` / `workspace_id` token anywhere in the block
 *     (no explicit filter, no `set_config('app.workspace_id', …)`).
 * The flagged set must equal `OPEN_UNFILTERED` — the documented currently-open set
 * (routed to AD / the federation-sync lane for the resolver-context fix). So:
 *   - a NEW such resolver (the regression) FAILS until filtered or documented, and
 *   - when AD adds the `workspace_id` filter, that entry drops out of the flagged
 *     set → the stale-entry test forces its removal from OPEN_UNFILTERED, tracking
 *     remediation to zero.
 * Resolvers that DO take + filter `workspaceId` (resolveDesignFeatures, auditLog,
 * operatorBudget, harnessLanes/status, pendingReviews) are correctly NOT flagged.
 *
 * SCOPE / LIMITS: block-grained text analysis. If a block reads two tables and
 * filters workspace_id on only one, the token presence makes it read as "safe"
 * (false-negative) — acceptable for a first guard; the resolves here are
 * single-query. It does not prove the table is workspace-scoped (a `harness_slug`-
 * only read of a NON-workspace-scoped table is harmless); such a resolver, if any,
 * is documented in OPEN_UNFILTERED with a `SAFE:` reason rather than left implicit.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, 'index.ts');

/**
 * Resolver blocks currently flagged: `getOrgPg` read filtered by `harness_slug`
 * only, no `workspace_id`. These are the OPEN read-side cross-tenant exposures
 * (multi-tenant) routed to AD / the federation-sync lane — the fix threads
 * `workspaceId` from resolver context (findings-rls-coverage.md, findings-AD.md).
 * As each is fixed it leaves the flagged set; the stale-entry test then forces it
 * out of this list. Prefix a value with `SAFE:` if the table is NOT workspace-scoped.
 *
 * BASELINE POPULATED (2026-06-20): the guard was committed with this map EMPTY while
 * 18 pre-existing `getOrgPg` slug-only reads were already flagged — i.e. it shipped
 * RED against its own design, which is to ship GREEN with the currently-open set
 * documented here (findings-rls-coverage.md §"Building the explicit-filter CI guard":
 * "asserted against a documented allowlist of the currently-open set … so it's GREEN
 * now, a NEW such read FAILS CI, and the allowlist shrinks via a stale-entry check as
 * AD lands fixes"). Each entry below is a workspace-scoped table read on the BYPASSRLS
 * connection by `harness_slug` only → a real cross-tenant read in multi-tenant; NONE
 * is `SAFE:`. Remediation (thread `workspaceId` from resolver context) is the
 * AD/federation-sync lane's tracked, consensus-gated work (findings-AD.md) — NOT a
 * blind solo edit (the EI-126 default-mis-route footgun). Each entry drops out via the
 * stale-entry test the moment its `workspace_id` filter lands, tracking remediation to
 * zero. The guard still fails CI for any NEW unfiltered resolver beyond this baseline.
 */
// EI-1763 history: su-d2230 (2026-06-20) threaded `workspaceId` through most getOrgPg
// slug-only reads and declared the set ZERO — but the guard's `hasWorkspace` check ran
// over the RAW block body, which bleeds the NEXT resolver's leading doc-comment (almost
// all mention `workspaceId`) into this block, so THREE still-unfiltered resolvers
// (featurePrs.byHarness, harnessBrainstorm.byHarness, chunkPlans.byFeature) read as
// "safe" and were silently missed. The blind spot is now fixed (`stripComments` above —
// tokens matched in CODE, not comments) and those three thread `workspaceId` via
// argsSchema (the AD-owner pattern: explicit arg, NOT a global/ALS fallback — the EI-126
// write-side mis-route trap). The remaining flagged entry is genuinely un-scopable:
//
// To DOCUMENT a future resolver here: for a genuinely NOT-workspace-scoped table use a
// 'SAFE: <why the table has no workspace_id>' reason; for a still-open cross-tenant read
// use 'OPEN: getOrgPg (BYPASSRLS) read filters harness_slug only … fix = thread workspaceId'.
//
// KNOWN LIMITATION (block-grained): a slug-only read whose `eq(...harnessSlug...)` lives in
// a SHARED HELPER called from the block (not inside the block body) is invisible to this
// guard. The one such case — agentRunsConsolidated.* → resolveRunsWithOutcome (filters on
// the `s`/`t` aliases in a top-level fn) — has been FIXED BY HAND (EI-1763): the helper now
// threads an optional workspaceId into both the spawn subquery and the full-outer coalesce
// join, and its two registry entries expose `workspaceId` in argsSchema. No known helper-form
// leak remains; this note stands as the reason a future one could still slip past the guard
// (the guard only inspects per-block bodies), so a slug-filtering helper must scope by hand.
const OPEN_UNFILTERED: Record<string, string> = {
  'snapshotsConsolidated.bySlug':
    'SAFE: harness_snapshots_consolidated has NO workspace_id column (keyed by harness_slug + ' +
    'snapshot_id) — the harness-snapshot system is RETIRED (_retired/snapshot-system). The table ' +
    'is not workspace-partitioned at the schema grain, so no workspace_id predicate is possible; ' +
    'documented rather than filtered. If the snapshot system is ever revived multi-tenant, add a ' +
    'workspace_id column + filter (and drop this entry).',
};

/** Split index.ts into resolver blocks keyed by their `'name.method':` registry key. */
function resolverBlocks(src: string): Array<{ name: string; body: string }> {
  const keyRe = /^[ \t]*'([a-zA-Z]\w*\.\w+)':\s*\{/gm;
  const marks: Array<{ name: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(src))) marks.push({ name: m[1], start: m.index });
  return marks.map((mark, i) => ({
    name: mark.name,
    body: src.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : src.length),
  }));
}

/** Strip `//` line comments + `/* … *\/` block comments. A resolver block's body
 *  runs to the NEXT registry key, so it INCLUDES the leading doc-comment of the next
 *  resolver — and if that comment mentions `workspaceId` (most do: `…where(workspaceId)…`),
 *  the raw-text `hasWorkspace` check read the unfiltered block as "safe" (EI-1763: this
 *  masked featurePrs/harnessBrainstorm/chunkPlans from su-d2230's "remediated to zero"
 *  pass). Tokens must be matched in CODE, not comments. Over-stripping can only ADD a
 *  flag (fail-safe for a security guard), never hide one. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function flaggedResolvers(src: string): string[] {
  const flagged: string[] = [];
  for (const { name, body: raw } of resolverBlocks(src)) {
    const body = stripComments(raw);
    const usesBypassConn = body.includes('getOrgPg(');
    const filtersBySlug = /eq\(\s*t\.harnessSlug\s*,\s*harnessSlug\s*\)/.test(body);
    const hasWorkspace = /workspaceId|workspace_id/.test(body);
    if (usesBypassConn && filtersBySlug && !hasWorkspace) flagged.push(name);
  }
  return flagged.sort();
}

describe('sync-resolver — getOrgPg reads of a harness must filter workspace_id (cross-tenant read guard)', () => {
  const src = readFileSync(INDEX, 'utf8');

  it('sanity: the resolver registry parsed (a known resolver block is found)', () => {
    const names = resolverBlocks(src).map((b) => b.name);
    expect(names, 'resolver-block parser found nothing — the file shape changed').toContain('issuesConsolidated.bySlug');
  });

  it('every getOrgPg harness_slug-only read is in the documented OPEN_UNFILTERED set', () => {
    const flagged = flaggedResolvers(src);
    const documented = Object.keys(OPEN_UNFILTERED).sort();
    expect(
      flagged,
      `sync-resolver resolver(s) read a harness by harness_slug ONLY on the getOrgPg (BYPASSRLS) ` +
        `connection with NO workspace_id predicate → cross-tenant read in multi-tenant (a workspace ` +
        `sees another workspace's rows for a shared harness_slug). FIX: thread workspaceId from resolver ` +
        `context + add eq(t.workspaceId, workspaceId) (mirror resolveDesignFeatures / auditLog). If the ` +
        `table is genuinely NOT workspace-scoped, add the resolver to OPEN_UNFILTERED with a 'SAFE: …' ` +
        `reason. Newly-flagged vs documented: ${JSON.stringify(flagged)} vs ${JSON.stringify(documented)}`,
    ).toEqual(documented);
  });

  it('no OPEN_UNFILTERED entry is stale (each is still flagged — i.e. still unfiltered)', () => {
    const flagged = new Set(flaggedResolvers(src));
    const stale = Object.keys(OPEN_UNFILTERED)
      .filter((n) => !flagged.has(n))
      .sort();
    expect(
      stale,
      `OPEN_UNFILTERED lists resolver(s) that are no longer flagged — they gained a workspace_id ` +
        `filter (fixed) or were removed. Delete the stale entr(ies) so the guard tracks remediation: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
