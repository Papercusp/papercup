/**
 * Deploy-time migration apply — plan release-gate-ready-branch-2026-06-04, D-007.
 *
 * Schema is coupled to code, so a migration deploys ATOMICALLY WITH the code it
 * belongs to: the deploy script applies the pending `sql/*.sql` from the RELEASE
 * tree to the operator DB at swap time, and agents stop applying migrations to
 * the live DB out of band (Phase 3). Unlike boot-time apply (log-and-continue so
 * a broken peer migration never wedges the shared dev-api), the DEPLOY apply is
 * FAIL-LOUD: a failed migration aborts the deploy → rollback, because we're
 * deploying a vetted green-`main` state and a failure means that state is not safe.
 *
 * The migration-number COLLISION the plan calls out (two agents staging the same
 * NNN) is already prevented upstream by the atomic allocator (`db:next-migration`
 * → harness_shared.migration_reservations + advisory lock); this is the apply end.
 *
 * Parameterised (sqlDir / dbUrl) so it's testable against a throwaway DB without
 * touching the live operator DB.
 */

import postgres from 'postgres';
import * as fs from 'node:fs';
import * as path from 'node:path';
// embedded-postgres-server is plain JS (no .d.ts) — type the one export we use.
// @ts-expect-error untyped JS package.
import { applyPendingMigrations as _applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';

type ApplyPendingMigrations = (args: {
  client: unknown;
  sqlDir: string;
  log?: (s: string) => void;
  skipFile?: (f: string) => boolean;
  continueOnError?: boolean;
}) => Promise<{ appliedCount: number; totalKnown: number; failed: Array<{ file: string; error: string }> }>;

const applyPendingMigrations = _applyPendingMigrations as ApplyPendingMigrations;

export interface MigrateOpts {
  /** Defaults to <releaseRoot>/libs/papercusp/libs/db/sql, else cwd-relative. */
  sqlDir?: string;
  releaseRoot?: string;
  /** Defaults to getHarnessAdminUrl() (embedded-pg discovery / DATABASE_URL). */
  dbUrl?: string;
  log?: (s: string) => void;
}

export interface MigrateResult {
  appliedCount: number;
  totalKnown: number;
  /** Filenames newly applied this run (computed from the tracker before/after). */
  applied: string[];
  sqlDir: string;
}

function defaultSqlDir(releaseRoot?: string): string | null {
  const candidates = [
    releaseRoot ? path.join(releaseRoot, 'libs/papercusp/libs/db/sql') : null,
    path.resolve(process.cwd(), 'libs/papercusp/libs/db/sql'),
    path.resolve(process.cwd(), '../../libs/papercusp/libs/db/sql'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function appliedSet(client: ReturnType<typeof postgres>): Promise<Set<string>> {
  try {
    const rows = await client<Array<{ filename: string }>>`
      SELECT filename FROM harness_shared.schema_migrations ORDER BY filename`;
    return new Set(rows.map((r) => r.filename));
  } catch {
    return new Set(); // tracker not created yet (fresh DB)
  }
}

/**
 * Apply all pending migrations to the target DB, FAIL-LOUD. Throws on the first
 * failed migration (deploy aborts → rollback). Returns the list newly applied.
 */
export async function applyStagedMigrations(opts: MigrateOpts = {}): Promise<MigrateResult> {
  const sqlDir = opts.sqlDir ?? defaultSqlDir(opts.releaseRoot);
  if (!sqlDir || !fs.existsSync(sqlDir)) {
    throw new Error(`[migrate] sql dir not found (sqlDir=${sqlDir ?? 'null'})`);
  }
  const dbUrl = opts.dbUrl ?? getHarnessAdminUrl();
  const log = opts.log ?? ((s: string) => console.log(`[migrate] ${s}`));

  // Dedicated max:1 client — the runner applies each file as a raw
  // BEGIN; <ddl>; COMMIT; via .unsafe(), rejected on a pooled connection.
  //
  // lock_timeout (root-caused 2026-06-08): a DDL that cannot acquire its lock
  // quickly must ABORT, not queue. A migration `ALTER TABLE … ADD COLUMN` needs
  // ACCESS EXCLUSIVE; if a pg_dump backup holds ACCESS SHARE on that table, the
  // ALTER queues — and a *queued* ACCESS EXCLUSIVE blocks ALL access to the
  // table (even reads) for the backup's whole duration, wedging the table and
  // everything that reads it (e.g. coord_event_log → coord → the psu bootstrap
  // routes hung for 37 min). Fail-fast → the migration is left pending and
  // retried, instead of taking the table down. application_name makes a stuck
  // migration self-identify in pg_stat_activity.
  const client = postgres(dbUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { lock_timeout: 15_000, application_name: 'papercusp-deploy-migrate' },
  });
  try {
    const before = await appliedSet(client);
    const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
      client,
      sqlDir,
      continueOnError: false, // FAIL-LOUD — a deploy migration failure aborts the deploy
      log,
    });
    if (failed.length > 0) {
      throw new Error(
        `[migrate] ${failed.length} migration(s) failed: ` +
          failed.map((f) => `${f.file}: ${f.error}`).join('; '),
      );
    }
    const after = await appliedSet(client);
    const applied = [...after].filter((f) => !before.has(f)).sort();
    log(`applied ${appliedCount} of ${totalKnown} known migration(s)`);
    return { appliedCount, totalKnown, applied, sqlDir };
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

// CLI: `tsx migrate.ts [--db <url>] [--sql-dir <dir>]`
if (require.main === module) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  applyStagedMigrations({ dbUrl: arg('--db'), sqlDir: arg('--sql-dir') })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[migrate] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
