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
 * The bypass-detection predicate (`isRawAgentSpawnBypass`) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-spawn-guard.test.ts) so the "fails on a new
 * raw spawn" property (P-016) is durably verified, not only green-on-clean-tree.
 *
 * ALLOWLIST — the legitimate sites that build + spawn the agent CLI directly:
 *   • packages/operator-core/lib/dbos/orchestrator-runner.ts — IS the chokepoint
 *     (`spawnInvokeOnce` → `runChild`); everything else funnels through it.
 *
 * (The `/invoke` HTTP route at endpoint-route/routes/harness/spawn.ts WAS the last
 * remaining bypass; it now routes through `spawnInvokeOnce` with a per-call timeout
 * — P-008 — so the only build+spawn site left is the chokepoint itself. Its
 * allowlist entry is gone: the routed file no longer imports node:child_process,
 * so the bypass predicate would flag any regression that re-inlines a raw spawn.)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

export const ALLOWLIST = new Set([
  // The chokepoint: builds (buildInvokeOnce) + spawns (runChild) the agent CLI.
  'packages/operator-core/lib/dbos/orchestrator-runner.ts',
  // The builder LIBRARY: defines `buildInvokeOnce`. It never spawns — every spawn
  // caller must route through `spawnInvokeOnce` (the chokepoint, which lives in
  // the file above). Allowlisted so its own `function buildInvokeOnce(` declaration
  // doesn't read as a call-site bypass.
  'packages/operator-core/lib/harness-invoke-once.ts',
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.endsWith('.test.ts') ||
  !/\.ts$/.test(f);

/**
 * The tell of an agent-CLI spawn bypass: a CALL to `buildInvokeOnce(...)` outside
 * the allowlist. Building the invoke-once command is the chokepoint's exclusive
 * right — every other caller must go through `spawnInvokeOnce`. Keying on the
 * *call* (not "build + raw-spawn in the same file") is what makes this robust to
 * the CROSS-file shape: build the command in file A and hand it to a spawner in
 * file B (the scoper bypass — `harness-scoper.ts` → the old `governed-background-
 * spawn.ts` — that the original same-file `&&` rule silently missed; D-013
 * residual 2). The `(` distinguishes a real call from a bare mention in a comment
 * (e.g. "uses buildInvokeOnce + raw spawn"); the file that DEFINES it
 * (`function buildInvokeOnce(`) is allowlisted, so it never reaches here. Pure
 * (text → boolean) so it's unit-testable.
 */
export function isRawAgentSpawnBypass(text) {
  return /\bbuildInvokeOnce\s*\(/.test(text);
}

/** Scan the tracked tree for bypass offenders (excludes allowlist + _retired + tests). */
export function findOffenders() {
  const tracked = execSync('git ls-files', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (ALLOWLIST.has(f) || isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (isRawAgentSpawnBypass(text)) offenders.push(f);
  }
  return offenders;
}

function main() {
  const offenders = findOffenders();
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
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
