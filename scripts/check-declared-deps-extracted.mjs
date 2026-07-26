#!/usr/bin/env node
/**
 * EI-18666853411437489 — "npm said `up to date`, but the package is not on disk."
 *
 * Under concurrent `npm install` runs on this shared tree, npm's reify bookkeeping
 * can end up believing a declared dependency is resolved (it is in
 * `package-lock.json`, and `node_modules/.package-lock.json` is NEWER than it) while
 * the tarball was never actually extracted to `node_modules`. npm then prints
 * "up to date" and exits 0. Nothing catches it until a build/gate fails downstream
 * — often 10+ minutes later, with a confusing unrelated error (a Rolldown
 * "failed to resolve", or a wrongly-suspected code bug in a gate test).
 *
 * `scripts/npm-install-safe.mjs` (+ `scripts/lib/fs-mutex.mjs`) closes the OTHER half
 * of this class: it serializes concurrent installs so new corruption is not created.
 * It cannot detect corruption that ALREADY exists (or that a bare `npm install` run
 * outside the mutex creates), which is what this module is for.
 *
 * The detector itself is the one already proven inside
 * `papercusp-desktop/bin/build-desktop-sidecar.sh` (WI-5769), lifted out of that
 * bash heredoc so the LOCAL shared tree can run the same check:
 *
 *   - SURGICAL, not `npm ls --all`: check ONLY that every package a workspace
 *     DIRECTLY declares in "dependencies" resolves on disk. `npm ls` additionally
 *     reports every UNMET (non-optional) PEER dependency under --legacy-peer-deps,
 *     including transitive peers of test-only packages nothing imports — a real
 *     false-positive that once blocked a build for a dependency it never needed.
 *   - RESOLVE THE WAY NODE DOES: the workspace's own node_modules first, then each
 *     ancestor node_modules up to the repo root (npm hoists nearly everything to
 *     the root in this workspaces monorepo).
 *   - RETRY WITH DELAY: a miss observed immediately after an install can be a
 *     filesystem-sync race rather than a real un-extracted dep. A miss that clears
 *     on retry is the race (non-fatal); one that persists across every attempt is
 *     the real bug.
 *
 * Usage:
 *   node scripts/check-declared-deps-extracted.mjs                    # every workspace
 *   node scripts/check-declared-deps-extracted.mjs --workspace=apps/operator
 *   node scripts/check-declared-deps-extracted.mjs --attempts=3 --delay-ms=2000
 *   npm run doctor:deps
 *
 * Exit 0 = every directly-declared dependency resolves on disk. Exit 1 = at least one
 * does not, after every retry — run `npm run install:safe -- install --legacy-peer-deps`.
 */
import { existsSync as fsExistsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Expand the root package.json "workspaces" globs into repo-relative dirs. */
export function resolveWorkspaceDirs(repoRoot = REPO_ROOT, deps = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const readDir = deps.readDir ?? ((p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })));
  const exists = deps.existsSync ?? fsExistsSync;

  let globs;
  try {
    globs = readJson(join(repoRoot, 'package.json')).workspaces ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(globs)) globs = globs.packages ?? [];

  const out = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (exists(join(repoRoot, glob, 'package.json'))) out.push(glob);
      continue;
    }
    // Only the trailing-`*` shape is used in this repo ("apps/*", "packages/*").
    const parent = glob.slice(0, glob.lastIndexOf('/'));
    if (!glob.endsWith('/*') || !exists(join(repoRoot, parent))) continue;
    for (const entry of readDir(join(repoRoot, parent))) {
      if (!entry.isDir || entry.name.startsWith('.')) continue;
      const rel = `${parent}/${entry.name}`;
      if (exists(join(repoRoot, rel, 'package.json'))) out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Resolve `dep` the way Node/Rolldown would from `fromDir`: that dir's own
 * node_modules, then every ancestor's, up to and including `repoRoot`.
 */
export function resolvesOnDisk(repoRoot, fromDir, dep, exists = fsExistsSync) {
  let dir = resolve(fromDir);
  const root = resolve(repoRoot);
  for (;;) {
    if (exists(join(dir, 'node_modules', dep))) return true;
    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir || !`${dir}${sep}`.startsWith(`${root}${sep}`)) return false;
    dir = parent;
  }
}

/**
 * The detector: every DIRECTLY-declared runtime dependency of each workspace that
 * does not resolve on disk. Returns `[{ dep, workspace }]` (empty = healthy).
 */
export function findUnextractedDeps({ repoRoot = REPO_ROOT, workspaceDirs, deps = {} } = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  const exists = deps.existsSync ?? fsExistsSync;
  const dirs = workspaceDirs ?? resolveWorkspaceDirs(repoRoot, deps);

  const missing = [];
  for (const rel of dirs) {
    let pkg;
    try {
      pkg = readJson(join(repoRoot, rel, 'package.json'));
    } catch {
      continue; // a workspace without a readable package.json is not this check's business
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!resolvesOnDisk(repoRoot, join(repoRoot, rel), dep, exists)) {
        missing.push({ dep, workspace: rel });
      }
    }
  }
  return missing;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `findUnextractedDeps` up to `attempts` times, `delayMs` apart, returning the
 * FINAL attempt's misses. A miss that clears on a later attempt was a
 * filesystem-sync race, not a real un-extracted dependency (WI-5769 retry8).
 */
export async function findUnextractedDepsWithRetry({
  repoRoot = REPO_ROOT,
  workspaceDirs,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let missing = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    missing = findUnextractedDeps({ repoRoot, workspaceDirs, deps });
    if (missing.length === 0) return { missing: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, missing });
      await wait(delayMs);
    }
  }
  return { missing, attempts };
}

export function formatMissing(missing) {
  const lines = [
    `DECLARED_DEPS_UNEXTRACTED: ${missing.length} directly-declared dependency/ies are in package.json (and package-lock.json) but NOT on disk.`,
    'This is npm reify bookkeeping believing they are resolved — the classic symptom of concurrent',
    '`npm install` runs on this shared tree (EI-18666853411437489). It is NOT a code bug: an import of',
    'any of these fails with a confusing "cannot find module" / Rolldown "failed to resolve".',
    '',
  ];
  for (const m of missing) lines.push(`  - ${m.dep} (declared in ${m.workspace}/package.json)`);
  lines.push('', 'FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)');
  return lines.join('\n');
}

function parseArgs(argv) {
  const workspaces = [];
  let attempts = 3;
  let delayMs = 2000;
  for (const arg of argv) {
    if (arg.startsWith('--workspace=')) workspaces.push(arg.slice('--workspace='.length));
    else if (arg.startsWith('--attempts=')) attempts = Number(arg.slice('--attempts='.length)) || attempts;
    else if (arg.startsWith('--delay-ms=')) delayMs = Number(arg.slice('--delay-ms='.length)) || delayMs;
  }
  return { workspaces, attempts, delayMs };
}

export async function main(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  const { workspaces, attempts, delayMs } = parseArgs(argv);
  const workspaceDirs = workspaces.length > 0 ? workspaces.map((w) => relative(repoRoot, resolve(repoRoot, w)) || w) : undefined;

  const { missing } = await findUnextractedDepsWithRetry({
    repoRoot,
    workspaceDirs,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, missing: seen }) =>
      console.error(
        `dep-check attempt ${attempt}/${total}: ${seen.length} missing — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });

  if (missing.length > 0) {
    console.error(formatMissing(missing));
    return 1;
  }
  console.log(`DECLARED_DEPS_OK: every directly-declared dependency resolves on disk (${(workspaceDirs ?? resolveWorkspaceDirs(repoRoot)).length} workspace(s))`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`DECLARED_DEPS_CHECK_ERROR ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
