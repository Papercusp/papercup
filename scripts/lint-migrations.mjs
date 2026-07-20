#!/usr/bin/env node
/**
 * lint:migrations — migration-file discipline (audit P-074, EI-170).
 *
 * Four checks over libs/papercusp/libs/db/sql/*.sql (the live dir only —
 * archive/ holds pre-baseline history):
 *
 *   1. DUPLICATE NNN — two files sharing a numeric prefix. The reservations
 *      ledger (db:next-migration) prevents races going forward, but a renumber
 *      mistake or an unreserved hand-pick can still collide (205/206 both
 *      carry renumber-after-collision histories).
 *   2. RAW TRANSACTION CONTROL — top-level `BEGIN;` / `COMMIT;` / `ROLLBACK;`
 *      / `START TRANSACTION;` outside dollar-quoted bodies. The migration
 *      runner wraps every file in BEGIN … <ddl> … <ledger INSERT> … COMMIT
 *      (embedded-postgres-server/src/migration-runner.js) — an inner COMMIT
 *      ends that transaction early, so the apply+record pair stops being
 *      atomic and a mid-file failure leaves the ledger lying. plpgsql bodies
 *      ($$ … BEGIN … END … $$) are fine and ignored. Enforced from
 *      ENFORCED_FROM like the reservation check: 51 already-applied legacy
 *      files (116–200) carry their own BEGIN/COMMIT from before the
 *      runner-wraps contract — they are ledgered history (editing them would
 *      break their recorded sha256) and are reported informationally only.
 *   3. UNGUARDED RENAME CONSTRAINT — a bare top-level `RENAME CONSTRAINT`.
 *      `ALTER TABLE IF EXISTS … RENAME CONSTRAINT` guards the TABLE, not the
 *      CONSTRAINT, so it throws 42704 whenever the constraint is absent — which
 *      is how migration 592 came to fail on EVERY database and break every
 *      fresh-DB integration test in the repo (WI-4547). It looks guarded, so
 *      review misses it; the guarded DO-block form passes. Enforced from
 *      ENFORCED_FROM (applied history is immutable and already survived).
 *   4. UNRESERVED NUMBER — every NNN ≥ ENFORCED_FROM must have a row in
 *      harness_shared.migration_reservations (i.e. was allocated via
 *      db:next-migration, not `ls | tail`). Skipped with a notice when PG is
 *      unreachable (CI without a database).
 *
 * Checks 1–3 are pure-filesystem and always run. Exit 1 on any violation.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = join(ROOT, 'libs/papercusp/libs/db/sql');

/**
 * Reservation discipline starts here. Originally 215 (2026-06 dispatch), but
 * this lint's own SCAN was never wired into an automated gate (EI-6843) — only
 * a manual `npm run lint:migrations` invoked it, which nobody ran — so real
 * violations (3 duplicate-NNN pairs, 41 raw-tx-control files, ~75 unreserved
 * numbers) accumulated PAST 215 ungated for months, all already applied and
 * ledgered (immutable — editing them now would break their recorded
 * checksums). Re-baselined to the current on-disk max (2026-07-04) so this
 * boundary reflects reality: everything through 493 is grandfathered as
 * already-tolerated legacy, and enforcement is now WIRED into the automated
 * suite (lint-migrations.test.ts's "real sql/ directory" describe block, which
 * `test:affected`/the green-checkpoint gate runs on every candidate) so a
 * FUTURE violation is caught immediately instead of silently repeating this
 * exact gap. Bump this again only when deliberately re-grandfathering more
 * historical debt — never to silence a genuinely NEW violation. */
export const ENFORCED_FROM = 494;

/**
 * Strip dollar-quoted bodies ($$…$$ / $tag$…$tag$), quoted strings, and
 * comments so only top-level SQL remains for transaction-control detection.
 */
export function stripSqlBodies(sqlText) {
  const s = String(sqlText);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('--', i)) {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    const dq = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
    if (dq) {
      const tag = dq[0];
      const end = s.indexOf(tag, i + tag.length);
      i = end === -1 ? s.length : end + tag.length;
      out += ' ';
      continue;
    }
    if (s[i] === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; }
        if (s[j] === "'") break;
        j++;
      }
      i = j + 1;
      out += ' ';
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/** Top-level transaction-control statements found in a migration file. */
export function findRawTxControl(sqlText) {
  const stripped = stripSqlBodies(sqlText);
  const hits = [];
  const re = /^\s*(BEGIN\s*;|BEGIN\s+(?:TRANSACTION|WORK)\b|COMMIT\b|ROLLBACK\b|START\s+TRANSACTION\b)/gim;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    hits.push(m[1].trim().replace(/\s+/g, ' '));
  }
  return hits;
}

/**
 * Top-level `RENAME CONSTRAINT` statements — the 42704 footgun (WI-4547).
 *
 * `ALTER TABLE IF EXISTS t RENAME CONSTRAINT x TO y` READS as guarded and is NOT:
 * `IF EXISTS` covers the TABLE, not the CONSTRAINT. If the table exists but `x`
 * does not, Postgres still throws 42704 and aborts the whole migration.
 *
 * That is not hypothetical. Migration 592 (knowledge-packs rename) renamed five
 * constraints this way. One of them — `learning_pack_candidates_workspace_nonempty`
 * — had been destroyed long before by migration 377, which DROPPED the
 * `workspace_id` column (a CHECK constraint dies with its column). So it existed
 * on NO database, fresh or live: 592 failed deterministically EVERYWHERE, which
 * broke every fresh-DB integration test in the repo (createFreshPgDb applies the
 * full migration set) and would have failed the deploy's migration step too.
 *
 * The bug is invisible at review time precisely BECAUSE the statement looks
 * guarded, so a human check will keep missing it — hence a lint.
 *
 * The FIX SHAPE is a DO-block that renames only when the old name exists and the
 * new one does not (see 592). Because `stripSqlBodies` removes dollar-quoted
 * bodies, a rename inside a `DO $$ … $$` block is invisible here and passes,
 * while a bare top-level one is caught — which is exactly the intended contract.
 * `ALTER INDEX IF EXISTS … RENAME TO` is genuinely guarded (the IF EXISTS binds
 * to the index itself) and is correctly not flagged.
 */
export function findUnguardedConstraintRename(sqlText) {
  const stripped = stripSqlBodies(sqlText);
  const hits = [];
  const re = /\bRENAME\s+CONSTRAINT\s+("?[A-Za-z_][\w$]*"?)/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) hits.push(m[1]);
  return hits;
}

/**
 * The migration-631 class: a re-slug UPDATE that assigns a literal to
 * work_items.harness_slug WITHOUT a collision guard. On a shipped SEED that already
 * has a row at the target slug for the same feature_id, a straight UPDATE dupes
 * work_items_pkey and CRASH-LOOPS the packaged operator on first boot — the v0.0.12
 * bug that was found only AFTER a ~45-minute build (a big slice of that release's
 * 12h). Collision-safe = the file EITHER de-dups colliders first (a DELETE FROM
 * work_items) OR guards the UPDATE with NOT EXISTS; migrations 630/631 do the
 * dedup-DELETE. Returns the offending UPDATE snippet(s) ONLY when the file has a
 * reslug UPDATE and no guard (so a guarded reslug — or a file with none — is clean).
 */
export function findUnguardedReslug(sqlText) {
  // stripSqlBodies replaces string literals with a space, so we detect the RE-SLUG
  // structurally: an UPDATE on work_items whose SET clause ASSIGNS harness_slug
  // (not merely a harness_slug in the WHERE). Capture the SET clause up to
  // WHERE/RETURNING/; and require harness_slug to be assigned inside it.
  const stripped = stripSqlBodies(sqlText);
  const re =
    /UPDATE\s+[\w".]*\bwork_items\b\s+(?:AS\s+\w+\s+)?SET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;)/gi;
  const reslugs = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (/\bharness_slug\s*=/.test(m[1])) {
      reslugs.push(m[0].replace(/\s+/g, ' ').slice(0, 70));
    }
  }
  if (!reslugs.length) return [];
  // Collision-safe = de-dup colliders first (a DELETE FROM work_items) OR guard the
  // UPDATE with NOT EXISTS (mirrors migration 630/631's fix).
  const hasDedupDelete = /DELETE\s+FROM\s+[\w".]*\bwork_items\b/i.test(stripped);
  const guardedUpdate = /NOT\s+EXISTS/i.test(stripped);
  if (hasDedupDelete || guardedUpdate) return [];
  return reslugs;
}

/**
 * Flag a LITERAL default on a tenant-scoping column — the WI-5125 class.
 *
 * Seven consolidation migrations (116/118/119/120/170) each ended with:
 *
 *     ALTER VIEW <schema>.agent_chats ALTER COLUMN workspace_id SET DEFAULT 'default'
 *
 * under a comment reading "so writers that omit these on INSERT still pass
 * through". For `harness_slug` / `created_at` that reasoning holds — the view
 * knows its own slug and `now()` is always right. For `workspace_id` it does
 * NOT: the active workspace is only knowable IN-PROCESS (a request's
 * `x-papercusp-workspace` header → ALS, or the process pin), so a literal in
 * DDL is a GUESS that is wrong for every workspace except the one hardcoded.
 *
 * The consequence is not a loud failure but a silent one: a writer omitting the
 * column INSERTs successfully under the WRONG tenant. It shipped 181/181
 * mis-tenanted agent_chats rows, and the owner met it as a work-item Chat panel
 * that spun on "loading chat…" forever (the row existed; the workspace-scoped
 * read could never see it). A loud NOT NULL violation would have been caught in
 * minutes; the literal default turned it into weeks of invisible corruption.
 *
 * Scans RAW text, deliberately UNLIKE its siblings: these ALTERs live inside the
 * per-schema `DO $$ … $$` loop that `stripSqlBodies` removes, so a stripped scan
 * would see nothing and pass — the exact false-green this lint exists to prevent.
 *
 * The FIX SHAPE is to drop the literal and let the writer stamp the column
 * explicitly (`activeWorkspaceId()`), with `fill_workspace_id_from_projects()`
 * as a derive-net. A default that DERIVES — `current_setting(...)`, a function
 * call — is fine and is not flagged; only a quoted literal is.
 */
export function findLiteralTenantDefault(sqlText) {
  const hits = [];
  // Strip COMMENTS ONLY — not dollar-quoted bodies (see the note above: the real
  // ALTERs live inside a DO $$ … $$ loop). Without this, a migration that
  // DOCUMENTS the trap by quoting the offending DDL — as 616, its own fix, does —
  // gets flagged for the words in its comment. A lint that fires on the fix for
  // the bug it detects is a lint people delete.
  sqlText = sqlText.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // ALTER [VIEW|TABLE] <rel> ALTER [COLUMN] <tenant-col> SET DEFAULT '<literal>'
  const re =
    /ALTER\s+(?:VIEW|TABLE)\s+[^\n;]*?\bALTER\s+(?:COLUMN\s+)?["']?(workspace_id|hive_slug|tenant_id)["']?\s+SET\s+DEFAULT\s+('(?:[^']|'')*'|%L)/gi;
  let m;
  while ((m = re.exec(sqlText)) !== null) hits.push({ column: m[1], value: m[2] });
  return hits;
}

/**
 * Group migration filenames by numeric prefix; return duplicate groups whose
 * number is ≥ `enforcedFrom` (default ENFORCED_FROM). A duplicate BELOW that
 * line is pre-existing, already-applied, ledgered history — the runner keys
 * applied migrations by full FILENAME (not just the numeric prefix), so a
 * historical same-number pair with distinct names never actually collided at
 * runtime; it's a human-ambiguity smell, not a live defect, and renaming an
 * already-applied file now would break its recorded checksum. Grandfathering
 * mirrors the same enforcedFrom boundary the tx-control + reservation checks
 * already use (EI-6843: the boundary must track reality, not just intent — it
 * was stale for years while this lint went unrun, letting real duplicates
 * accumulate ungated; see ENFORCED_FROM's own history note).
 */
export function duplicateNumberGroups(filenames, enforcedFrom = ENFORCED_FROM) {
  const byNum = new Map();
  for (const f of filenames) {
    const m = /^(\d+)-/.exec(f);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(f);
  }
  return [...byNum.entries()]
    .filter(([num, files]) => files.length > 1 && num >= enforcedFrom)
    .map(([num, files]) => ({ num, files: files.sort() }));
}

/** NNN ≥ enforcedFrom present on disk but absent from the reservations set. */
export function unreservedNumbers(fileNums, reservedNums, enforcedFrom = ENFORCED_FROM) {
  return fileNums.filter((n) => n >= enforcedFrom && !reservedNums.has(n)).sort((a, b) => a - b);
}

async function fetchReservedNums() {
  // env → embedded-pg discovery file → native :5432 dev fallback (the same
  // order as operator-core's getHarnessAdminUrl).
  let url = process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL || process.env.PAPERCUSP_PG_URL;
  if (!url) {
    try {
      const os = await import('node:os');
      const raw = readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.host && parsed?.port && parsed.user && parsed.password) {
        url = `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/papercusp`;
      }
    } catch { /* no discovery file */ }
  }
  if (!url) url = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT num FROM harness_shared.migration_reservations`;
    return new Set(rows.map((r) => Number(r.num)));
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function main() {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
  let failed = false;

  // 1. duplicate numeric prefixes
  const dups = duplicateNumberGroups(files);
  if (dups.length) {
    failed = true;
    console.error('✗ duplicate migration numbers (renumber via db:next-migration):');
    for (const { num, files: group } of dups) console.error(`   ${num}: ${group.join(' · ')}`);
  }

  // 2. raw top-level transaction control (enforced ≥ ENFORCED_FROM;
  //    pre-contract applied files are grandfathered, reported as a count)
  let grandfathered = 0;
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
    const hits = findRawTxControl(readFileSync(join(SQL_DIR, f), 'utf8'));
    if (!hits.length) continue;
    if (num >= ENFORCED_FROM) {
      failed = true;
      console.error(`✗ ${f}: top-level transaction control (${hits.join(', ')}) — the runner provides the transaction; remove it`);
    } else {
      grandfathered++;
    }
  }
  if (grandfathered) {
    console.log(`· ${grandfathered} pre-${ENFORCED_FROM} applied file(s) carry legacy BEGIN/COMMIT — grandfathered (ledgered history, do not edit)`);
  }

  // 3. unguarded RENAME CONSTRAINT (the 42704 footgun — WI-4547)
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
    if (num < ENFORCED_FROM) continue; // applied history: immutable, and it already survived
    const hits = findUnguardedConstraintRename(readFileSync(join(SQL_DIR, f), 'utf8'));
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: bare RENAME CONSTRAINT (${hits.join(', ')}) — \`ALTER TABLE IF EXISTS\` guards the TABLE, not the CONSTRAINT, so this throws 42704 and aborts the migration when the constraint is absent (e.g. an earlier migration dropped its column). Wrap it in a DO block that renames only if the old name exists and the new one does not — see 592-knowledge-packs-rename.sql.`,
    );
  }

  // 4. literal default on a tenant-scoping column (the WI-5125 class)
  //
  // Grandfathered below ENFORCED_FROM for the same reason as the rename check:
  // 116/118/119/120/170 still carry this DDL, they are already applied, and the
  // runner verifies each applied file by sha256 — editing one now would break its
  // recorded checksum. Migration 616 already corrected their EFFECT on live
  // databases (drops the literals, attaches the derive-trigger); this lint stops a
  // NEW migration from re-introducing the trap.
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
    if (num < ENFORCED_FROM) continue;
    const hits = findLiteralTenantDefault(readFileSync(join(SQL_DIR, f), 'utf8'));
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: literal DEFAULT on a tenant-scoping column (${hits
        .map((h) => `${h.column} SET DEFAULT ${h.value}`)
        .join(', ')}) — the active workspace is only knowable IN-PROCESS (request header → ALS, or the process pin), so a literal here is a GUESS that silently files rows under the WRONG tenant while the INSERT still reports success. This shipped 181 mis-tenanted agent_chats rows and surfaced as a chat panel spinning forever (WI-5125). Drop the default and stamp the column explicitly in the writer (activeWorkspaceId()); a derive-net belongs in a BEFORE INSERT trigger (harness_shared.fill_workspace_id_from_projects) — see 616-workspace-stamp-consolidated-views.sql and /internal/docs/agent-insights/consolidated-view-literal-workspace-default.`,
    );
  }

  // 5. unguarded work_items harness_slug re-slug (the migration-631 crash-loop class)
  for (const f of files) {
    const num = Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10);
    if (num < ENFORCED_FROM) continue; // applied history: immutable, already ran
    const hits = findUnguardedReslug(readFileSync(join(SQL_DIR, f), 'utf8'));
    if (!hits.length) continue;
    failed = true;
    console.error(
      `✗ ${f}: work_items.harness_slug re-slug UPDATE with no collision guard (${hits.join(' · ')}) — on a shipped seed that already has a row at the target slug for the same feature_id this dupes work_items_pkey and CRASH-LOOPS the packaged operator on first boot (the v0.0.12 migration-631 bug, caught only after a ~45-min build). De-dup colliders first with a DELETE FROM harness_shared.work_items (mirror 630/631), or guard the UPDATE with "AND NOT EXISTS (SELECT 1 … row already at the target slug …)".`,
    );
  }

  // 6. unreserved numbers (PG optional)
  const fileNums = files
    .map((f) => /^(\d+)-/.exec(f)?.[1])
    .filter(Boolean)
    .map((n) => Number.parseInt(n, 10));
  try {
    const reserved = await fetchReservedNums();
    const unreserved = unreservedNumbers(fileNums, reserved);
    if (unreserved.length) {
      failed = true;
      console.error(`✗ migration number(s) ≥${ENFORCED_FROM} on disk without a reservation row (use db:next-migration): ${unreserved.join(', ')}`);
    }
  } catch (e) {
    console.log(`· reservation check skipped (PG unreachable: ${e?.code ?? e?.message ?? e})`);
  }

  if (failed) process.exit(1);
  console.log(`✓ lint:migrations — ${files.length} files clean (dup-NNN, raw BEGIN/COMMIT, RENAME CONSTRAINT, tenant DEFAULT, work_items reslug guard, reservations≥${ENFORCED_FROM})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
