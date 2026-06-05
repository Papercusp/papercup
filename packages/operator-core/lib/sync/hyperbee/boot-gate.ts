/**
 * Boot gate — projection refuses to start until BOTH ensure-paths
 * (SQL migrations + ensure-schema.ts runtime ensure) report
 * complete.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031a.
 *
 * Pattern matches the Phase 1a P-013 boot flag: each ensure-path
 * sets its respective flag on `globalThis.__papercuspEnsureFlags`
 * when it finishes. The projection's `awaitEnsurePaths()` resolves
 * when both flags are set; throws on a hard timeout.
 *
 * Why globalThis: the operator process spans multiple modules with
 * different load orders depending on whether we're in dev/prod/test.
 * A module-scoped singleton would race; the global is safer.
 */

interface EnsureFlags {
  sql_migrations_complete?: boolean;
  runtime_ensure_complete?: boolean;
}

declare global {
  var __papercuspEnsureFlags: EnsureFlags | undefined;
}

function flags(): EnsureFlags {
  if (!globalThis.__papercuspEnsureFlags) {
    globalThis.__papercuspEnsureFlags = {};
  }
  return globalThis.__papercuspEnsureFlags;
}

export function markSqlMigrationsComplete(): void {
  flags().sql_migrations_complete = true;
}

export function markRuntimeEnsureComplete(): void {
  flags().runtime_ensure_complete = true;
}

export function isReadyForProjection(): boolean {
  const f = flags();
  return f.sql_migrations_complete === true && f.runtime_ensure_complete === true;
}

export interface AwaitOpts {
  /** Max wait, ms. Defaults to 30s — enough for typical SQL migration runs. */
  timeoutMs?: number;
  /** Poll interval, ms. Defaults to 100ms. */
  pollMs?: number;
}

export class BootGateTimeoutError extends Error {
  constructor(public flags: EnsureFlags, public waited_ms: number) {
    super(`boot gate timeout: waited ${waited_ms}ms; flags=${JSON.stringify(flags)}`);
  }
}

export async function awaitEnsurePaths(opts: AwaitOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  while (!isReadyForProjection()) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new BootGateTimeoutError({ ...flags() }, elapsed);
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/** For tests. */
export function _resetFlagsForTests(): void {
  globalThis.__papercuspEnsureFlags = {};
}
