#!/usr/bin/env node
/**
 * lint:migrations — migration-file discipline (audit P-074, EI-170).
 *
 * Three checks over libs/papercusp/libs/db/sql/*.sql (the live dir only —
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
 *   3. UNRESERVED NUMBER — every NNN ≥ ENFORCED_FROM must have a row in
 *      harness_shared.migration_reservations (i.e. was allocated via
 *      db:next-migration, not `ls | tail`). Skipped with a notice when PG is
 *      unreachable (CI without a database).
 *
 * Checks 1–2 are pure-filesystem and always run. Exit 1 on any violation.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = join(ROOT, 'libs/papercusp/libs/db/sql');

/** Reservation discipline starts here (2026-06 dispatch: migrations ≥215 go
 *  through db:next-migration). Earlier numbers predate the ledger. */
export const ENFORCED_FROM = 215;

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

/** Group migration filenames by numeric prefix; return duplicate groups. */
export function duplicateNumberGroups(filenames) {
  const byNum = new Map();
  for (const f of filenames) {
    const m = /^(\d+)-/.exec(f);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(f);
  }
  return [...byNum.entries()]
    .filter(([, files]) => files.length > 1)
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

  // 3. unreserved numbers (PG optional)
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
  console.log(`✓ lint:migrations — ${files.length} files clean (dup-NNN, raw BEGIN/COMMIT, reservations≥${ENFORCED_FROM})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
