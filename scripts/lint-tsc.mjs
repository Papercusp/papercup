#!/usr/bin/env node
/**
 * lint:tsc — Check TypeScript type errors in operator-core against a baseline.
 *
 * Gates NEW type errors while allowing pre-existing baseline errors, with two
 * hard rules (audit P-073, EI-104 — a frozen 475-error baseline must not
 * neutralize strictness):
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only. When the current count
 *      is BELOW the baseline, `--update` tightens the baseline to the new count —
 *      improvements lock in and can't silently regress; raising it is a deliberate
 *      human act (edit the JSON with a justification). A BARE run (CI / a peer's
 *      `npm run lint:tsc`) only CHECKS — it never rewrites the baseline file.
 *      WHY (2026-07-03): in this multi-agent shared tree the operator-core error
 *      count SHUFFLES ±1 as peers edit the type-graph concurrently (see the
 *      .tsc-baseline.json note). Auto-ratcheting on EVERY bare run locked in a
 *      transient low, then the next run where the transient reappeared false-RED
 *      the gate for the whole fleet (burned su-4f4f5 / su-5587d / su-01386
 *      repeatedly). Gating strictness is unchanged — a bare run still HARD-FAILS
 *      when the count exceeds baseline; only the auto-lock-in of an improvement now
 *      requires the deliberate `--update`.
 *   2. SYNTAX HARD-FAIL: any file with a parse-level error (TS1xxx — the file
 *      fails to compile at all, so tsc under-reports everything behind it)
 *      fails the lint regardless of the count vs baseline.
 *
 * Usage:
 *   npm run lint:tsc              # Check against baseline
 *   npm run lint:tsc -- --update  # Explicitly lower the baseline (never raises)
 *
 * Exit codes:
 *   0 — OK (at baseline, or ratcheted down)
 *   1 — new errors above baseline, syntax-broken files, or script error
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'packages/operator-core/.tsc-baseline.json');

/** Parse tsc output into { file, code } entries (file null when unattributable). */
export function parseTscErrors(tscOutput) {
  const errors = [];
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+):/);
    if (m) {
      errors.push({ file: m[1], code: m[4] });
      continue;
    }
    const bare = line.match(/error (TS\d+):/);
    if (bare) errors.push({ file: null, code: bare[1] });
  }
  return errors;
}

/** Files carrying parse-level (TS1xxx) errors — they fail to compile at all. */
export function syntaxBrokenFiles(errors) {
  const files = new Set();
  for (const e of errors) {
    if (/^TS1\d{3}$/.test(e.code)) files.add(e.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/**
 * Pure gate decision — the ONE place the --update-only ratchet policy lives, so it
 * is unit-testable (EI-104). Below baseline, the baseline LOWERS only on `--update`
 * (`ok-ratchet`); a bare run is check-only (`ok-below`) and main() never writes for
 * it. Auto-ratcheting a bare run locks in the min of this tree's ±1-flapping count
 * and then false-reds the whole fleet when it shuffles back up.
 * @returns {{ verdict: 'fail-syntax'|'fail-exceeds'|'ok-ratchet'|'ok-below'|'ok', newBaseline?: number, belowBy?: number, brokenFiles?: string[] }}
 */
export function decide({ errorCount, baselineCount, brokenFiles, updateFlag = false }) {
  if (brokenFiles.length > 0) return { verdict: 'fail-syntax', brokenFiles };
  if (errorCount > baselineCount) return { verdict: 'fail-exceeds' };
  if (errorCount < baselineCount) {
    return updateFlag
      ? { verdict: 'ok-ratchet', newBaseline: errorCount }
      : { verdict: 'ok-below', belowBy: baselineCount - errorCount };
  }
  return { verdict: 'ok' };
}

function main() {
  const updateFlag = process.argv.includes('--update');

  let tscOutput = '';
  let tscThrew = false;
  try {
    tscOutput = execSync('npx tsc -p packages/operator-core/tsconfig.json --noEmit 2>&1', {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    tscThrew = true;
    tscOutput = e.stdout || '';
  }
  if (tscThrew && !tscOutput) {
    // tsc itself failed to run (no diagnostics at all) — never treat that as
    // zero errors, it would auto-ratchet the baseline to 0 and mask everything.
    console.error('❌ tsc produced no output — toolchain failure, not a clean run.');
    process.exit(1);
  }

  const errors = parseTscErrors(tscOutput);
  const errorCount = errors.length;
  const brokenFiles = syntaxBrokenFiles(errors);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  } catch {
    console.error(`❌ Failed to read baseline file: ${baselineFile}`);
    process.exit(1);
  }
  const baselineCount = baseline.operatorCoreErrorCount ?? 0;

  console.log(`TSC type errors in operator-core: ${errorCount} (baseline: ${baselineCount})`);

  const writeBaseline = (count, why) => {
    baseline.operatorCoreErrorCount = count;
    baseline.updatedAt = new Date().toISOString();
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✓ ${why}: baseline → ${count} errors`);
  };

  const result = decide({ errorCount, baselineCount, brokenFiles, updateFlag });

  switch (result.verdict) {
    case 'fail-syntax':
      console.error(`❌ ${result.brokenFiles.length} file(s) fail to COMPILE (TS1xxx parse errors) — hard fail regardless of baseline:`);
      for (const f of result.brokenFiles) console.error(`   - ${f}`);
      process.exit(1);
      break;
    case 'fail-exceeds':
      console.error(`❌ Type error count exceeded baseline by ${errorCount - baselineCount} error(s).`);
      console.error(`   Current: ${errorCount}, Baseline: ${baselineCount}`);
      console.error(`   Fix the new errors — the baseline only ratchets DOWN (raising it is a hand-edit of ${baselineFile} with justification).`);
      process.exit(1);
      break;
    case 'ok-ratchet':
      // Ratchet-only-DOWN, but only on an explicit `--update` (a deliberate act) — NOT
      // on a bare/CI run. In this multi-agent shared tree the count shuffles ±1 as peers
      // edit the type-graph concurrently; auto-ratcheting on every bare run locked in a
      // transient low, then false-RED the whole fleet on the next run where it reappeared
      // (2026-07-03). A bare run now only CHECKS (pass at/below baseline); `--update` locks
      // a genuine, verified improvement in.
      if (updateFlag) {
        writeBaseline(result.newBaseline, 'Ratcheted down (--update)');
      } else {
        console.log(
          `✓ Below baseline (${errorCount} < ${baselineCount}) — run \`npm run lint:tsc -- --update\` to lock it in. ` +
            `Bare runs no longer auto-ratchet (the count shuffles ±1 under concurrent fleet edits; auto-ratchet false-red the gate — see .tsc-baseline.json note).`,
        );
      }
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: count equals baseline — nothing to lower.');
      console.log('✓ Type error count is at or below baseline');
      process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
