#!/usr/bin/env node
// Find workspaces affected by a git diff and run their vitest suites.
//
// Usage:
//   node scripts/affected-tests.mjs [--base <ref>] [--integration] [--all]
//
// Defaults:
//   --base origin/main
//   runs the unit suite (`npm test`) per affected workspace
//
// Flags:
//   --integration   also run `npm run test:integration` where defined
//   --all           ignore git diff; run every workspace's tests
//   --dry           print what would run, don't run

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (k) => args.includes(k);

const base = arg('--base', process.env.AFFECTED_BASE || 'origin/main');
const runIntegration = has('--integration');
const runAll = has('--all');
const dry = has('--dry');
// P-016 (release-pipeline-resilience-2026-06-09 D-010): range + print-only mode for the
// green-checkpoint's longest-green-PREFIX salvage. With --range-from/--range-to, the
// changed-file set is the two-dot diff of that commit range (NOT the working tree), and
// --print-affected emits one `AFFECTED_WS\t<name>` line per affected workspace and exits
// WITHOUT running any tests — a cheap git+graph affected-set probe per candidate prefix.
const rangeFrom = arg('--range-from', null);
const rangeTo = arg('--range-to', null);
const printAffected = has('--print-affected');
const runElSuite = has('--el-suite');
const excludeArg = arg('--exclude', '');
const excludes = new Set(excludeArg.split(',').filter(Boolean));

// Read quarantine.txt: workspace-level entries get added to excludes (logged
// as quarantined, not silently skipped). Per-file quarantine is informational
// only — vitest doesn't have a per-file skip flag from outside.
const quarantineFile = join(ROOT, 'quarantine.txt');
const quarantined = new Set();
if (existsSync(quarantineFile)) {
  for (const raw of readFileSync(quarantineFile, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [ws] = line.split('::');
    if (ws) quarantined.add(ws);
  }
}

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Collect every file changed vs `base` — committed (base...HEAD), uncommitted
// (working tree vs HEAD), and untracked. Passes `--ignore-submodules=all` so a
// broken/retired submodule gitlink cannot make `git diff` fail: the shared
// staging checkout carries retired submodules (e.g. libs/papercusp-db,
// libs/zero-harness) whose `.git` ref can point at a missing `.git/modules/...`
// gitdir, which otherwise aborts the diff with `fatal: not a git repository:
// libs/papercusp-db/../../.git/modules/libs/papercusp-db`. Before this, that
// failure was swallowed and the whole run silently degraded to `--all` (every
// workspace) — slow, noisy, and it masked the real cause (EI-1989).
// `git ls-files --others` does not recurse into submodules, so it needs no such
// flag. Throws on a genuine git error so the caller can decide to warn or bail.
function changedFiles() {
  if (rangeFrom && rangeTo) {
    // P-016: two-dot range — files changed BY the commits in (rangeFrom, rangeTo]. No
    // working-tree / untracked component: we're probing a historical commit prefix for
    // the green-checkpoint salvage, not diffing the live tree.
    return sh(`git diff --name-only --ignore-submodules=all ${rangeFrom}..${rangeTo}`).split('\n').filter(Boolean);
  }
  const committed = sh(`git diff --name-only --ignore-submodules=all ${base}...HEAD`).split('\n').filter(Boolean);
  const uncommitted = sh('git diff --name-only --ignore-submodules=all HEAD').split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard').split('\n').filter(Boolean);
  return [...new Set([...committed, ...uncommitted, ...untracked])];
}

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const workspaces = expandWorkspaces(root.workspaces);

function expandWorkspaces(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      const baseDir = join(ROOT, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of execSync(`ls -1 ${JSON.stringify(baseDir)}`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)) {
        const dir = join(base, entry);
        if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(ROOT, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

const wsByName = new Map();
const wsByDir = new Map();
for (const dir of workspaces) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const meta = { dir, name: pkg.name, scripts: pkg.scripts || {}, deps: depsOf(pkg) };
  wsByName.set(pkg.name, meta);
  wsByDir.set(dir, meta);
}

function depsOf(pkg) {
  return new Set(
    Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) }),
  );
}

// Reverse-dependency map: which workspaces depend on X?
const reverseDeps = new Map();
for (const ws of wsByDir.values()) {
  for (const dep of ws.deps) {
    if (!wsByName.has(dep)) continue;
    if (!reverseDeps.has(dep)) reverseDeps.set(dep, new Set());
    reverseDeps.get(dep).add(ws.name);
  }
}

// P-016 (D-010): print-only affected-set probe for the green-checkpoint longest-green-
// prefix salvage. Emit one machine-parseable `AFFECTED_WS\t<name>` line per affected
// workspace and exit BEFORE any test run / EL-suite auto-trigger. affectedWorkspaces()
// is a hoisted function declaration, so it is callable here.
if (printAffected) {
  for (const ws of affectedWorkspaces()) console.log(`AFFECTED_WS\t${ws.name}`);
  process.exit(0);
}

function affectedWorkspaces() {
  if (runAll) return [...wsByDir.values()];

  let changed;
  try {
    changed = changedFiles();
  } catch (e) {
    // `--ignore-submodules=all` (see changedFiles) means a broken retired
    // submodule no longer trips this — so a failure HERE is now a GENUINE git
    // problem, not the routine retired-submodule breakage. Make the
    // degrade-to-everything LOUD: the old fallback printed two quiet lines and
    // ran all ~80 workspaces, which read as a normal (if slow) run and hid the
    // real cause (EI-1989). A banner on stderr ensures it can't masquerade as
    // the intended fast path.
    console.error('');
    console.error('!!!!!! affected-tests: COULD NOT COMPUTE THE AFFECTED SET !!!!!!');
    console.error(`!!!!!! \`git diff\` against ${base} failed: ${e.message}`);
    console.error('!!!!!! FALLING BACK TO --all (running EVERY workspace) — SLOW, and a BUG, not the intended path.');
    console.error('!!!!!! Fix the git error above; do not rely on this fallback.');
    console.error('');
    return [...wsByDir.values()];
  }

  const directlyChanged = new Set();
  for (const file of changed) {
    for (const ws of wsByDir.values()) {
      if (file === `${ws.dir}/package.json` || file.startsWith(`${ws.dir}/`)) {
        directlyChanged.add(ws.name);
      }
    }
  }

  // Walk reverse-deps transitively
  const affected = new Set(directlyChanged);
  const queue = [...directlyChanged];
  while (queue.length) {
    const name = queue.shift();
    const dependents = reverseDeps.get(name);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!affected.has(d)) { affected.add(d); queue.push(d); }
    }
  }

  return [...affected].map((name) => wsByName.get(name)).filter(Boolean);
}

/**
 * Detect "EL-relevant" file changes — persona, sync script, the test
 * itself, or any registered command def the agent might call. When
 * these change AND --integration is set, auto-enable --el-suite so the
 * operator's voice agent doesn't drift unnoticed.
 */
function elSuiteAutoTrigger() {
  if (runAll) return false; // user already opted into everything
  let changed;
  try {
    changed = changedFiles();
  } catch { return false; }
  return changed.some((f) =>
    f === 'apps/operator/prompts/operator.persona.md' ||
    f === 'apps/operator/scripts/el-agent-sync.mjs' ||
    f === 'apps/operator/scripts/el-suite-test.mjs' ||
    f.startsWith('apps/operator/lib/commands/defs/')
  );
}
if (runIntegration && !runElSuite && elSuiteAutoTrigger()) {
  console.log('(EL-relevant files changed — auto-enabling --el-suite)');
  // mutate the flag so the task collector below picks it up
  // eslint-disable-next-line no-global-assign
  globalThis.__autoElSuite = true;
}

const affected = affectedWorkspaces();

if (!affected.length) {
  console.log('No affected workspaces.');
  process.exit(0);
}

const tasks = [];
for (const ws of affected) {
  if (excludes.has(ws.name)) { console.log(`(excluded ${ws.name})`); continue; }
  if (ws.scripts.test) tasks.push({ ws, script: 'test' });
  // Static drift check between el-agent-sync TOOLS list and the
  // commands registry. Cheap (no network), catches the runtime crash
  // class that hit us yesterday ("Client tool not defined on client").
  // Always runs when present — no integration flag gate.
  if (ws.scripts['lint:el-tools']) tasks.push({ ws, script: 'lint:el-tools' });
  if (runIntegration && ws.scripts['test:integration']) tasks.push({ ws, script: 'test:integration' });
  // EL Conv AI behavior suite. Hits the live agent; expensive (a few
  // EL minutes per run). Gated behind --integration AND --el-suite
  // because most operator changes don't affect persona/tools — opt-in
  // when you've touched prompts/operator.persona.md, scripts/el-agent-
  // sync.mjs, lib/commands/defs/**, or want to verify before a release.
  // Skips with exit 0 when EL credentials aren't available so CI
  // without an XI_API_KEY doesn't fail the gate.
  if (runIntegration && (runElSuite || globalThis.__autoElSuite) && ws.scripts['test:el-suite']) tasks.push({ ws, script: 'test:el-suite' });
}

if (!tasks.length) {
  console.log(`Affected: ${affected.map((w) => w.name).join(', ')} — but none declare a 'test' script.`);
  process.exit(0);
}

console.log(`Affected workspaces (${affected.length}): ${affected.map((w) => w.name).join(', ')}`);
console.log(`Running ${tasks.length} task(s):`);
for (const t of tasks) console.log(`  - ${t.ws.name} :: ${t.script}`);

if (dry) process.exit(0);

// AFFECTED_RETRY_FAILED=1 (the green-checkpoint sets it): re-run a FAILED
// workspace once before counting it. On the shared dev box the gate runs
// while the fleet is at load 70-95, and single-test timeout flakes were
// holding green `main` back for HOURS (2026-06-06 afternoon: consecutive
// not-greens whose identification re-run passed 8867/8867). A real
// regression fails both runs; a load flake almost never fails twice in a
// row. Default OFF so interactive `test:affected` keeps fail-fast feedback.
const retryFailed = process.env.AFFECTED_RETRY_FAILED === '1';

// HARDEN-GATE (su-85e11 proposal, landed via brief 09 2026-06-10): when a
// workspace fails under AFFECTED_RETRY_FAILED, prefer re-running just the
// FAILED FILES in a FRESH process over re-running the whole workspace.
// Two flake classes the workspace-level retry handles poorly:
//   - cross-file state poisoning (vitest-fail-on-console catching another
//     file's late console output; shared bootstrap-graph state) — a fresh
//     process clears it where an identical full re-run can reproduce it;
//   - peer mid-edit transform errors on the shared tree — scoping the retry
//     to the failed files keeps the second run cheap (seconds, not a 10k-test
//     suite), so the gate's wall-clock stays bounded under load.
// Parse the vitest summary for failed files; when nothing parses (e.g. a
// non-vitest failure mode) fall back to the original full-workspace retry.
function parseFailedFiles(out) {
  const files = new Set();
  // ` ❯ lib/x/y.test.ts (22 tests | 1 failed) 85ms` — failed-file summary rows
  for (const m of out.matchAll(/^\s*❯\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\([^)]*\bfailed\b[^)]*\)/gm)) {
    files.add(m[1]);
  }
  // `FAIL  lib/x/y.test.ts …` — failed-suite rows (transform/setup errors)
  for (const m of out.matchAll(/^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gm)) {
    files.add(m[1]);
  }
  return [...files];
}
const FRESH_RETRY_MAX_FILES = 15; // a broader red is a real regression, not a flake

let failed = 0;
let quarantinedFailed = 0;
for (const t of tasks) {
  const isQuarantined = quarantined.has(t.ws.name);
  console.log(`\n>>> ${t.ws.name} :: npm run ${t.script}${isQuarantined ? ' [QUARANTINED]' : ''}`);
  // Under retryFailed we must capture output to learn WHICH files failed; the
  // interactive path keeps stdio:'inherit' for live streaming.
  const run = (extraArgs = []) => {
    const argv = ['run', t.script, '--workspace', t.ws.dir, ...(extraArgs.length ? ['--', ...extraArgs] : [])];
    if (!retryFailed) return spawnSync('npm', argv, { cwd: ROOT, stdio: 'inherit' });
    // A full vitest suite emits far beyond spawnSync's 1MB default maxBuffer —
    // an ENOBUFS-killed child would read as a failure. 256MB clears any suite.
    const r = spawnSync('npm', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) console.error(`>>> ${t.ws.name} spawn error: ${r.error.message}`);
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    return r;
  };
  let r = run();
  if (r.status !== 0 && retryFailed && !isQuarantined) {
    const failedFiles = parseFailedFiles(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (failedFiles.length > 0 && failedFiles.length <= FRESH_RETRY_MAX_FILES) {
      console.warn(
        `\n>>> ${t.ws.name} FAILED — fresh-process re-run of ${failedFiles.length} failed file(s) (HARDEN-GATE flake absorption): ${failedFiles.join(', ')}`,
      );
      r = run(failedFiles);
      if (r.status === 0)
        console.warn(`>>> ${t.ws.name} failed files passed in a fresh process — counted as a FLAKE, not a failure.`);
    } else {
      console.warn(`\n>>> ${t.ws.name} FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)`);
      r = run();
      if (r.status === 0) console.warn(`>>> ${t.ws.name} passed on retry — counted as a FLAKE, not a failure.`);
    }
  }
  if (r.status !== 0) {
    if (isQuarantined) {
      quarantinedFailed++;
      console.warn(`  (quarantined failure — not gating)`);
    } else {
      failed++;
    }
  }
}

if (quarantinedFailed) {
  console.warn(`\n${quarantinedFailed} quarantined task(s) failed (not gating).`);
}
if (failed) {
  console.error(`\n${failed} non-quarantined task(s) failed.`);
  process.exit(1);
}
console.log('\nAll affected tests passed.');
