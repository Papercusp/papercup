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
 *
 * SYMLINK RESOLUTION (EI-5912): the resolved base dir is often reached via a symlink
 * (the canonical tree `.../papercup` is a symlink to `.../papercusp`, and
 * `PAPERCUSP_INTEGRATION_ROOT` points at the symlink). The capability exec-sandbox
 * (`buildCapabilitySandboxCommand` / srt `buildFleetSrtSettings`) makes the cwd
 * WRITABLE at the exact path we hand it — but node resolves a write UNDER the cwd
 * through the symlink to the REAL path, which sits under the sandbox's read-only `/`
 * bind → `EROFS` (e.g. vitest writing its config bundle to
 * `<cwd>/node_modules/.vite-temp/*.mjs`, so `capability:inspect { check:'test' }`
 * could never bootstrap vitest under the sandbox). Resolving the base dir to its
 * REAL path makes the intended-writable cwd actually writable. `realpathSync`
 * is FAIL-SOFT here: a path that can't be resolved (missing dir) is returned as-is,
 * never throwing — the selection semantics above are unchanged, only the final path
 * is canonicalized.
 */
import { realpathSync } from 'node:fs';

export function resolveCapabilityBaseDir(ctx: { projectDir?: string }): string {
  return realpathSoft(pickCapabilityBaseDir(ctx));
}

/** The raw base-dir selection (projectDir → PAPERCUSP_INTEGRATION_ROOT → cwd),
 *  before symlink resolution. Exported for unit tests of the selection order. */
export function pickCapabilityBaseDir(ctx: { projectDir?: string }): string {
  if (ctx.projectDir) return ctx.projectDir;
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integrationRoot) return integrationRoot;
  return process.cwd();
}

/** `realpathSync` that never throws: an unresolvable path (missing dir) is returned
 *  unchanged. Canonicalizes a symlinked tree so the exec-sandbox's writable-cwd bind
 *  matches where node actually writes (EI-5912). Exported for unit testing. */
export function realpathSoft(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
