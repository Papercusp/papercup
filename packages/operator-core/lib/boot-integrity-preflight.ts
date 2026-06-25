/**
 * boot-integrity-preflight.ts — fail-fast guard against an INCONSISTENT release
 * checkout (git source files importing packages that are ABSENT from node_modules).
 *
 * Why this exists (the 2026-06-25 "connection refused on all pages" incident):
 * `papercup-release` was left inconsistent by a botched deploy/rollback — the host's
 * source imported `@modelcontextprotocol/sdk`, `@papercusp/plugin-loader` and
 * `@typespec/ts-http-runtime`, none of which were installed. Under
 * `PAPERCUSP_CLUSTER=32`, EVERY request worker crash-looped on `MODULE_NOT_FOUND`
 * until the respawn budget (workers×5 = 160) was exhausted, leaving `:3070` with
 * zero live workers across four restart cycles (~08:30–09:32 EDT) — i.e. the
 * operator refused all connections on every page for ~35 minutes. CLAUDE.md
 * documents this exact class: deploy-cli's auto-rollback can leave the checkout's
 * git files out of sync with node_modules → MODULE_NOT_FOUND crash-loop.
 *
 * This preflight resolves a small manifest of load-bearing boot modules BEFORE the
 * cluster forks its fleet. On a broken/partial install it emits ONE loud, named
 * diagnostic (which packages are missing) and exits with a DISTINCT code in <1s,
 * instead of a 160-respawn flap storm. (The generic net for boot failures this
 * manifest doesn't enumerate is the cluster-fork boot-failure backstop — see
 * `cluster-fork.ts` `onUnbootable`. This file is the early, actionable signal.)
 *
 * DEPENDENCY-FREE ON PURPOSE: it imports only `node:module`, so it can never be a
 * victim of the very inconsistency it checks for. Keep it that way — do not add any
 * `@papercusp/*` or third-party import here.
 */
import { createRequire } from 'node:module';

/**
 * Load-bearing packages the operator host imports at boot whose absence has (or
 * would) crash-loop `:3070`. A partial/half-installed `node_modules` — the failure
 * class — drops at least one of these, so they double as SENTINELS spanning the
 * major install clusters (first-party workspace pkgs, the MCP SDK + its transitive
 * azure/typespec chain, mem0, the core HTTP/DB/fs runtime). Catch the partial
 * install even when the exact missing dep isn't listed.
 *
 * ⚠ Every specifier here is RESOLVE-VERIFIED against a healthy tree (a false
 * positive would refuse to start a GOOD build — worse than the disease). Some
 * packages only resolve via a specific form because of their `exports` map:
 *   - `@modelcontextprotocol/sdk` (bare) does NOT resolve even when installed — use
 *     `.../package.json`.
 *   - `mem0ai/package.json` is blocked by `exports` — use the bare `mem0ai`.
 * When you ADD an entry, resolve-check it both present AND (conceptually) absent.
 */
export const CRITICAL_BOOT_MODULES: readonly string[] = [
  // first-party workspace packages (statically imported by host-bootstrap)
  '@papercusp/plugin-loader',
  '@papercusp/operator-core',
  // the 2026-06-25 culprits: MCP SDK + its transitive azure/typespec chain (via mem0)
  '@modelcontextprotocol/sdk/package.json',
  '@typespec/ts-http-runtime/package.json',
  '@azure/core-util/package.json',
  'mem0ai',
  // core HTTP / DB / fs runtime
  'hono',
  'postgres',
  'chokidar',
];

export interface PreflightResult {
  ok: boolean;
  checked: string[];
  missing: { id: string; error: string }[];
}

/** A module resolver (throws if the id cannot be resolved). `require.resolve`-shaped. */
export type ModuleResolver = (id: string) => string;

/** The default resolver resolves against THIS file's node_modules (the live release
 *  tree) — the same resolution the crashing imports used, so it sees what the host
 *  sees. `require.resolve` only RESOLVES (no module execution), so it's safe + fast
 *  and catches exactly the MODULE_NOT_FOUND class. */
const defaultResolver: ModuleResolver = createRequire(import.meta.url).resolve;

/**
 * Resolve-check the critical-module manifest. Pure + fully injectable (pass
 * `resolve` / `modules` in tests so nothing touches real `node_modules`).
 */
export function preflightCriticalModules(opts?: {
  modules?: readonly string[];
  resolve?: ModuleResolver;
}): PreflightResult {
  const modules = opts?.modules ?? CRITICAL_BOOT_MODULES;
  const resolve = opts?.resolve ?? defaultResolver;
  const missing: { id: string; error: string }[] = [];
  for (const id of modules) {
    try {
      resolve(id);
    } catch (e) {
      missing.push({ id, error: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return { ok: missing.length === 0, checked: [...modules], missing };
}

/** Distinct exit code so systemd / deploy-cli auto-rollback / a human can tell a
 *  build-INTEGRITY failure (this) apart from a normal crash or the lag-self-restart's
 *  EX_TEMPFAIL (75). 78 is BSD `EX_CONFIG`. */
export const BOOT_INTEGRITY_EXIT_CODE = 78;

/**
 * Run the preflight and, if the build is broken, log ONE loud actionable line and
 * exit fast — call this as early as possible in boot (before the cluster forks and
 * before the heavy import graph evaluates). Injectable `log` / `exit` for tests.
 * Returns the result on success so callers may continue / assert.
 */
export function runBootIntegrityGuardOrExit(opts?: {
  modules?: readonly string[];
  resolve?: ModuleResolver;
  log?: (line: string) => void;
  exit?: (code: number) => never;
}): PreflightResult {
  const log = opts?.log ?? ((l) => console.error(l));
  const exit = opts?.exit ?? ((c) => process.exit(c) as never);
  const result = preflightCriticalModules({ modules: opts?.modules, resolve: opts?.resolve });
  if (!result.ok) {
    const names = result.missing.map((m) => m.id).join(', ');
    log(
      `[boot-integrity] FATAL: this release checkout is INCONSISTENT — ` +
        `${result.missing.length}/${result.checked.length} critical module(s) cannot be resolved: ` +
        `${names}. node_modules does not match the source (a partial/half-installed deploy or an ` +
        `interrupted rollback). Refusing to start so the host fails fast (exit ${BOOT_INTEGRITY_EXIT_CODE}) ` +
        `instead of crash-looping every worker on MODULE_NOT_FOUND. Fix: \`npm ci\` in this checkout ` +
        `(or roll back to the last consistent release), then restart. First error: ` +
        `${result.missing[0]?.error ?? 'n/a'}`,
    );
    exit(BOOT_INTEGRITY_EXIT_CODE);
  }
  return result;
}
