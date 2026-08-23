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
 *   - SURGICAL, not `npm ls --all`: check that every package a workspace
 *     DIRECTLY declares in "dependencies" resolves on disk, then import a small
 *     lockfile-selected set of critical runtime entrypoints. The second leg catches
 *     an existing package directory whose `dist/` or native payload is incomplete,
 *     plus missing TRANSITIVE files reached by the import (EI-21252116452570853).
 *     `npm ls` additionally
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
import { spawnSync } from "node:child_process";
import { existsSync as fsExistsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runtime entrypoints whose real import graph is load-bearing for ptool and the
 * staging API. A probe is enabled only when its package appears in the target
 * repo's package-lock, so managed hives that do not declare this stack are not
 * coupled to Papercusp-specific packages.
 *
 * Prefer the public @lydell/node-pty entrypoint over a platform package name: it
 * selects and loads the correct native payload for the current platform while
 * still catching the observed missing @lydell/node-pty-linux-x64 package.
 */
export const RUNTIME_CONTENT_PROBES = Object.freeze([
  '@modelcontextprotocol/sdk/client/index.js',
  'zod-to-json-schema',
  'hono',
  '@lydell/node-pty',
  'rocksdb-native',
]);

export function packageNameFromSpecifier(specifier) {
  const parts = String(specifier).split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Select only probes whose package is part of the target repo's locked graph. */
export function resolveRuntimeContentProbes(repoRoot = REPO_ROOT, probes = RUNTIME_CONTENT_PROBES, deps = {}) {
  const readJson = deps.readJson ?? ((p) => JSON.parse(readFileSync(p, 'utf8')));
  let lock;
  try {
    lock = readJson(join(repoRoot, 'package-lock.json'));
  } catch {
    return [];
  }
  const packagePaths = Object.keys(lock.packages ?? {});
  return probes.filter((specifier) => {
    const packageName = packageNameFromSpecifier(specifier);
    const suffix = `/node_modules/${packageName}`;
    return packagePaths.some((packagePath) => packagePath === `node_modules/${packageName}` || packagePath.endsWith(suffix));
  });
}

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

const RUNTIME_IMPORT_CHILD = `
try {
  await import(process.argv[1]);
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IMPORT_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  console.error(code + ': ' + message);
  process.exitCode = 1;
}
`;

function defaultRuntimeImportProbe({ repoRoot, specifier }) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", RUNTIME_IMPORT_CHILD, specifier],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  if (result.status === 0) return { ok: true };
  const detail =
    result.error?.message ??
    String(result.stderr ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ??
    `child exited ${result.status ?? result.signal ?? "without status"}`;
  return { ok: false, detail };
}

/**
 * Import critical runtime entrypoints in isolated child processes. Directory
 * existence alone cannot detect a package whose manifest survived but dist/native
 * contents were only partly extracted; a real import also walks transitive imports.
 */
export function findUnusableRuntimeDeps({
  repoRoot = REPO_ROOT,
  probeSpecifiers,
  deps = {},
} = {}) {
  const specifiers =
    probeSpecifiers ??
    resolveRuntimeContentProbes(repoRoot, RUNTIME_CONTENT_PROBES, deps);
  const probe = deps.probeRuntimeImport ?? defaultRuntimeImportProbe;
  const failures = [];
  for (const specifier of specifiers) {
    const result = probe({ repoRoot, specifier });
    if (result === true || result?.ok === true) continue;
    failures.push({
      specifier,
      detail:
        typeof result === "string"
          ? result
          : (result?.detail ?? "runtime import failed"),
    });
  }
  return failures;
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

/** Retry the real-import leg for the same filesystem-settle window as the directory leg. */
export async function findUnusableRuntimeDepsWithRetry({
  repoRoot = REPO_ROOT,
  probeSpecifiers,
  attempts = 3,
  delayMs = 2000,
  deps = {},
  onRetry,
} = {}) {
  const wait = deps.sleep ?? sleep;
  let failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    failures = findUnusableRuntimeDeps({ repoRoot, probeSpecifiers, deps });
    if (failures.length === 0) return { failures: [], attempts: attempt };
    if (attempt < attempts) {
      onRetry?.({ attempt, attempts, failures });
      await wait(delayMs);
    }
  }
  return { failures, attempts };
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

export function formatRuntimeFailures(failures) {
  const lines = [
    `RUNTIME_DEPS_UNUSABLE: ${failures.length} critical runtime entrypoint(s) failed a real import.`,
    "A package directory exists, but its entrypoint, native payload, or transitive import is incomplete.",
    "This is a partial npm extraction, not proof of an application-code regression.",
    "",
  ];
  for (const failure of failures)
    lines.push(`  - ${failure.specifier}: ${failure.detail}`);
  lines.push(
    "",
    "FIX: npm run install:safe -- install --legacy-peer-deps   (serialized; never a bare `npm install`)",
  );
  return lines.join("\n");
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

  const probeSpecifiers = resolveRuntimeContentProbes(repoRoot);
  const { failures } = await findUnusableRuntimeDepsWithRetry({
    repoRoot,
    probeSpecifiers,
    attempts,
    delayMs,
    onRetry: ({ attempt, attempts: total, failures: seen }) =>
      console.error(
        `runtime-dep-check attempt ${attempt}/${total}: ${seen.length} failed import(s) — retrying in ${delayMs}ms (could be a filesystem-sync race)`,
      ),
  });
  if (failures.length > 0) {
    console.error(formatRuntimeFailures(failures));
    return 1;
  }

  console.log(
    `DECLARED_DEPS_OK: every directly-declared dependency resolves on disk (${(workspaceDirs ?? resolveWorkspaceDirs(repoRoot)).length} workspace(s)); ${probeSpecifiers.length} critical runtime import(s) load`,
  );
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
