#!/usr/bin/env node
/**
 * check-shell-syntax.mjs — fail-loud guard for a syntactically BROKEN tracked
 * `.sh` script (EI-13192).
 *
 * A corrupted shell script — e.g. a concurrent shared-tree edit interleave
 * that duplicates/truncates lines mid-file — is a HARD `bash -n` parse
 * failure. This caught the ~475-duplicated-line corruption of
 * papercusp-desktop/bin/build-windows-on-vm.sh only after `git status` looked
 * clean and git-sync had already committed it (EI-13192).
 *
 *   node scripts/check-shell-syntax.mjs
 *
 * D-003 (git-sync-content-guard): the pure detector (a real `bash -n`, not a
 * regex) lives in ONE importable module shared by this CI lint and the
 * git-sync content guard — the two can never disagree. Run via `tsx`
 * (package.json `lint:shell-syntax`) so this .mjs can import the TS module.
 *
 * Scope: tracked `.sh`. Excludes _retired/, node_modules, dist.
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findShellSyntaxError } from '../packages/operator-core/lib/content-lint/shell-syntax';

export { findShellSyntaxError };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const isExcluded = (f) =>
  f.startsWith('_retired/') || f.includes('/_retired/') || f.includes('/node_modules/') || f.includes('/dist/');

function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!f.endsWith('.sh')) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    const hit = findShellSyntaxError(text);
    if (hit) offenders.push(`${f}:${hit.line ?? '?'}  ${hit.reason}`);
  }

  if (offenders.length === 0) {
    console.log('✓ every tracked .sh script parses cleanly (bash -n).');
    process.exit(0);
  }

  console.error('✗ syntactically BROKEN shell script(s) — a hard `bash -n` parse failure:\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See EI-13192.`);
  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
