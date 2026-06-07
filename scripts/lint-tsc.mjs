#!/usr/bin/env node
/**
 * lint:tsc — Check TypeScript type errors in operator-core against a baseline.
 *
 * Gates NEW type errors while allowing pre-existing baseline errors. Baseline
 * is stored in packages/operator-core/.tsc-baseline.json and captures the error
 * count at the time it was created. Future runs that exceed this count fail.
 *
 * Usage:
 *   npm run lint:tsc              # Check against baseline (fail if > baseline)
 *   npm run lint:tsc -- --update  # Update baseline to current error count
 *
 * Exit codes:
 *   0 — errors are at or below baseline (OK)
 *   1 — errors exceed baseline, or script error
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'packages/operator-core/.tsc-baseline.json');
const updateFlag = process.argv.includes('--update');

// Run tsc and capture output
let tscOutput = '';
try {
  tscOutput = execSync('npx tsc -p packages/operator-core/tsconfig.json --noEmit 2>&1', {
    cwd: ROOT,
    encoding: 'utf-8',
  });
} catch (e) {
  tscOutput = e.stdout || '';
}

// Count errors
const errorCount = (tscOutput.match(/error TS\d+/g) || []).length;

// Load baseline
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
} catch {
  console.error(`❌ Failed to read baseline file: ${baselineFile}`);
  process.exit(1);
}

const baselineCount = baseline.operatorCoreErrorCount ?? 0;

console.log(`TSC type errors in operator-core: ${errorCount} (baseline: ${baselineCount})`);

if (updateFlag) {
  baseline.operatorCoreErrorCount = errorCount;
  baseline.updatedAt = new Date().toISOString();
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`✓ Updated baseline to ${errorCount} errors`);
  process.exit(0);
}

if (errorCount > baselineCount) {
  const excess = errorCount - baselineCount;
  console.error(`❌ Type error count exceeded baseline by ${excess} error(s).`);
  console.error(`   Current: ${errorCount}, Baseline: ${baselineCount}`);
  console.error(`   To update the baseline: npm run lint:tsc -- --update`);
  process.exit(1);
}

console.log(`✓ Type error count is at or below baseline`);
process.exit(0);
