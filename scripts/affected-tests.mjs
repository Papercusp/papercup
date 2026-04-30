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

function affectedWorkspaces() {
  if (runAll) return [...wsByDir.values()];

  let changed;
  try {
    changed = sh(`git diff --name-only ${base}...HEAD`).split('\n').filter(Boolean);
    const uncommitted = sh('git diff --name-only HEAD').split('\n').filter(Boolean);
    const untracked = sh('git ls-files --others --exclude-standard').split('\n').filter(Boolean);
    changed = [...new Set([...changed, ...uncommitted, ...untracked])];
  } catch (e) {
    console.error(`git diff against ${base} failed: ${e.message}`);
    console.error('falling back to --all');
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

const affected = affectedWorkspaces();

if (!affected.length) {
  console.log('No affected workspaces.');
  process.exit(0);
}

const tasks = [];
for (const ws of affected) {
  if (excludes.has(ws.name)) { console.log(`(excluded ${ws.name})`); continue; }
  if (ws.scripts.test) tasks.push({ ws, script: 'test' });
  if (runIntegration && ws.scripts['test:integration']) tasks.push({ ws, script: 'test:integration' });
}

if (!tasks.length) {
  console.log(`Affected: ${affected.map((w) => w.name).join(', ')} — but none declare a 'test' script.`);
  process.exit(0);
}

console.log(`Affected workspaces (${affected.length}): ${affected.map((w) => w.name).join(', ')}`);
console.log(`Running ${tasks.length} task(s):`);
for (const t of tasks) console.log(`  - ${t.ws.name} :: ${t.script}`);

if (dry) process.exit(0);

let failed = 0;
let quarantinedFailed = 0;
for (const t of tasks) {
  const isQuarantined = quarantined.has(t.ws.name);
  console.log(`\n>>> ${t.ws.name} :: npm run ${t.script}${isQuarantined ? ' [QUARANTINED]' : ''}`);
  const r = spawnSync('npm', ['run', t.script, '--workspace', t.ws.dir], {
    cwd: ROOT,
    stdio: 'inherit',
  });
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
