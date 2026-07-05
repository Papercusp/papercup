#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

let ok = true;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (e) { ok = false; console.log(`  FAIL ${label} — ${e.message}`); }
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function submodulePaths() {
  if (!existsSync('.gitmodules')) return [];
  return sh("git config --file .gitmodules --get-regexp '^submodule\\..*\\.path$'")
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).slice(1).join(' '))
    .filter(Boolean);
}

function assertSubmoduleWorktreesSane() {
  const paths = submodulePaths();
  if (paths.length === 0) return;

  const statusByPath = new Map(
    sh('git submodule status --recursive')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const status = line[0];
        const rest = line.slice(1).trim();
        const path = rest.split(/\s+/)[1];
        return [path, status];
      }),
  );

  const problems = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const entries = readdirSync(path).filter((entry) => entry !== '.git');
    const status = statusByPath.get(path);
    if ((status === '-' || status === undefined) && entries.length > 0) {
      const onlyNodeModules = entries.length === 1 && entries[0] === 'node_modules';
      problems.push(
        `${path}: uninitialized submodule path is non-empty` +
          (onlyNodeModules ? ' (only node_modules)' : ` (${entries.slice(0, 5).join(', ')})`),
      );
      continue;
    }
    if (status && status !== '-' && entries.length === 0) {
      problems.push(`${path}: initialized submodule has an empty worktree (only .git)`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `submodule drift detected:\n    ${problems.join('\n    ')}\n` +
        'Run git submodule update --init --recursive; clear droppings-only uninitialized paths first.',
    );
  }
}

console.log('papercup test-doctor\n');
const submodulesOnly = process.argv.includes('--submodules-only');
if (!submodulesOnly) {
  check('docker CLI on PATH', () => execSync('docker --version', { stdio: 'pipe' }));
  check('docker daemon reachable', () => execSync('docker ps', { stdio: 'pipe' }));
  check('node >= 20', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`have ${process.versions.node}`);
  });
}
check('submodule worktrees sane', assertSubmoduleWorktreesSane);

console.log(ok ? '\nAll checks passed.' : '\nSome checks failed — see above.');
process.exit(ok ? 0 : 1);
