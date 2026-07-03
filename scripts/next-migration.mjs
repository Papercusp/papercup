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
 * On success prints the reserved number + the canonical path to write the file:
 *   libs/papercusp/libs/db/sql/<NNN>-<slug>.sql   (NOT the gitignored sidecar mirror)
 * It auto-applies on the next operator restart (boot auto-apply).
 *
 * Exits non-zero (without reserving) when PG is unreachable — a number handed out
 * without a ledger row would re-introduce the very race this prevents.
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

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
      const filename = `${String(next).padStart(3, '0')}-${slug}.sql`;
      if (!args.dryRun) {
        await tx`
          INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent)
          VALUES (${next}, ${filename}, ${reservedBy}, ${args.intent ?? null})`;
      }
      return { next, filename };
    });
    const path = `${CANONICAL_DIR}/${allocated.filename}`;
    console.log(
      JSON.stringify(
        {
          ok: true,
          number: allocated.next,
          reserved: !args.dryRun,
          filename: allocated.filename,
          path,
          reserved_by: reservedBy,
          note: args.dryRun
            ? 'DRY RUN — nothing reserved. Re-run without --dry-run to claim this number.'
            : `Reserved. Write the migration at ${path} (NOT the sidecar mirror); it auto-applies on the next operator restart.`,
        },
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

await main();
