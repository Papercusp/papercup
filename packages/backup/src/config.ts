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

let _host: BackupHost | null = null;

/**
 * Wire the host seams. The embedding application calls this once at
 * startup, before any backup API is used.
 */
export function configureBackup(host: BackupHost): void {
  _host = host;
}

/** Internal: read the configured host, throwing if unconfigured. */
export function backupHost(): BackupHost {
  if (!_host) {
    throw new Error(
      '@papercusp/backup: configureBackup() must be called before using the backup API',
    );
  }
  return _host;
}
