#!/usr/bin/env node
/**
 * lint:migration-forward-compat
 *
 * A migration runs against the SHARED database immediately. The operator serving
 * :3070 runs from the RELEASE checkout, which lags staging by a full
 * commit -> green-checkpoint -> deploy cycle. So for the whole length of that
 * cycle the database is NEWER than the code querying it.
 *
 * That means destructive DDL is not "a schema change" -- it is a live change to
 * the contract that the CURRENTLY DEPLOYED binary is still relying on.
 *
 * WHY THIS EXISTS (EI-18797473716313783, 2026-07-27):
 *   migration 689-agent-facts-append-versioning.sql did, in ONE file:
 *     CREATE UNIQUE INDEX agent_facts_identity_current ... WHERE superseded_at IS NULL;
 *     DROP INDEX IF EXISTS harness_shared.agent_facts_identity;   <-- the arbiter
 *   The deployed release's facts:assert used
 *     ON CONFLICT (workspace_id, scope, coalesce(scope_ref,''), key, coalesce(source_hive,''))
 *   with no WHERE predicate. Postgres cannot infer a PARTIAL unique index unless the
 *   conflict target repeats the predicate, so once the old non-partial index was
 *   dropped there was no inferable arbiter at all and EVERY facts:assert call failed
 *   fleet-wide with:
 *     "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 *   The migration applied at 08:37:31Z. The code fix was written ~2h41m LATER, and the
 *   outage was not noticed for ~3 HOURS -- during which the mandated durable-conclusion
 *   path for every looping agent was silently failing.
 *
 * THE DISCIPLINE (expand / contract):
 *   Split it across two migrations. EXPAND first (add the new index/column, ship and
 *   deploy the code that uses it), CONTRACT later (drop the old one, once no deployed
 *   release still references it). Never both in one file.
 *
 * If a destructive statement genuinely IS safe for the deployed release, say so in the
 * migration with an explicit acknowledgment line:
 *
 *   -- FORWARD-COMPAT: <why the currently-deployed release does not use this>
 *
 * That is deliberately a human sentence, not a flag: the point is to force the author
 * to check the release checkout before dropping something out from under it.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '..', 'libs', 'papercusp', 'libs', 'db', 'sql');

/**
 * Migrations are immutable once applied, so historical files can never be fixed.
 * Enforce from the first migration authored after this guard landed.
 */
const ENFORCE_FROM = 693;

const ACK_MARKER = /^[ \t]*--[ \t]*FORWARD-COMPAT:[ \t]*\S/im;

const RULES = [
  {
    id: 'drop-index',
    re: /\bDROP\s+INDEX\b/i,
    why: 'drops an index the deployed release may be relying on as an ON CONFLICT arbiter (this is exactly EI-18797473716313783)',
  },
  {
    id: 'drop-constraint',
    re: /\bDROP\s+CONSTRAINT\b/i,
    why: 'removes a constraint the deployed release may depend on for upsert/validation behavior',
  },
  {
    id: 'drop-column',
    re: /\bDROP\s+COLUMN\b/i,
    why: 'removes a column the deployed release almost certainly still SELECTs or INSERTs',
  },
  {
    id: 'drop-table',
    re: /\bDROP\s+TABLE\b/i,
    why: 'removes a relation the deployed release may still query',
  },
  {
    id: 'rename',
    re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    why: 'a rename is a drop plus an add as far as the deployed release is concerned',
  },
  {
    id: 'narrowing-unique-index',
    re: /\bCREATE\s+UNIQUE\s+INDEX\b[\s\S]*?\bWHERE\b/i,
    why: 'a PARTIAL unique index cannot serve an un-predicated ON CONFLICT -- deployed code that relied on a non-partial index of the same columns will fail to infer an arbiter',
  },
  {
    id: 'set-not-null',
    re: /\bALTER\s+COLUMN\b[\s\S]{0,120}?\bSET\s+NOT\s+NULL\b/i,
    why: 'the deployed release may still INSERT rows without this column',
  },
];

/** Strip SQL comments so prose describing DDL is never mistaken for DDL. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/--[^\n]*/g, '\n');
}

function violationsFor(sqlText) {
  const code = stripComments(sqlText);
  return RULES.filter((r) => r.re.test(code));
}

/**
 * NON-VACUITY SELF-TEST (D-076 section 4).
 *
 * A structural scan that silently matches nothing reports GREEN and is worse than no
 * gate at all. Before trusting a clean run we prove the detector still fires on a
 * known-positive and stays quiet on a known-negative. These fixtures are embedded so
 * the self-test cannot rot when files move on disk.
 */
function selfTest() {
  const positive = `
    CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
      ON harness_shared.agent_facts (workspace_id, scope, key)
      WHERE superseded_at IS NULL;
    DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
  `;
  const negative = `
    -- This migration only talks about how we used to DROP INDEX things.
    -- It also mentions DROP COLUMN and RENAME TO purely in prose.
    CREATE TABLE IF NOT EXISTS harness_shared.some_new_table (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS some_new_table_created ON harness_shared.some_new_table (created_at);
  `;

  const failures = [];

  const posHits = violationsFor(positive).map((r) => r.id);
  if (!posHits.includes('drop-index')) {
    failures.push('detector did NOT fire on a known-positive DROP INDEX fixture');
  }
  if (!posHits.includes('narrowing-unique-index')) {
    failures.push('detector did NOT fire on a known-positive partial-unique-index fixture');
  }

  const negHits = violationsFor(negative).map((r) => r.id);
  if (negHits.length > 0) {
    failures.push(
      `detector fired on a known-negative fixture (comment text mistaken for DDL): ${negHits.join(', ')}`,
    );
  }

  if (!ACK_MARKER.test('-- FORWARD-COMPAT: the deployed release never reads this column')) {
    failures.push('acknowledgment marker did not match a valid FORWARD-COMPAT line');
  }
  if (ACK_MARKER.test('-- FORWARD-COMPAT:')) {
    failures.push('acknowledgment marker matched an EMPTY FORWARD-COMPAT line (must require a reason)');
  }

  return failures;
}

function main() {
  const selfTestFailures = selfTest();
  if (selfTestFailures.length > 0) {
    console.error('check-migration-forward-compat: SELF-TEST FAILED -- the checker itself is broken.');
    console.error('Refusing to report green, because a broken detector reports green on everything.\n');
    for (const f of selfTestFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  if (!existsSync(SQL_DIR)) {
    console.error(`check-migration-forward-compat: migrations dir not found: ${SQL_DIR}`);
    console.error('Refusing to report green on a scan that found nothing to scan.');
    process.exit(1);
  }

  const all = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
  if (all.length === 0) {
    console.error(`check-migration-forward-compat: zero .sql files in ${SQL_DIR}`);
    console.error('Refusing to report green on an empty scan.');
    process.exit(1);
  }

  const inScope = all
    .map((f) => ({ file: f, num: Number.parseInt(f.slice(0, f.indexOf('-')), 10) }))
    .filter((e) => Number.isFinite(e.num) && e.num >= ENFORCE_FROM)
    .sort((a, b) => a.num - b.num);

  const offenders = [];
  for (const { file } of inScope) {
    const text = readFileSync(join(SQL_DIR, file), 'utf8');
    const hits = violationsFor(text);
    if (hits.length === 0) continue;
    if (ACK_MARKER.test(text)) continue;
    offenders.push({ file, hits });
  }

  if (offenders.length > 0) {
    console.error('Forward-incompatible migration(s): destructive DDL with no FORWARD-COMPAT acknowledgment.\n');
    console.error('The database migrates NOW; :3070 keeps running the older release checkout until the');
    console.error('next commit -> green-checkpoint -> deploy cycle finishes. Destructive DDL therefore');
    console.error('breaks code that is still live.\n');
    for (const { file, hits } of offenders) {
      console.error(`  ${file}`);
      for (const h of hits) console.error(`      [${h.id}] ${h.why}`);
    }
    console.error('\nFix by splitting into expand/contract:');
    console.error('  1. EXPAND  - add the new index/column; ship and DEPLOY the code that uses it.');
    console.error('  2. CONTRACT - a LATER migration drops the old one, once no deployed release uses it.');
    console.error('\nOr, if the deployed release genuinely does not touch it, record why in the migration:');
    console.error('  -- FORWARD-COMPAT: <why the currently-deployed release does not use this>');
    console.error('\nBackground: EI-18797473716313783 (migration 689 dropped an ON CONFLICT arbiter and');
    console.error('broke facts:assert fleet-wide for ~3 hours).');
    process.exit(1);
  }

  console.log(
    `check-migration-forward-compat: OK (${inScope.length} migration(s) at or after ${ENFORCE_FROM} checked, ${all.length} total on disk)`,
  );
}

main();
