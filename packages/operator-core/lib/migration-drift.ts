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
  /** On disk + runner-eligible but NOT yet applied — awaiting an operator restart.
   *  This is the ACTIONABLE drift and the sole driver of `inSync`. */
  missing: string[];
  /** Recorded applied but the file is gone from disk. Almost always benign
   *  squashed/renamed-migration history (and the operator commonly runs from a
   *  release checkout that lags the canonical tree). INFORMATIONAL only — it does
   *  NOT flip `inSync` (infra round-3 F14: it used to, so in_sync was permanently
   *  false and masked real `missing` drift). Surface it for awareness; investigate
   *  only if a file you expected on disk is gone. */
  extra: string[];
  /** True when the live DB has applied every on-disk migration — i.e. `missing`
   *  is empty. NOT affected by `extra` (see above). */
  inSync: boolean;
  /** WI-5050 (WI-4070 class): applied migrations whose NUMERIC prefix is HIGHER
   *  than the max numbered migration this code tree ships — i.e. the shared DB
   *  was migrated by a NEWER code tree than the one running. Unlike `extra`
   *  (squashed-history noise), this is NOT benign: renames/drops the newer tree
   *  performed have already executed, so THIS tree's queries can hit
   *  `relation does not exist` at runtime (the VM dev-source rot that silently
   *  killed federation: post-mig-557 hives→pots DB vs pre-557 code). Empty when
   *  the code tree can't be resolved (unknown ≠ ahead). */
  schemaAhead: string[];
}

/** Numeric NNN prefix of a migration filename, or null (template/manual files). */
function migrationNumber(f: string): number | null {
  const m = /^(\d+)-/.exec(f);
  return m ? Number(m[1]) : null;
}

/**
 * Pure core of the WI-5050 schema-ahead-of-code detection — exported for tests.
 * Returns applied, runner-eligible migrations numbered beyond the max numbered
 * migration present on disk. Empty when onDisk has no numbered migrations
 * (an unresolvable/foreign tree must not flag the whole DB as "ahead").
 */
export function computeSchemaAhead(onDisk: string[], applied: string[]): string[] {
  const codeCap = Math.max(
    ...onDisk.map(migrationNumber).filter((n): n is number => n !== null),
    -1,
  );
  if (codeCap < 0) return [];
  return applied.filter((f) => {
    if (!isRunnerMigration(f)) return false;
    const n = migrationNumber(f);
    return n !== null && n > codeCap;
  });
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
    // ACTIONABLE drift only: a non-empty `missing` means the live DB lags the
    // on-disk migrations (restart / db:migrate to apply). `extra` is benign
    // squashed-history noise and must NOT flip this false — doing so made
    // in_sync permanently false on this fleet, masking real `missing` drift
    // (infra round-3 F14).
    inSync: missing.length === 0,
    schemaAhead: computeSchemaAhead(onDisk, applied),
  };
}
