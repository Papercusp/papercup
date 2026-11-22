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
 *   node scripts/condition-rail-inventory.mjs --acceptance # require every seed migration on-rail
 *                                                        # AND bound to an executable case
 *   npx tsx scripts/condition-rail-inventory.mjs --lint   # shrink-only site-ID baseline
 *
 * The scanner lives in scripts/lib/condition-rail-inventory.mjs; dispositions in
 * scripts/lib/condition-rail-dispositions.mjs.
 */
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGovernedTestProcess } from './lib/governed-test-process.mjs';
import { inventoryTree, inventoryCoverageProblems, CLASSES, acceptanceProblems, lintProblems, baselineCeiling } from './lib/condition-rail-inventory.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = 'scripts/condition-rail-baseline.json';
const SEED = 'docs/evidence/condition-rail-inventory-seed-2026-10-11.json';
const identity = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });

/** Every committed removal constrains the ceiling; committing a grown file cannot bless it. */
export async function readCommittedBaseline(manifest, baseline, inputs) {
  return runGovernedTestProcess({ owner: 'lint-condition-rail-baseline', namespace: 'lint-condition-rail',
    timeoutMs: 30_000, demand: { cpuWeight: 1, memoryBytes: 64 * 1024 * 1024, fileDescriptors: 8 } },
  (_context, env) => {
  const options = { cwd: ROOT, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] };
  const log = execFileSync('git', ['log', '--format=%H', 'HEAD', '--', BASELINE], options);
  const stdout = log.toString('utf8');
  if (inputs) inputs.history.log = { ...identity(log), stdout };
  const revisions = stdout.trim().split('\n').filter(Boolean);
  const history = revisions.map(revision => {
    const bytes = execFileSync('git', ['show', `${revision}:${BASELINE}`], options);
    if (inputs) inputs.history.shows.push({ revision, ...identity(bytes) });
    return JSON.parse(bytes.toString('utf8'));
  });
  // The first edition binds the P-001 seed plus P-017's logged census corrections.
  // Later editions cannot widen that set, regardless of new amendment prose.
  const initial = history.at(-1) ?? { rowIds: [
    ...manifest.rows.filter((row) => row.disposition === 'migrate').map((row) => row.id),
    ...(baseline.amendments ?? []).filter((entry) => entry.change?.disposition === 'migrate').map((entry) => entry.rowId),
  ] };
  return baselineCeiling(initial, history);
  });
}

export function runInventory(readFile) {
  return inventoryTree(ROOT, readFile);
}

async function run(args, inputs) {
  const res = runInventory(inputs && (path => {
    const bytes = readFileSync(join(ROOT, path));
    inputs.sources.push({ path, ...identity(bytes) });
    return bytes.toString('utf8');
  }));
  if (inputs) inputs.inventory = { scanned: res.scanned, unreadableFiles: res.unreadableFiles, submodules: res.submodules };
  const coverageProblems = inventoryCoverageProblems(res);
  if (res.submodules.outsideScanScope.length) {
    console.error(`Unscanned submodules outside the condition-rail source scope: ${JSON.stringify(res.submodules.outsideScanScope)}`);
  }
  if (args.includes('--lint')) {
    const readJson = (path, role) => {
      const bytes = readFileSync(join(ROOT, path));
      if (inputs) inputs[role] = { path, ...identity(bytes) };
      return JSON.parse(bytes.toString('utf8'));
    };
    const manifest = readJson(SEED, 'seed'), baseline = readJson(BASELINE, 'baseline');
    const problems = lintProblems(res, baseline, await readCommittedBaseline(manifest, baseline, inputs), manifest);
    if (inputs) inputs.completed = true;
    console.log(`condition-rail lint: ${res.rows.length} bypass site(s), ${problems.length} problem(s)`);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
  } else if (args.includes('--json')) {
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
    for (const problem of coverageProblems) console.error(problem);
  }
  if (args.includes('--acceptance')) {
    const manifest = JSON.parse(readFileSync(new URL('../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url), 'utf8'));
    const [{ RAIL_MIGRATION_CASES }, { listDegradationMechanisms }] = await Promise.all([
      import('@papercusp/operator-core/lib/degradation/rail-migration-cases'),
      import('@papercusp/operator-core/lib/system-health/degradation-watchdog'),
    ]);
    const problems = acceptanceProblems(manifest, res, RAIL_MIGRATION_CASES,
      listDegradationMechanisms().map((mechanism) => mechanism.mechanism));
    console.log(`condition-rail structural acceptance: ${problems.length} problem(s); executable cases run in condition-rail-coverage.test.ts`);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
  }
  if (args.includes('--check') && (coverageProblems.length || res.undispositioned > 0 || res.staleDispositions.length > 0)) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2), out = process.env.PC_EXECUTED_SOURCE_MAP_OUT;
  if (!args.includes('--lint') || !out || !isAbsolute(out) || process.env.npm_lifecycle_event !== 'lint:condition-rail') {
    return run(args);
  }
  const inputs = { schemaVersion: 'condition-rail-lint-inputs-v1', pid: process.pid, ppid: process.ppid,
    cwd: process.cwd(), startedAtMs: Date.now(), finishedAtMs: null, kernelProcessIdentity: null, completed: false,
    sources: [], inventory: null, seed: null, baseline: null, history: { log: null, shows: [] } };
  try { await run(args, inputs); }
  finally {
    // A failed lint still has measured reads. An unavailable observation must preserve its original outcome.
    try {
      const { readProcessIdentity } = await import('./lib/process-identity.mjs');
      const { publishConditionRailInputManifest } = await import('./lib/budgeted-task-scheduler.mjs');
      inputs.kernelProcessIdentity = readProcessIdentity(process.pid);
      inputs.finishedAtMs = Date.now();
      console.log(publishConditionRailInputManifest(out, inputs));
    } catch (error) { console.error('condition-rail input capture unavailable:', error.message); }
  }
}

if (isCliEntry(import.meta.url)) await main();
