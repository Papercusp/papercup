#!/usr/bin/env node
/**
 * condition-rail-inventory.mjs — run the condition-rail inventory over the tracked tree
 * (superproject + submodules, untracked-but-not-ignored files included).
 * Plan `degradation-signals-on-condition-rail-2026-10-11`, P-001 (BAR R-4).
 *
 *   node scripts/condition-rail-inventory.mjs            # per-class / per-file summary
 *   node scripts/condition-rail-inventory.mjs --json     # every row with its disposition
 *   node scripts/condition-rail-inventory.mjs --check    # exit 1 if any bypass row is undispositioned
 *                                                        # or any disposition key is stale (D-006)
 *
 * The scanner lives in scripts/lib/condition-rail-inventory.mjs; dispositions in
 * scripts/lib/condition-rail-dispositions.mjs.
 */
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { inventory, CLASSES } from './lib/condition-rail-inventory.mjs';
import { DISPOSITIONS } from './lib/condition-rail-dispositions.mjs';
import { listFilesIncludingUntracked } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export function runInventory() {
  const listed = listFilesIncludingUntracked(ROOT);
  const files = Array.isArray(listed) ? listed : listed.files;
  return inventory({ root: ROOT, files, dispositions: DISPOSITIONS });
}

function main() {
  const res = runInventory();
  const args = process.argv.slice(2);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    const onRail = res.sites.length - res.rows.length;
    console.log(
      `condition-rail inventory: ${res.rows.length} bypass row(s) of ${res.sites.length} site(s) (${onRail} on the rail) in ${res.scanned} scanned file(s)`,
    );
    for (const c of CLASSES) console.log(`  ${c.padEnd(26)} ${res.byClass[c]}`);
    const clusters = new Map();
    for (const r of res.rows) {
      const k = r.key;
      const cur = clusters.get(k) ?? { n: 0, d: r.disposition, lines: [] };
      cur.n++;
      cur.lines.push(r.line);
      clusters.set(k, cur);
    }
    console.log('\nclusters (class|file  sites  disposition):');
    for (const [k, v] of clusters) {
      const d = v.d ? (v.d.disposition === 'migrate' ? `migrate ${v.d.item}` : 'not-applicable') : 'UNDISPOSITIONED';
      console.log(`  ${k}  ${v.n}  ${d}  L${v.lines.slice(0, 6).join(',')}`);
    }
    if (res.staleDispositions.length) console.log(`\nstale disposition keys (no live site): ${res.staleDispositions.join(', ')}`);
    console.log(`\nundispositioned sites: ${res.undispositioned}; unreadable files: ${res.unreadable}`);
  }
  if (args.includes('--check') && (res.undispositioned > 0 || res.staleDispositions.length > 0)) process.exit(1);
}

if (isCliEntry(import.meta.url)) main();
