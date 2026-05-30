import type { Sql } from 'postgres';

/**
 * Host seam for `@papercusp/backup`.
 *
 * The package shells out to the kopia CLI and stores snapshot / settings
 * / destination metadata in SQL, but it does NOT know how to resolve the
 * org Postgres handle, the workspaces-root path, the schema bootstrap, or
 * the embedded-pg admin URL — those are the embedding application's
 * concerns, injected here. This keeps the package free of any
 * `@papercusp/*` / `@restart/*` runtime dependency.
 */
export interface BackupHost {
  /**
   * The org Postgres handle (postgres-js tagged template). Called per use
   * (not cached) so the host can run its own connection change-detection.
   */
  getSql: () => Sql;
  /** Absolute path to the workspaces root; each workspace is a subdir. */
  workspacesRoot: () => string;
  /** Ensure the backup metadata tables exist before first use. */
  ensureSchema: () => Promise<void>;
  /**
   * Resolve the embedded-pg admin URL (+ provenance) for the pre-snapshot
   * DB dump written into each snapshot.
   */
  getHarnessAdminUrl: () => { url: string; source: string };
  /**
   * Optional: return true to skip the current orphan-sweep cycle — e.g. a
   * battery-aware pause that defers disk-waking work. Absent ⇒ always run
   * (the sweep is a cheap indexed range scan + UPDATE on ~0 rows in steady
   * state).
   */
  shouldPauseSweep?: () => boolean;
}

// The host lives on a process-global slot keyed by Symbol.for, NOT a
// module-level `let`. This package is consumed via a node_modules SYMLINK
// (node_modules/@papercusp/backup → packages/backup) and tsx's ESM loader
// resolves the symlink inconsistently — some import sites get the symlink
// path, others the realpath — so a module-level singleton FORKS into two
// instances: configureBackup() (the operator's lib/backup/configure.ts) sets
// it on one, while the package's own host reads (scheduler/workspace-backup,
// some reached via internal `await import('./…')`) read from the other →
// "configureBackup() must be called" and backup is dead at runtime. The
// Symbol.for registry is shared across every forked instance. (Same fix as
// @papercusp/memory's config.ts; require.resolve canonicalises to one
// realpath, which is why this only bites the ESM/tsx path, not CJS.)
const HOST_KEY = Symbol.for('@papercusp/backup:host');
type HostGlobal = typeof globalThis & { [HOST_KEY]?: BackupHost | null };

/**
 * Wire the host seams. The embedding application calls this once at
 * startup, before any backup API is used.
 */
export function configureBackup(host: BackupHost): void {
  (globalThis as HostGlobal)[HOST_KEY] = host;
}

/** Internal: read the configured host, throwing if unconfigured. */
export function backupHost(): BackupHost {
  const host = (globalThis as HostGlobal)[HOST_KEY];
  if (!host) {
    throw new Error(
      '@papercusp/backup: configureBackup() must be called before using the backup API',
    );
  }
  return host;
}
