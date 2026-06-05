/**
 * Migration drift detection (plan fleet-coordination-painpoints, Phase 2).
 *
 * The operator auto-applies pending `libs/papercusp/libs/db/sql/*.sql` to its
 * DB on boot (`instrumentation-node.ts` → `applyPendingMigrations`, tracked in
 * `harness_shared.schema_migrations`). But the `:3070` host has NO hot-reload,
 * so a migration ADDED after the last boot isn't applied until the next
 * restart — a silent gap where agents hit "missing column" at runtime.
 *
 * This is DETECTION ONLY (D-008): it compares the SQL dir against the tracker
 * and reports what's awaiting an apply. It never applies anything (embedded-pg
 * boot stays the source of truth). The file-selection MIRRORS the runner's
 * skip rules so templates / manual-only backfills aren't false-flagged — keep
 * in sync with `migration-runner.js`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';

/** Mirror of migration-runner.js's skip(): per-harness template + MANUAL_ONLY. */
function isRunnerMigration(f: string): boolean {
  if (!f.endsWith('.sql')) return false;
  if (f.includes('per-harness-template')) return false;
  if (f === '040-plugin-configs-backfill.sql') return false; // psql -v only
  return true;
}

export function resolveSqlDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'libs/papercusp/libs/db/sql'),
    path.resolve(process.cwd(), '../../libs/papercusp/libs/db/sql'),
    path.resolve(process.cwd(), '../../../libs/papercusp/libs/db/sql'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export interface MigrationDrift {
  sqlDir: string | null;
  onDisk: string[];
  applied: string[];
  /** On disk + runner-eligible but NOT yet applied — awaiting an operator restart. */
  missing: string[];
  /** Recorded applied but the file is gone from disk (unusual — investigate). */
  extra: string[];
  inSync: boolean;
}

export async function checkMigrationDrift(): Promise<MigrationDrift> {
  const sqlDir = resolveSqlDir();
  const onDisk = sqlDir
    ? fs.readdirSync(sqlDir).filter(isRunnerMigration).sort()
    : [];

  let applied: string[] = [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ filename: string }>>`
      SELECT filename FROM harness_shared.schema_migrations ORDER BY filename
    `;
    applied = rows.map((r) => r.filename);
  } catch {
    // tracker absent / unreachable → report all on-disk as missing (loud, not silent).
  }

  const appliedSet = new Set(applied);
  const onDiskSet = new Set(onDisk);
  const missing = onDisk.filter((f) => !appliedSet.has(f));
  // Only count runner-eligible files as "extra" — ignore applied rows for
  // templates/manual files that were never runner-eligible on disk.
  const extra = applied.filter((f) => !onDiskSet.has(f) && isRunnerMigration(f));

  return {
    sqlDir,
    onDisk,
    applied,
    missing,
    extra,
    inSync: missing.length === 0 && extra.length === 0,
  };
}
