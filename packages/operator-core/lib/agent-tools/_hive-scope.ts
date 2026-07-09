/**
 * Explicit HIVE-scope resolution for hive-scoped CREATE-side tools
 * (domain-generic-hive-architecture-2026-06-18 P-022/P-023/P-024).
 *
 * The sibling of `_harness-scope.ts`, one level up the scope hierarchy: where
 * `resolveHarnessScope` answers "which harness", this answers "which HIVE". Under
 * D-009 (hive ↔ harness 1:1: a hive IS its `kind:'hive'` home harness), a hive is
 * identified by its home-harness slug, and a MEMBER harness resolves to its hive's
 * home slug via `potHomeSlugForHarness` (the resolver collapses member → home, so
 * callers never enumerate members — Q1 ruling).
 *
 * The scope model is AUTO-RESOLVE-THEN-REQUIRE (P-024), deliberately gentler than
 * harness-scope's bare require, so live ops don't start 400-ing mid-flight:
 *   1. explicit `hive` arg                          → that hive
 *   2. no arg, resolve the acting session's harness → its home-hive slug
 *   3. neither resolves                             → `none` (the caller errors)
 * So a normally-scoped bee/su (concrete `ctx.harnessSlug`) AUTO-RESOLVES to its
 * hive with no arg; only a genuinely hive-less create-op (e.g. a Queen/overwatch at
 * bare operator scope with no resolvable home) must pass an explicit `hive` or errors.
 * Reads stay workspace-wide (Queen/overwatch survey across hives — Q2 ruling); only
 * CREATE-side ops gate on this.
 *
 * `resolveHiveScope` is ASYNC (unlike the pure `resolveHarnessScope`) because the
 * member→home collapse is a PG read; the resolver is INJECTED so tools unit-test
 * with a fake (no PG) — the gym:judge / DI pattern used across lib/. Returning (no
 * throw) so each tool maps `none` onto its own error shape.
 */

import { z } from 'zod';
import { isAllHarnessSentinel } from './_harness-scope';
import { potHomeSlugForHarness } from '../hive-federation';

/**
 * Reusable optional `hive` arg for hive-scoped create-side tools. Omitting it is
 * the COMMON case (auto-resolved from the session's harness); a workspace-spanning
 * caller (Queen/overwatch) with no resolvable home passes it explicitly.
 */
export const hiveArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Hive to scope this to (the hive home-harness slug). Omit in a harness-scoped ' +
      'session — it auto-resolves from your harness (a member harness resolves to its ' +
      "hive's home). A workspace-spanning caller (Queen/overwatch) that can't auto-resolve " +
      'must pass an explicit hive.',
  );

export type HiveScope = { kind: 'hive'; slug: string } | { kind: 'none' };

/** Resolver signature (injectable for tests): harness slug → its hive home slug, or null. */
export type HiveHomeResolver = (workspaceId: string, harnessSlug: string) => Promise<string | null>;

/**
 * Resolve hive scope (auto-resolve-then-require, P-024). Precedence:
 *   1. explicit non-sentinel `hive` arg          → `{ kind: 'hive', slug }`
 *   2. no arg, concrete `ctx.harnessSlug` + ws   → resolve home-hive; `{ hive }` if found
 *   3. otherwise                                 → `{ kind: 'none' }`
 *
 * An `all`/`'*'` sentinel in the arg is NOT a hive (hives are concrete) — it falls
 * through to auto-resolve from the harness, then `none`. Injected `resolveHomeSlug`
 * defaults to the production `potHomeSlugForHarness`.
 */
export async function resolveHiveScope(
  argHive: string | null | undefined,
  ctx: { workspaceId?: string | null; harnessSlug?: string | null } | null | undefined,
  resolveHomeSlug: HiveHomeResolver = potHomeSlugForHarness,
): Promise<HiveScope> {
  const arg = argHive?.trim();
  if (arg && !isAllHarnessSentinel(arg)) return { kind: 'hive', slug: arg };

  const harness = ctx?.harnessSlug?.trim();
  const ws = ctx?.workspaceId?.trim();
  if (harness && !isAllHarnessSentinel(harness) && ws) {
    try {
      const home = await resolveHomeSlug(ws, harness);
      if (home) return { kind: 'hive', slug: home };
    } catch {
      /* resolver miss → fall through to none (the caller errors) */
    }
  }
  return { kind: 'none' };
}

/** Shared detail string for the `hive_required` error a gated create-op returns. */
export const HIVE_REQUIRED_DETAIL =
  'No hive resolvable for this create-side op. Every artifact (work item, plan, ' +
  'assignment, observation) belongs to a HIVE. A harness-scoped session auto-resolves ' +
  'its hive; a workspace-spanning caller (Queen/overwatch) must pass an explicit ' +
  '`hive` (the hive home-harness slug) on this call.';
