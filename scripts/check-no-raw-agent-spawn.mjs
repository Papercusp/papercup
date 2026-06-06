#!/usr/bin/env node
/**
 * check-no-raw-agent-spawn.mjs — fail-loud guard against NEW raw agent-CLI spawns
 * (unify-agent-spawn-chokepoint-2026-06-06, P-008 / D-001).
 *
 * Every agent spawn must go through the ONE chokepoint `spawnInvokeOnce`
 * (dbos/orchestrator-runner.ts) so it gets uniform admission + governor pacing +
 * the option of (class-gated) durability. A file that builds the agent-CLI command
 * itself (`buildInvokeOnce`) AND raw-`child_process.spawn`s it is a BYPASS — it
 * should call `spawnInvokeOnce` instead. This guard fails the build when a NEW such
 * bypass appears, so the unification doesn't silently erode back.
 *
 *   node scripts/check-no-raw-agent-spawn.mjs
 *
 * ALLOWLIST — the legitimate sites that build + spawn the agent CLI directly:
 *   • packages/operator-core/lib/dbos/orchestrator-runner.ts — IS the chokepoint
 *     (`spawnInvokeOnce` → `runChild`); everything else funnels through it.
 *
 * (The `/invoke` HTTP route at endpoint-route/routes/harness/spawn.ts WAS the last
 * remaining bypass; it now routes through `spawnInvokeOnce` with a per-call timeout
 * — P-008 — so the only build+spawn site left is the chokepoint itself.)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

const ALLOWLIST = new Set([
  'packages/operator-core/lib/dbos/orchestrator-runner.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts',
]);

const tracked = execSync('git ls-files', {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.endsWith('.test.ts') ||
  !/\.ts$/.test(f);

const offenders = [];
for (const f of tracked) {
  if (ALLOWLIST.has(f) || isExcluded(f)) continue;
  let text;
  try {
    text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('buildInvokeOnce')) continue;
  // The tell of a raw agent-CLI spawn: it builds the invoke-once command itself
  // (buildInvokeOnce) AND spawns a child process directly from node:child_process.
  const buildsAgentCmd = /\bbuildInvokeOnce\b/.test(text);
  const rawSpawns =
    /from\s+['"]node:child_process['"]/.test(text) && /\bspawn(Sync)?\s*\(/.test(text);
  if (buildsAgentCmd && rawSpawns) offenders.push(f);
}

if (offenders.length === 0) {
  console.log('✓ no new raw agent-CLI spawns — every agent spawn goes through spawnInvokeOnce (the chokepoint).');
  process.exit(0);
}

console.error('✗ NEW raw agent-CLI spawn(s) bypassing the spawnInvokeOnce chokepoint:');
console.error('  Call `spawnInvokeOnce(projectDir, role, extras, extraEnv)` instead of');
console.error('  `buildInvokeOnce(...)` + `child_process.spawn(...)` — the chokepoint applies admission');
console.error('  + governor pacing + (class-gated) durability uniformly.\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} bypass(es). See plan unify-agent-spawn-chokepoint-2026-06-06 (P-008 / D-001).`);
process.exit(1);
