/**
 * resolveCapabilityBaseDir — the base directory a capability tool (read / write /
 * edit / inspect / bash) operates in.
 *
 * EI-1754: every capability tool used `ctx.projectDir ?? process.cwd()`. For a
 * HARNESS-scoped agent that's correct — `ctx.projectDir` is its harness tree. But
 * the SUPERUSER / workspace-unscoped MCP context resolves `projectDir` to
 * UNDEFINED (_mcp-handler.ts: when `workspaceId === '*'` or `harnessSlug === '*'`,
 * `paths = { projectDir: undefined }`), so it fell through to `process.cwd()` — and
 * the :3070 operator runs FROM the release deploy tree (papercup-release, pinned to
 * green `main`). So a superuser's capability:inspect/bash/read/write/edit ran in the
 * STALE release checkout, not the canonical/integration tree where the agent's edits
 * land (and the resolved release sub-path often doesn't exist → `spawn ENOENT`).
 *
 * Fix: fall back to `PAPERCUSP_INTEGRATION_ROOT` (exported into the operator's unit
 * env, pointing at the canonical tree — the same resolver `db:next-migration`,
 * `ship-link`, and `register-papercusp` use) BEFORE `process.cwd()`.
 *
 * Order is `projectDir → PAPERCUSP_INTEGRATION_ROOT → process.cwd()`: projectDir-FIRST
 * means a harness bee's correct tree always wins and is never overridden by the env
 * (so the env's presence in a bee's inherited environment is irrelevant); the env is
 * ONLY consulted when projectDir is absent (the superuser case this fixes). An empty /
 * whitespace env is treated as unset.
 */
export function resolveCapabilityBaseDir(ctx: { projectDir?: string }): string {
  if (ctx.projectDir) return ctx.projectDir;
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integrationRoot) return integrationRoot;
  return process.cwd();
}
