/**
 * Client-safe constant export for the default workspace id.
 *
 * Why this file exists: `workspace-registry.ts` imports `node:fs` at module
 * scope to do registry I/O. Pulling any export from there — even a string
 * constant — drags `node:fs` into the consumer's chunk. Turbopack's app-
 * client chunking context refuses external modules → build fails.
 *
 * Extracted so client modules (e.g. `use-workspace-id.ts`) can import the
 * constant without triggering the cascade. `workspace-registry.ts` re-
 * exports for backward compat.
 */
export const DEFAULT_WORKSPACE_ID = 'default';
