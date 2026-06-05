#!/usr/bin/env node
// Parse a vitest run log into a structured red/green/skip summary.
// Usage: node triage.mjs <logfile>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const txt = readFileSync(file, 'utf8');
const lines = txt.split('\n');

const fileResults = []; // {status:'pass'|'fail'|'skip', file, counts}
const failedTests = []; // {file, name}

for (const line of lines) {
  // File-level result lines vitest prints: " ✓ path (N tests) 123ms" / " ❯ path (...)" / " × path" / " ↓ path (N | N skipped)"
  let m = line.match(/^\s*([✓❯×↓✗])\s+(\S+\.test\.ts)\s*(.*)$/);
  if (m) {
    const sym = m[1];
    const status = sym === '✓' ? 'pass' : sym === '↓' ? 'skip' : 'fail';
    fileResults.push({ status, file: m[2], rest: m[3] });
    continue;
  }
  // Individual failed test: vitest prints "   × test name  123ms" nested, or "FAIL  file > test"
  m = line.match(/^\s*(?:×|✗)\s+(.+?)(?:\s+\d+ms)?$/);
  if (m && !/\.test\.ts$/.test(m[1])) {
    failedTests.push(m[1].trim());
  }
}

// Final summary lines
const summaryFiles = (txt.match(/Test Files\s+.*$/m) || [])[0] || 'n/a';
const summaryTests = (txt.match(/^\s*Tests\s+.*$/m) || [])[0] || 'n/a';

const failedFiles = fileResults.filter((f) => f.status === 'fail');
const skipFiles = fileResults.filter((f) => f.status === 'skip');

console.log('==== ' + file + ' ====');
console.log('Test Files:', summaryFiles.trim());
console.log('Tests     :', summaryTests.trim());
console.log('file-result lines parsed:', fileResults.length, '(fail:', failedFiles.length, 'skip:', skipFiles.length, ')');
if (failedFiles.length) {
  console.log('\n--- FAILED FILES ---');
  for (const f of failedFiles) console.log('  FAIL', f.file, f.rest);
}
if (skipFiles.length) {
  console.log('\n--- SKIPPED FILES ---');
  for (const f of skipFiles) console.log('  SKIP', f.file, f.rest);
}
