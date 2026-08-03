#!/usr/bin/env node
/**
 * db:next-migration (CLI) — atomically reserve the next migration number so two
 * agents racing `ls | tail` never pick the same NNN (which, on the native :5432
 * box, silently applies only one colliding file and dark-starts the other).
 *
 * This mirrors the MCP agent-tool
 * `packages/operator-core/lib/agent-tools/db/next_migration.ts`, but as a plain
 * Node CLI so reservation works WITHOUT the harness MCP client (which is
 * periodically dropped — see agent-insights/migration-number-collisions-and-
 * reservation-dx). The shared contract is the LEDGER + advisory lock, not the
 * code, so the two can't functionally diverge.
 *
 * Allocation: under pg advisory lock 873135,
 *   next = GREATEST(max-on-disk across BOTH sql dirs, max-reserved, max-applied) + 1
 * recorded atomically in harness_shared.migration_reservations.
 *
 * Usage:
 *   node scripts/next-migration.mjs --name add-foo-index [--intent "what it does"] [--by label] [--dry-run]
 *   npm run db:next-migration -- --name add-foo-index --intent "..."
 *
 * On success prints the reserved number + a DRAFT path to write the file at:
 *   libs/papercusp/libs/db/sql/<NNN>-<slug>.sql.DRAFT   (NOT the gitignored sidecar mirror)
 * The `.DRAFT` suffix is deliberate (EI-19366138707071397): the migration
 * runner only ever applies files matching `*.sql` (see migration-runner.js /
 * migration-drift.ts's `isRunnerMigration`), so a `.DRAFT`-suffixed file is
 * INVISIBLE to boot auto-apply, db:migrate, and the green-checkpoint preflight
 * — exactly like the pre-existing `.PENDING-CODE-DEPLOY` idiom (see migration
 * 727). This closes the window where editing an unapplied migration on disk
 * (including a deliberate temporary both-ways guard-test mutation) races the
 * operator's boot-time auto-apply and can execute half-finished SQL against
 * the live DB. Write + iterate at the `.DRAFT` path; ARM it only once ready by
 * stripping the suffix (`mv <path>.DRAFT <path>`) — the printed `note` gives
 * the exact command.
 *
 * Exits non-zero (without reserving) when PG is unreachable — a number handed out
 * without a ledger row would re-introduce the very race this prevents.
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const ALLOC_ADVISORY_KEY = 873_135; // must match next_migration.ts

// The canonical dir is scanned + written; the sidecar dir is folded into the
// on-disk max only so a stray mirror file can't collide. Write the file to the
// canonical dir.
const CANONICAL_DIR = 'libs/papercusp/libs/db/sql';
const SCAN_DIRS = [CANONICAL_DIR, 'papercusp-desktop/src-tauri/sidecar/db-sql'];

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--intent') args.intent = argv[++i];
    else if (a === '--by') args.by = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function slugify(name) {
  return (
    String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'TODO-rename'
  );
}

function maxNumberOnDisk(dirs) {
  let max = 0;
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a missing dir (e.g. an uninitialized submodule) is fine.
    }
    for (const f of entries) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
  }
  return max;
}

/**
 * Pure — builds the JSON payload printed on success. Exported (and unit
 * tested, no DB required) so the `.DRAFT`-suffix contract (EI-19366138707071397)
 * can't silently regress: `path` must be the DRAFT write-target, `arm_path`
 * the eventual armed `.sql` name, and `arm_command` the exact rename between
 * them — see the module-level docstring for why the suffix matters.
 */
export function buildAllocationResult({ next, filename, reservedBy, dryRun, canonicalDir = CANONICAL_DIR }) {
  const armPath = `${canonicalDir}/${filename}`;
  const draftPath = `${armPath}.DRAFT`;
  return {
    ok: true,
    number: next,
    reserved: !dryRun,
    filename,
    path: draftPath,
    arm_path: armPath,
    arm_command: `mv ${draftPath} ${armPath}`,
    reserved_by: reservedBy,
    note: dryRun
      ? 'DRY RUN — nothing reserved. Re-run without --dry-run to claim this number.'
      : `Reserved. Write + iterate the migration at ${draftPath} (a ".DRAFT" suffix — NOT the sidecar mirror). The runner only ever applies files matching *.sql, so this draft is INVISIBLE to boot auto-apply / db:migrate / the green-checkpoint preflight while you edit it (including any deliberate temporary both-ways guard-test mutation). Once it's ready and tested, ARM it for auto-apply with: mv ${draftPath} ${armPath}`,
  };
}

function resolvePgUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const p = JSON.parse(readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8'));
    if (p?.host && p?.port && p.user && p.password) {
      return `postgresql://${p.user}:${p.password}@${p.host}:${p.port}/papercusp`;
    }
  } catch {
    /* no discovery file */
  }
  return 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/next-migration.mjs --name <slug> [--intent "..."] [--by <label>] [--dry-run]',
    );
    process.exit(0);
  }
  const slug = slugify(args.name);
  const reservedBy = args.by || process.env.USER || process.env.LOGNAME || 'cli';

  const postgres = (await import('postgres')).default;
  const sql = postgres(resolvePgUrl(), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });

  try {
    const allocated = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      // EI-6852: scan the filesystem max INSIDE the advisory lock, immediately
      // before the reservation insert — NOT before acquiring the lock. Reading
      // fsMax outside the lock left a TOCTOU window during which a concurrent
      // agent could write a higher-numbered NNN-*.sql to disk; the stale fsMax
      // then failed to fold it in and the CLI handed out an already-used
      // number. Mirrors the fix in next_migration.ts (the shared contract).
      const fsMax = maxNumberOnDisk(SCAN_DIRS);
      const rows = await tx`
        SELECT GREATEST(
                 ${fsMax},
                 COALESCE((SELECT MAX(num) FROM harness_shared.migration_reservations), 0),
                 COALESCE((SELECT MAX(substring(filename FROM '^([0-9]+)-')::int)
                             FROM harness_shared.schema_migrations
                            WHERE filename ~ '^[0-9]+-'), 0)
               ) + 1 AS next`;
      const next = Number(rows[0].next);
      // The RESERVED filename (recorded in the ledger, used by the fsMax/
      // unreservedNumbers checks) stays the eventual armed `.sql` name — only
      // the path we tell the caller to WRITE TO gets the `.DRAFT` suffix. The
      // reservation and the on-disk armed state are deliberately independent.
      const filename = `${String(next).padStart(3, '0')}-${slug}.sql`;
      if (!args.dryRun) {
        await tx`
          INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent)
          VALUES (${next}, ${filename}, ${reservedBy}, ${args.intent ?? null})`;
      }
      return { next, filename };
    });
    console.log(
      JSON.stringify(
        buildAllocationResult({
          next: allocated.next,
          filename: allocated.filename,
          reservedBy,
          dryRun: args.dryRun,
        }),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(
      `db:next-migration FAILED — could not reach the reservation ledger: ${e?.message ?? e}\n` +
        'Refusing to hand out an unreserved number (that re-introduces the race). ' +
        'Start the embedded PG / set DATABASE_URL and retry.',
    );
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

// Guard the CLI entry so a test can `import { buildAllocationResult } from
// './next-migration.mjs'` without triggering a live PG connection + argv
// parse as a side effect of the import.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMainModule) await main();
