#!/usr/bin/env node
// lexicon-residual-count — the burndown metric for cup-lexicon-backend-zero-2026-07-11.
//
// Counts OLD-BRAND token occurrences across the repo and buckets them into:
//   (a) THE_HIVE pack file  — the ONE sanctioned home (owner: keep, flag-gated). Expected non-zero.
//   (b) frozen SQL history  — already-applied migrations are immutable; column renames land in
//                             NEW forward migrations, so old names persist in history irreducibly.
//   (c) ACTIONABLE          — everything else. THIS is the number we drive to 0.
//
// Old→new backend-id map: hive→pot queen→mug bee→cup sentinel→papercup overwatch→kettle
//   scout→blender comb→cupboard colony→fleet keeper→human cell→chunk waggle→signal.
//
// Usage: node scripts/lexicon-residual-count.mjs [--by-file] [--term <t>]
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

// Word-boundary, case-insensitive patterns. `cell` is intentionally omitted from the
// headline count (rampant English/UI false positives — spreadsheet/table cells); tracked
// manually. `sentinel` carries a known FP ("sentinel value" CS term) — surfaced, not hidden.
const TERMS = ['hive', 'queen', 'bees?', 'sentinel', 'comb', 'colony', 'keeper', 'waggle'];

// Excluded everywhere: vendored, build output, VCS, agent scratch, generated projections.
const EXCL = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.materialized', '_retired',
  '.papercusp', 'scratchpad', 'papercup-release',
].flatMap((d) => ['-g', `!**/${d}/**`]).concat(['-g', '!*.map', '-g', '!*-lock.json']);

// (a) the sanctioned pack home.
const PACK_FILE = 'libs/generic/lexicon/src/packs.ts';
// (b) frozen migration history — already-applied SQL. Column renames go in NEW migrations.
const SQL_GLOB = 'libs/papercusp/libs/db/sql';

function rgCount(pattern, extraArgs = []) {
  try {
    const out = execSync(
      `rg -c --no-filename -i ${EXCL.map((a) => `'${a}'`).join(' ')} ${extraArgs.join(' ')} '\\b(${pattern})\\b'`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    return out.trim().split('\n').filter(Boolean).reduce((s, n) => s + Number(n), 0);
  } catch {
    return 0; // rg exits 1 on no matches
  }
}

const args = process.argv.slice(2);
if (args.includes('--by-file')) {
  const term = (args[args.indexOf('--term') + 1] || TERMS.join('|'));
  const cmd = `rg -c -i ${EXCL.map((a) => `'${a}'`).join(' ')} -g '!${PACK_FILE}' -g '!${SQL_GLOB}/**' '\\b(${term})\\b' | sort -t: -k2 -rn | head -40`;
  console.log(execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }));
  process.exit(0);
}

console.log('cup-lexicon backend-zero — residual burndown\n');
let actionableTotal = 0;
const rows = [];
for (const t of TERMS) {
  const all = rgCount(t);
  const pack = rgCount(t, [`-g '${PACK_FILE}'`]);
  const sql = rgCount(t, [`-g '${SQL_GLOB}/**'`]);
  const actionable = all - pack - sql;
  actionableTotal += actionable;
  rows.push({ term: t.replace('s?', '(s)'), all, pack, sql, actionable });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('term', 12)}${pad('actionable', 12)}${pad('pack(keep)', 12)}${pad('sql(frozen)', 12)}total`);
for (const r of rows) console.log(`${pad(r.term, 12)}${pad(r.actionable, 12)}${pad(r.pack, 12)}${pad(r.sql, 12)}${r.all}`);
console.log(`\n>>> ACTIONABLE RESIDUALS (drive to 0): ${actionableTotal}`);
