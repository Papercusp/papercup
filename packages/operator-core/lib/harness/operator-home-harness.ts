/**
 * operatorHomeHarnessSlug — the SINGLE source of truth for "which harness/hive is
 * the workspace's operator HOME": where workspace-level maintenance routines seed,
 * what operator-scoped plans default to, etc.
 *
 * papercup→papercusp generalization (2026-06-19, owner-directed): historically ~30
 * sites baked the literal `'papercup'` (`process.env.X ?? 'papercup'`), which made
 * the dev harness a hardcoded special case. That is legacy. The home hive is named
 * ONCE — by the `PAPERCUSP_HIVE_HOME_SLUG` pointer — and every site derives from it
 * here, so:
 *   - ANY hive can be the operator home (just point the env at it),
 *   - the designated hive (today: `papercusp`) is treated like any other hive — the
 *     ONLY thing that makes it "home" is this one pointer,
 *   - no slug literal is scattered across the codebase.
 *
 * Sync + env-only, so module-level consts and Zod arg-defaults can call it (the
 * async `resolveHomeHiveSlug` in agent-tools/hive/_resolve.ts is the runtime
 * counterpart that additionally falls back to the registry's first hive).
 *
 * `LEGACY_DEFAULT_HOME_HARNESS` is the LAST-resort fallback for installs that predate
 * the pointer — the single, intentional place the old `papercup` literal survives.
 * Set `PAPERCUSP_HIVE_HOME_SLUG` to designate the home hive on any install.
 */

/** Last-resort fallback when PAPERCUSP_HIVE_HOME_SLUG is unset. Flipped papercup→papercusp
 *  (owner-directed full migration, 2026-06-20): papercusp is the workspace's default home, so
 *  no env-less process falls back to the retired 'papercup' slug. */
export const LEGACY_DEFAULT_HOME_HARNESS = 'papercusp' as const;

/** The env pointer that names the workspace's operator-home hive. */
export const HOME_HARNESS_ENV = 'PAPERCUSP_HIVE_HOME_SLUG' as const;

/**
 * Resolve the operator-home harness slug from the single pointer. Returns the
 * `PAPERCUSP_HIVE_HOME_SLUG` value when set, else the legacy default. Sync, pure
 * over `process.env` — safe in module-level consts and arg defaults.
 */
export function operatorHomeHarnessSlug(): string {
  const ptr = process.env[HOME_HARNESS_ENV]?.trim();
  return ptr && ptr.length > 0 ? ptr : LEGACY_DEFAULT_HOME_HARNESS;
}
