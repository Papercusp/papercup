#!/usr/bin/env node
import { execSync } from 'node:child_process';

let ok = true;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (e) { ok = false; console.log(`  FAIL ${label} — ${e.message}`); }
}

console.log('papercup test-doctor\n');
check('docker CLI on PATH', () => execSync('docker --version', { stdio: 'pipe' }));
check('docker daemon reachable', () => execSync('docker ps', { stdio: 'pipe' }));
check('node >= 20', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`have ${process.versions.node}`);
});

console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
process.exit(ok ? 0 : 1);
