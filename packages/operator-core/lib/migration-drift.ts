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

/**
 * EI-18737837917400418: a packaged/headless deploy (no repo tree above cwd —
 * e.g. a Tauri sidecar or a standalone rig install) has NO path satisfying any
 * of the repo-relative candidates below, so it MUST be resolvable via the
 * documented `PAPERCUSP_PG_SQL_DIR` env var alone. `apps/operator/bin/serve.ts`
 * (`defaultSqlDir()` callers) already honour that env var; this resolver used
 * to silently ignore it and try only repo-relative candidates — the boot-apply
 * safety net (EI-13992) then skipped every boot on such a deploy, unnoticed,
 * because the miss only logs a `console.warn`. Check the env var FIRST (it is
 * the explicit, authoritative override set by every headless launcher and by
 * `papercusp-desktop/src-tauri/src/main.rs`), then fall back to the
 * repo-relative candidates for a normal in-tree dev/CI run.
 */
export function resolveSqlDir(baseDir: string = process.cwd()): string | null {
  const envDir = process.env.PAPERCUSP_PG_SQL_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  const candidates = [
    path.resolve(baseDir, 'libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../../libs/papercusp/libs/db/sql'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The exact candidates {@link resolveSqlDir} tries, IN ORDER, for diagnostics —
 *  e.g. logging what was tried when resolution fails (EI-18737837917400418). */
export function sqlDirCandidates(baseDir: string = process.cwd()): string[] {
  const envDir = process.env.PAPERCUSP_PG_SQL_DIR;
  return [
    ...(envDir ? [`PAPERCUSP_PG_SQL_DIR=${envDir}`] : ['PAPERCUSP_PG_SQL_DIR=<unset>']),
    path.resolve(baseDir, 'libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../libs/papercusp/libs/db/sql'),
    path.resolve(baseDir, '../../../libs/papercusp/libs/db/sql'),
  ];
}

/** Path segments from a tree's root down to its migration sql dir — used both
 *  to resolve a dir (resolveSqlDir's candidates) and, in reverse, to recover a
 *  tree's root FROM an already-resolved sql dir (treeRootFromSqlDir). Keep the
 *  two in sync. */
const SQL_DIR_REL_SEGMENTS = ['libs', 'papercusp', 'libs', 'db', 'sql'];

/** Recover the containing tree's root from an on-disk sql dir found via
 *  resolveSqlDir() — the inverse of `path.resolve(baseDir, 'libs/papercusp/libs/db/sql')`.
 *  No git/env lookup needed: we already know the exact relative offset. */
function treeRootFromSqlDir(sqlDir: string): string {
  return path.resolve(sqlDir, ...SQL_DIR_REL_SEGMENTS.map(() => '..'));
}

/**
 * WI-6037: resolve the DEPLOYED (release checkout) tree's sql dir, independent
 * of which tree THIS process happens to be running from. `:3070` (green) and
 * `:3170` (staging) are sibling git worktrees under the same parent workspace
 * dir — the staging tree is legitimately AHEAD (new migration files land there
 * first, before a deploy). Comparing missing-on-disk migrations against the
 * DEPLOYED tree (rather than whichever tree is asking) distinguishes "normal
 * staging-ahead-of-release noise" (self-healing on the next deploy) from a
 * genuine unapplied migration in the tree actually serving the shared DB.
 *
 * Returns null when the deployed tree can't be resolved (no sibling
 * `papercup-release` checkout, e.g. a packaged install, CI, or a dev box with
 * no release checkout at all) — callers must treat null as "can't classify",
 * not as "nothing missing".
 */
export function resolveDeployedSqlDir(currentSqlDir: string | null): string | null {
  if (!currentSqlDir) return null;
  const treeRoot = treeRootFromSqlDir(currentSqlDir);
  const parent = path.dirname(treeRoot);
  const releaseRoot = process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release');
  const releaseSqlDir = path.join(releaseRoot, ...SQL_DIR_REL_SEGMENTS);
  return fs.existsSync(releaseSqlDir) ? releaseSqlDir : null;
}

/**
 * Pure classifier: split `missing` (on-disk, unapplied) into what's genuinely
 * unapplied at the DEPLOYED tree (`missingDeployed` — the real hazard) versus
 * merely not-yet-deployed noise (`missingPendingDeploy` — present here, absent
 * from the deployed tree, self-healing on the next deploy). `deployedOnDisk`
 * null means the deployed tree couldn't be resolved: fail TOWARD reporting
 * (treat every missing file as deployed/critical) rather than silently
 * suppressing a hazard we simply couldn't classify.
 */
export function classifyMissingByDeployedTree(
  missing: string[],
  deployedOnDisk: string[] | null,
): { missingDeployed: string[]; missingPendingDeploy: string[] } {
  if (deployedOnDisk === null) {
    return { missingDeployed: missing, missingPendingDeploy: [] };
  }
  const deployedSet = new Set(deployedOnDisk);
  return {
    missingDeployed: missing.filter((f) => deployedSet.has(f)),
    missingPendingDeploy: missing.filter((f) => !deployedSet.has(f)),
  };
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
  /** WI-6037: the DEPLOYED (release checkout) tree's sql dir, resolved
   *  independent of which tree THIS process is running from. Null when it
   *  can't be resolved (no sibling `papercup-release` checkout). */
  deployedSqlDir: string | null;
  /** `missing` restricted to files that ALSO exist on disk in `deployedSqlDir`
   *  — i.e. genuinely unapplied at the tree actually serving the shared DB.
   *  Equal to the full `missing` when `deployedSqlDir` is null (fail toward
   *  reporting, never silently suppress an unclassifiable hazard). This is
   *  the field a CRITICAL alert should key on, not the raw `missing`. */
  missingDeployed: string[];
  /** `missing` minus `missingDeployed` — present on disk here, absent from the
   *  deployed tree: the NORMAL staging-ahead-of-release window. Always
   *  self-healing on the next deploy; never a runtime hazard on its own. */
  missingPendingDeploy: string[];
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

  const deployedSqlDir = resolveDeployedSqlDir(sqlDir);
  let deployedOnDisk: string[] | null = null;
  if (deployedSqlDir) {
    try {
      deployedOnDisk = fs.readdirSync(deployedSqlDir).filter(isRunnerMigration);
    } catch {
      deployedOnDisk = null; // unreadable → fail toward reporting, same as unresolved
    }
  }
  const { missingDeployed, missingPendingDeploy } = classifyMissingByDeployedTree(
    missing,
    deployedOnDisk,
  );

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
    deployedSqlDir,
    missingDeployed,
    missingPendingDeploy,
  };
}
