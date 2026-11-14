#!/usr/bin/env node
/**
 * EI-18662389554660036 — a single agent's `npm install` on this shared tree
 * breaks EVERY other agent's test runs for minutes (node_modules/.bin/vitest
 * vanishes mid-rewrite), and two OVERLAPPING installs can corrupt a package
 * outright (half-written dist/ — not a version-resolution issue, does not
 * self-heal). There is no advisory lock on a shared-tree-wide mutation this
 * disruptive, even though the exact primitive (a named resource lock) already
 * guards `dev:restart` / `db:migrate` for the same reason.
 *
 * This wrapper serializes `npm install`/`npm ci`/etc invocations across
 * concurrent agent processes on the SAME host via `withFsMutex` (scripts/lib/
 * fs-mutex.mjs — the same mkdir-lock algorithm `withTestcontainerStartLock`
 * already uses for the analogous "many Vitest processes, one Docker handshake"
 * problem). The lock is keyed off the REPO ROOT's real (symlink-resolved) path,
 * so invoking it via the `papercup` symlink or the canonical `papercusp` path
 * both hit the SAME lock (they're one tree) — but a genuinely different
 * checkout (papercup-release, papercup-checkpoint, ...) gets its own lock and
 * is never blocked by this one.
 *
 * EI-18666853411437489 — the mutex stops CONCURRENT installs from corrupting npm's
 * reify bookkeeping, but it cannot detect corruption that ALREADY exists (from an
 * earlier bare `npm install`, or another checkout's run). That failure is silent:
 * npm prints "up to date", exits 0, and leaves a declared dependency un-extracted;
 * the first symptom is a confusing "cannot find module" / Rolldown "failed to
 * resolve" in some unrelated build or gate, often 10+ minutes later. So a successful
 * install is now VERIFIED before the lock is released — every directly-declared
 * dependency directory must resolve AND lockfile-selected critical runtime
 * entrypoints must really import (catching incomplete dist/native/transitive
 * contents) — with ONE bounded auto-repair before failing loudly. A nonzero repair
 * exit is itself fatal; a later spot probe may not erase an ENOTEMPTY failure.
 * Set PAPERCUSP_SKIP_DEP_VERIFY=1 to skip the verification.
 *
 * Managed hives reuse this same implementation with `--repo-root`; the lock
 * and npm cwd both follow that explicit target instead of this script's repo.
 * A `--prefix` install remains outside this wrapper because npm owns the target
 * selection in that shape and the global guard deliberately leaves it alone.
 *
 * Usage: npm run install:safe [-- <npm args>]   (defaults to plain `npm install`)
 *        node scripts/npm-install-safe.mjs ci
 *        node scripts/npm-install-safe.mjs install --legacy-peer-deps
 *        node scripts/npm-install-safe.mjs --offline-safe ci
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive -- install --no-save pkg
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive --exec-under-lock -- command arg...
 *
 * `--offline-safe` is a wrapper-only mode for exact-candidate reconstruction. It
 * sets `ONNXRUNTIME_NODE_INSTALL=skip` in npm and bounded-repair children without
 * mutating the caller's environment or forwarding the wrapper flag to npm. An
 * explicit caller-provided `ONNXRUNTIME_NODE_INSTALL` value remains authoritative.
 *
 * `--exec-under-lock` is the reader-side half of the same contract. Long-lived
 * host services build an entrypoint from node_modules immediately before boot;
 * if systemd restarts one while an install is reifying the shared tree, the
 * build/runtime can observe a half-extracted native package and crash-loop.
 * Running that build command under the install mutex makes it wait for the
 * verified install boundary instead of repeatedly reading the transition.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isCliEntry } from "../packages/operator-core/lib/util/cli-entry.ts";
import {
  PACKAGE_CACHE_MUTEX_NAME,
  resolveFsMutexTimeoutMs,
  withFsMutexRead,
  withFsMutex,
} from "./lib/fs-mutex.mjs";
import { TEST_FILE_EXIT_NOT_MEASURED } from "./lib/test-file-exit-codes.mjs";
import { envWithInstallMutex, installLockNameForRoot, installLockRootForPath, installMutexIsHeld } from "./lib/install-lock-name.mjs";
export { installMutexIsHeld } from "./lib/install-lock-name.mjs";
import {
  findIncompleteWorkspacePackagesWithRetry,
  findInvalidWorkspacePackageVersionsWithRetry,
  findUnextractedDepsWithRetry,
  findUnsatisfiedDeclaredDepRangesWithRetry,
  findUnusableRuntimeDepsWithRetry,
  packageNameFromSpecifier,
  formatIncompleteWorkspacePackages,
  formatInvalidWorkspacePackageVersions,
  formatMissing,
  formatRuntimeFailures,
  formatUnsatisfiedDeclaredDepRanges,
  resolveWorkspaceDirs,
} from "./check-declared-deps-extracted.mjs";
import { findBrokenBinLinks } from "./check-partial-install.mjs";
import { expandWorkspaces } from "./assert-workspace-links.mjs";
import { auditLockfile, enclosingWorkspaceOwner } from "../apps/operator/bin/release/dependency-lock-tree-audit.mjs";
import { EMBEDDED_EXTENSIONS, installEmbeddedExtensions, missingWarning } from "./install-embedded-pgvector.mjs";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REPAIR_ARGS = ["install", "--legacy-peer-deps"];
const EXEC_UNDER_LOCK_FLAG = "--exec-under-lock";
const OFFLINE_SAFE_FLAG = "--offline-safe";
const CACHE_VERIFY_ARGS = ["cache", "verify"];
const DEPENDENCY_GENERATION_SCRIPT = join(
  DEFAULT_REPO_ROOT,
  "apps/operator/bin/release/dependency-generation.sh",
);

/**
 * Keep an explicit --cache override attached to the cache repair. Without it,
 * `npm run install:safe -- --cache <dir> ...` would verify the user's default
 * cache and then reify from a different cache, leaving the corrupt one
 * untouched. Environment/config-file cache selection is inherited by npm.
 */
export function cacheVerifyArgs(npmArgs = []) {
  const cacheArgs = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--cache" && typeof npmArgs[index + 1] === "string") {
      cacheArgs.push(arg, npmArgs[index + 1]);
      index += 1;
    } else if (typeof arg === "string" && arg.startsWith("--cache=")) {
      cacheArgs.push(arg);
    }
  }
  return [...CACHE_VERIFY_ARGS, ...cacheArgs];
}

/**
 * npm's repeatable workspace selectors (`--workspace X`, `--workspace=X`, `-w X`,
 * `-w=X`) in argv order. An empty list means an unscoped, whole-project command.
 */
export function workspaceSelectorsForNpmArgs(npmArgs = []) {
  const selectors = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--workspace" || arg === "-w") {
      if (typeof npmArgs[index + 1] === "string")
        selectors.push(npmArgs[++index]);
    } else if (typeof arg === "string" && arg.startsWith("--workspace=")) {
      selectors.push(arg.slice("--workspace=".length));
    } else if (typeof arg === "string" && arg.startsWith("-w=")) {
      selectors.push(arg.slice("-w=".length));
    }
  }
  return selectors;
}

/**
 * Resolve npm's repeatable workspace selectors to the canonical repo-relative
 * directories consumed by the dependency-integrity scanners. npm accepts both
 * package names and paths, while those scanners intentionally accept paths only.
 * No selector means a full install and therefore a full-tree verification.
 */
export function verificationScopeForNpmArgs({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  deps = {},
} = {}) {
  const selectors = workspaceSelectorsForNpmArgs(npmArgs);
  if (selectors.length === 0)
    return { workspaceDirs: undefined, repairWorkspaceArgs: [] };

  const readJson =
    deps.readJson ?? ((path) => JSON.parse(readFileSync(path, "utf8")));
  const workspaceDirs = resolveWorkspaceDirs(repoRoot, deps);
  const bySelector = new Map();
  for (const dir of workspaceDirs) {
    bySelector.set(dir, dir);
    bySelector.set(`./${dir}`, dir);
    const manifest = readJson(join(repoRoot, dir, "package.json"));
    if (typeof manifest?.name === "string") bySelector.set(manifest.name, dir);
  }
  const selectedDirs = selectors.map((selector) => {
    const dir = bySelector.get(selector);
    if (!dir)
      throw new Error(
        `npm workspace selector did not resolve after install: ${selector}`,
      );
    return dir;
  });
  const uniqueDirs = [...new Set(selectedDirs)];
  return {
    workspaceDirs: uniqueDirs,
    repairWorkspaceArgs: selectors.map((selector) => `--workspace=${selector}`),
  };
}

const LOCK_MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const LOCK_GUARDED_TEST_RUNNERS = new Set([
  "scripts/affected-tests.mjs",
  "scripts/test-files.mjs",
]);

function normalizedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Detect the measured npm failure class before either Arborist or a project test
 * runner consumes the dependency graph. Root-lock workspace entries mirror the
 * manifest dependency maps; stale copies can detach npm's ideal-tree link targets
 * and crash inside build-ideal-tree before npm can repair them.
 */
export function findRootLockManifestMismatches(repoRoot = DEFAULT_REPO_ROOT, deps = {}) {
  const root = resolve(repoRoot);
  const exists = deps.existsSync ?? existsSync;
  const readJson = deps.readJson ?? ((path) => JSON.parse(readFileSync(path, "utf8")));
  const shrinkwrapPath = join(root, "npm-shrinkwrap.json");
  const lockPath = exists(shrinkwrapPath)
    ? shrinkwrapPath
    : join(root, "package-lock.json");
  if (!exists(lockPath)) return [];

  let lock;
  try {
    lock = readJson(lockPath);
  } catch {
    return [{
      workspace: "<lockfile>",
      field: "JSON",
      differences: { packageLock: { manifest: "readable", lock: "unparseable" } },
    }];
  }
  const lockPackages = lock?.packages;
  // Legacy npm lockfile formats do not carry the per-workspace manifest mirror
  // this guard audits. Leave those trees to npm's own parser.
  if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages))
    return [];

  const candidates = new Set(["", ...resolveWorkspaceDirs(root, deps)]);
  for (const key of Object.keys(lockPackages)) {
    if (!key || key.includes("node_modules/") || lockPackages[key]?.link) continue;
    const absolute = resolve(root, key);
    if (!isStrictlyWithin(root, absolute)) continue;
    const rel = relative(root, absolute).split(sep).join("/");
    if (exists(join(absolute, "package.json"))) candidates.add(rel);
  }

  const mismatches = [];
  for (const workspace of [...candidates].sort()) {
    const manifestPath = workspace
      ? join(root, workspace, "package.json")
      : join(root, "package.json");
    if (!exists(manifestPath)) continue;

    const lockEntry = lockPackages[workspace];
    if (!lockEntry || typeof lockEntry !== "object") {
      mismatches.push({
        workspace,
        field: "packages entry",
        differences: { entry: { manifest: "present", lock: "missing" } },
      });
      continue;
    }
    if (lockEntry.link) continue;

    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      mismatches.push({
        workspace,
        field: "package.json",
        differences: { manifest: { packageJson: "unparseable", lock: "not compared" } },
      });
      continue;
    }

    for (const field of LOCK_MANIFEST_DEPENDENCY_FIELDS) {
      const declared = normalizedRecord(manifest[field]);
      const locked = normalizedRecord(lockEntry[field]);
      const differences = {};
      for (const dependency of new Set([
        ...Object.keys(declared),
        ...Object.keys(locked),
      ])) {
        if (isDeepStrictEqual(declared[dependency], locked[dependency])) continue;
        differences[dependency] = {
          manifest: Object.hasOwn(declared, dependency) ? declared[dependency] : "<absent>",
          lock: Object.hasOwn(locked, dependency) ? locked[dependency] : "<absent>",
        };
      }
      if (Object.keys(differences).length > 0)
        mismatches.push({ workspace, field, differences });
    }
  }
  return mismatches;
}

/** Inspect an immutable metadata census using the ordinary install comparator.
 * Readers supply Git bytes and identity; this core never consults the checkout.
 * Keep parse failures distinct from classified dependency disagreements. */
export function inspectWorkspaceLockSnapshot(repoRoot, files, inputs = []) {
  const root = resolve(repoRoot);
  const name = path => relative(root, path).split(sep).join("/");
  const directories = [...files.keys()].filter(path => path.endsWith("/package.json")).map(dirname);
  const errors = [];
  const mismatches = [];
  const selectedReaders = {
    existsSync: path => files.has(name(path)),
    readJson: path => JSON.parse(files.get(name(path))),
    expandWorkspaces: (patterns, base) => expandWorkspaces(patterns, base, { directories }),
  };
  // A fixture's package-lock is data, not another project to publish. Preserve
  // the existing workspace scope and include independently pinned project roots.
  const lockRoots = new Set(["", ...resolveWorkspaceDirs(root, selectedReaders),
    ...inputs.filter(input => input.kind === "gitlink").map(input => input.path)]);
  for (const dir of [...lockRoots].sort()) {
    const selectedRoot = resolve(root, dir);
    const pathAt = leaf => dir ? `${dir}/${leaf}` : leaf;
    const lockfile = pathAt(files.has(pathAt("npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json");
    const found = findRootLockManifestMismatches(selectedRoot, {
      existsSync: path => files.has(name(path)),
      readJson: path => {
        const selectedPath = name(path);
        try { return JSON.parse(files.get(selectedPath)); }
        catch (error) {
          errors.push({ code: "metadata-unreadable", path: selectedPath, detail: String(error) });
          throw error;
        }
      },
      expandWorkspaces: (patterns, base) => expandWorkspaces(patterns, base, {
        directories: directories.filter(path => !dir || path.startsWith(`${dir}/`))
          .map(path => dir ? path.slice(dir.length + 1) : path),
      }),
    });
    for (const mismatch of found) {
      const manifest = pathAt(mismatch.workspace ? `${mismatch.workspace}/package.json` : "package.json");
      const controllers = inputs.filter(input => input.kind === "gitlink" &&
        [manifest, lockfile].some(path => path.startsWith(`${input.path}/`)));
      mismatches.push({ ...mismatch, code: "workspace-lock-mismatch", lockfile, manifest,
        controllingPaths: [...new Set(controllers.flatMap(input => [input.path, input.gitmodules]))].sort() });
    }
  }
  return { ok: errors.length === 0 && mismatches.length === 0,
    inputs: [...inputs].sort((a, b) => a.path.localeCompare(b.path)), mismatches, errors };
}

/** Preserve the established error prefix for existing install/publication callers. */
export function assertWorkspaceLockInspection(inspection) {
  if (inspection.errors.length) throw new Error(`unreadable dependency metadata: ${JSON.stringify(inspection.errors)}`);
  if (inspection.mismatches.length) throw new Error(formatRootLockManifestMismatches(inspection.mismatches));
}

function formatRootLockManifestMismatches(mismatches) {
  const lines = [
    `NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT: ${mismatches.length} lockfile field(s) disagree with package manifests.`,
    "The guarded operation was not started; stale dependency metadata can crash npm Arborist before it repairs the lock.",
  ];
  for (const mismatch of mismatches.slice(0, 20)) {
    const manifestDir = mismatch.manifest && dirname(mismatch.manifest);
    const workspace = mismatch.workspace || (manifestDir && manifestDir !== "." ? manifestDir : "<root>");
    const location = [
      mismatch.lockfile && `lockfile=${mismatch.lockfile}`,
      mismatch.manifest && `manifest=${mismatch.manifest}`,
      mismatch.controllingPaths?.length && `controllingPaths=${mismatch.controllingPaths.join(", ")}`,
    ].filter(Boolean).join("; ");
    lines.push(
      `  - ${workspace} ${mismatch.field}${location ? ` [${location}]` : ""}: ${JSON.stringify(mismatch.differences)}`,
    );
  }
  if (mismatches.length > 20)
    lines.push(`  - … ${mismatches.length - 20} more mismatch(es)`);
  lines.push(
    mismatches.some(mismatch => mismatch.lockfile)
      ? "FIX: reconcile the named lockfiles with their package manifests and review any listed controlling paths before retrying the guarded operation."
      : "FIX: reconcile the reported workspace dependency maps in package-lock.json with package.json, review the lockfile, then retry the install.",
  );
  return lines.join("\n");
}

/** Reuse install admission for a filesystem or an immutable manifest census.
 * The optional readers also feed the existing workspace expansion seam.
 */
export function assertRootLockManifestMatches(repoRoot = DEFAULT_REPO_ROOT, deps = {}) {
  const mismatches = findRootLockManifestMismatches(repoRoot, deps);
  if (mismatches.length) throw new Error(formatRootLockManifestMismatches(mismatches));
}

function isGuardedTestRunner(commandArgs, repoRoot) {
  const targets = new Set(
    [...LOCK_GUARDED_TEST_RUNNERS].map((path) => resolve(repoRoot, path)),
  );
  return commandArgs.some(
    (arg) => typeof arg === "string" && targets.has(resolve(repoRoot, arg)),
  );
}

/**
 * Verify and repair npm's content-addressed cache before reification. npm's
 * cache verifier removes index entries whose content blobs disappeared, so a
 * stale cacache reference cannot make the install fail with an opaque ENOENT.
 * The caller runs this while holding the same repo-keyed install mutex as the
 * subsequent npm command.
 */
export function verifyNpmCache({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm = spawnSync,
  env = process.env,
} = {}) {
  const result = runNpm("npm", cacheVerifyArgs(npmArgs), {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Default wait for EXCLUSIVE use of the shared package cache before verify is skipped. */
export const NPM_CACHE_VERIFY_WAIT_MS_DEFAULT = 30_000;

/**
 * Run `verify` (npm cache verify) while holding PACKAGE_CACHE_MUTEX_NAME EXCLUSIVELY.
 *
 * `npm cache verify` WRITES the user-level cache that every checkout shares: after its
 * garbage collection, cacache's `cleanTmp` step runs `rm -rf <cache>/tmp`, deleting every
 * download another npm process has staged there and not yet renamed into content-v2.
 * Until WI-10004430 it ran under the shared READ lease, beside other checkouts' reifies
 * (the repo-keyed install mutex cannot serialize different roots), so a verify in one
 * checkout could fail an install in another with
 * `ENOENT rename <cache>/tmp/… -> content-v2/…` — a workspace-host release cut, 2026-09-30.
 *
 * Verify is a repair step, not a precondition. The fs-mutex is writer-preferring, so
 * while this verifier waits, every other checkout's install queues behind it; past
 * `waitMs` it gives up and skips verify (loudly) rather than fail this install or stall
 * the others. Returns verify's exit status, or 0 when it was skipped.
 */
export async function verifyNpmCacheExclusive({
  verify,
  env = process.env,
  waitMs = Number(env.PAPERCUSP_NPM_CACHE_VERIFY_WAIT_MS) > 0
    ? Number(env.PAPERCUSP_NPM_CACHE_VERIFY_WAIT_MS)
    : NPM_CACHE_VERIFY_WAIT_MS_DEFAULT,
  acquire = withFsMutex,
  log = console.error,
} = {}) {
  let entered = false;
  try {
    return await acquire(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        entered = true;
        return verify();
      },
      {
        timeoutMs: waitMs,
        onWaiting: ({ owner, elapsedMs }) => {
          log(
            `NPM_INSTALL_SAFE cache verify waiting for exclusive use of the shared npm cache (${Math.round(elapsedMs / 1000)}s so far) — holder: ${String(owner).trim()}`,
          );
        },
      },
    );
  } catch (error) {
    // A throw from verify itself is real; only a failure to ACQUIRE the lock is skippable.
    if (entered) throw error;
    log(
      `NPM_INSTALL_SAFE_CACHE_VERIFY_SKIPPED: no exclusive use of the shared npm cache within ${waitMs}ms (${error instanceof Error ? error.message : String(error)}); installing without npm cache verify, because verifying now would delete another checkout's in-flight downloads.`,
    );
    return 0;
  }
}

function isStrictlyWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * Convert detector findings into the only paths install:safe may remove before
 * its bounded repair. Both the workspace and package segments are untrusted
 * manifest-derived strings, so validate the repo boundary and the narrower
 * <workspace>/node_modules boundary before returning a target.
 *
 * @param {{ repoRoot?: string, findings?: Array<{ workspace?: unknown, package?: unknown }> }} [options]
 * @returns {string[]}
 */
export function packageLocalRepairTargets({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
} = {}) {
  const root = resolve(repoRoot);
  const targets = findings.map((finding) => {
    if (
      typeof finding?.workspace !== "string" ||
      finding.workspace.length === 0 ||
      typeof finding?.package !== "string" ||
      finding.package.length === 0
    ) {
      throw new Error(
        "refusing package-local repair target without workspace and package names",
      );
    }
    const nodeModulesDir = resolve(root, finding.workspace, "node_modules");
    if (!isStrictlyWithin(root, nodeModulesDir)) {
      throw new Error(
        `refusing package-local repair outside repo root: ${finding.workspace}/node_modules`,
      );
    }
    const target = resolve(nodeModulesDir, finding.package);
    if (!isStrictlyWithin(nodeModulesDir, target)) {
      throw new Error(
        `refusing package-local repair outside workspace node_modules: ${finding.workspace}/node_modules/${finding.package}`,
      );
    }
    return target;
  });
  return [...new Set(targets)].sort();
}

function removePackageLocalRepairTargets({ repoRoot, findings, deps = {} }) {
  const removePath =
    deps.removePath ??
    ((target) => rmSync(target, { recursive: true, force: true }));
  const targets = packageLocalRepairTargets({ repoRoot, findings });
  for (const target of targets) removePath(target);
  return targets;
}

/** Re-extract only a locked package with measured missing content or a failed
 * native exercise. Keep lockfile intent intact. Generic import errors, workspace
 * links, external paths and symlinked parents are not evidence of a damaged
 * installed package.
 */
function runtimeContentRepairFindings({ repoRoot, failures }) {
  const repairableFailures = failures.filter((failure) =>
    (failure.code === 'ERR_MODULE_NOT_FOUND' && isAbsolute(failure.missingPath ?? '')) ||
    (failure.nativeExercise === 'sqlite-memory-query' && isAbsolute(failure.resolvedPath ?? '')));
  if (repairableFailures.length === 0) return [];
  const root = realpathSync(repoRoot);
  const lockPath = existsSync(join(root, 'npm-shrinkwrap.json'))
    ? join(root, 'npm-shrinkwrap.json') : join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return [];
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const findings = [];
  for (const failure of repairableFailures) {
    const nativeFailure = failure.nativeExercise === 'sqlite-memory-query';
    const measuredPath = resolve(nativeFailure ? failure.resolvedPath : failure.missingPath);
    if (!isStrictlyWithin(root, measuredPath) || (!nativeFailure && existsSync(measuredPath))) continue;
    const parts = relative(root, measuredPath).split(sep);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0 || !parts[index + 1]) continue;
    const packageName = nativeFailure
      ? packageNameFromSpecifier(failure.specifier)
      : parts[index + 1].startsWith('@') ? parts.slice(index + 1, index + 3).join('/') : parts[index + 1];
    const packageParts = packageName.split('/');
    if (parts.slice(index + 1, index + 1 + packageParts.length).join('/') !== packageName) continue;
    const packageLength = packageParts.length;
    if (parts.length <= index + 1 + packageLength) continue;
    const key = parts.slice(0, index + 1 + packageLength).join('/');
    const entry = lock.packages?.[key];
    if (!entry?.version || entry.link) continue;
    const target = join(root, key);
    // Validate physical identity before any repair deletion, including ancestors.
    if (!existsSync(target) || realpathSync(target) !== target) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')); } catch { continue; }
    if (manifest.name !== packageName || manifest.version !== entry.version) continue;
    findings.push({ workspace: parts.slice(0, index).join('/') || '.', package: packageName });
  }
  return findings;
}

/**
 * Remove a detector-confirmed stale package-local entry from package-lock.json
 * before npm reifies it again. The on-disk target alone is insufficient: npm
 * treats an orphaned lock entry as install intent even when the workspace's
 * current declaration is satisfied by a hoisted package.
 *
 * Only delete an exact entry whose locked version still matches the invalid
 * installed version, or whose link target matches a detector-confirmed dangling
 * symlink still on disk. Inspect links before removing them: npm can recreate an
 * obsolete workspace link from its lock entry even after its declaration changes.
 * A newer/different lock entry or healthy link must not be removed. The write is atomic so an
 * interrupted repair cannot leave the shared lockfile half-written.
 *
 * @param {{
 *   repoRoot?: string,
 *   findings?: Array<{ workspace?: unknown, package?: unknown, installed?: unknown, declared?: unknown }>,
 *   deps?: { readLock?: () => any, writeLock?: (lock: any) => void },
 * }} [options]
 * @returns {string[]} the package-lock.json `packages` keys that were removed.
 */
export function removePackageLocalRepairLockEntries({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
  deps = {},
} = {}) {
  if (findings.length === 0) return [];

  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const readLock =
    deps.readLock ?? (() => JSON.parse(readFileSync(lockPath, "utf8")));
  const writeLock =
    deps.writeLock ??
    ((lock) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-repair-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, `${JSON.stringify(lock, null, 2)}\n`);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });

  let lock;
  try {
    lock = readLock();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (
    !lock ||
    typeof lock !== "object" ||
    !lock.packages ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages)
  ) {
    throw new Error(
      "refusing package-local repair: package-lock.json has no packages object",
    );
  }

  const removed = [];
  for (const finding of findings) {
    const [target] = packageLocalRepairTargets({
      repoRoot: root,
      findings: [finding],
    });
    const key = relative(root, target).split(sep).join("/");
    const entry = lock.packages[key];
    const staleVersion =
      typeof finding.installed === "string" &&
      typeof entry?.version === "string" &&
      entry.version === finding.installed;
    let staleLink = false;
    if (entry?.link === true && typeof entry.resolved === "string") {
      try {
        staleLink = lstatSync(target).isSymbolicLink() &&
          !existsSync(target) &&
          resolve(root, entry.resolved) === resolve(dirname(target), readlinkSync(target));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!staleVersion && !staleLink) continue;
    delete lock.packages[key];
    removed.push(key);
  }

  if (removed.length > 0) writeLock(lock);
  return removed;
}

/**
 * npm's per-entry dependency-type flags in package-lock.json. They record HOW a
 * package is reachable (only through devDependencies, only through optional
 * edges, through either, as a peer) — never WHICH bytes are installed.
 */
const LOCKFILE_DEP_FLAG_KEYS = new Set(["dev", "optional", "devOptional", "peer"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutLockfileDepFlags(entry) {
  if (!isPlainObject(entry)) return entry;
  const rest = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!LOCKFILE_DEP_FLAG_KEYS.has(key)) rest[key] = value;
  }
  return rest;
}

/**
 * Compare two parsed lockfiles. Returns the `packages` keys whose ONLY
 * difference is npm's dependency-type flags (`[]` = semantically identical), or
 * `null` when ANYTHING else differs: a version, resolved URL or integrity, a
 * dependency edge, an added or removed package, or any top-level field.
 */
export function lockfileDepFlagOnlyChanges(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return null;
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of topKeys) {
    if (key !== "packages" && !isDeepStrictEqual(before[key], after[key]))
      return null;
  }
  const beforePackages = before.packages;
  const afterPackages = after.packages;
  if (!isPlainObject(beforePackages) || !isPlainObject(afterPackages))
    return null;
  const beforeKeys = Object.keys(beforePackages);
  if (beforeKeys.length !== Object.keys(afterPackages).length) return null;
  const changed = [];
  for (const key of beforeKeys) {
    if (!Object.hasOwn(afterPackages, key)) return null;
    const was = beforePackages[key];
    const now = afterPackages[key];
    if (isDeepStrictEqual(was, now)) continue;
    if (
      !isDeepStrictEqual(withoutLockfileDepFlags(was), withoutLockfileDepFlags(now))
    )
      return null;
    changed.push(key);
  }
  return changed;
}

/** The root package-lock.json text, or `undefined` when there is none. */
export function readLockfileText(repoRoot = DEFAULT_REPO_ROOT, deps = {}) {
  const lockPath = join(resolve(repoRoot), "package-lock.json");
  const readText = deps.readText ?? (() => readFileSync(lockPath, "utf8"));
  try {
    return readText();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * WI-10003114: undo a workspace-scoped command's lockfile rewrite when it changed
 * nothing but npm's dependency-type flags.
 *
 * `npm install --workspace=A --workspace=B` recomputes dev/optional/devOptional
 * for the WHOLE lockfile, but it does so without seeing the whole workspace graph.
 * An unscoped install writes one set of flags and a scoped install writes another,
 * so the committed lockfile flips between them depending on which ran last.
 * Measured 2026-09-29: an unscoped shared-tree install flipped 196 entries
 * dev -> devOptional. The desktop sidecar build's scoped installs then flipped
 * them back inside the exact-SHA live-certification checkout. Every certification
 * of green main 93f1c720 went RED `certification-source-dirty-at-build-end`
 * (dirty file: package-lock.json only) even though every functional leg passed.
 *
 * Restoring those bytes cannot change what is installed: the rewrite touched no
 * version, URL, integrity or dependency edge (a formatting-only rewrite is
 * restored for the same reason). A substantive rewrite (a new dependency, a
 * version bump, a removed package) is left exactly as npm wrote it. Unscoped
 * installs are never touched: they are the writer that sees the whole graph.
 */
export function restoreScopedFlagOnlyLockfileRewrite({
  repoRoot = DEFAULT_REPO_ROOT,
  beforeText,
  deps = {},
} = {}) {
  if (typeof beforeText !== "string")
    return { restored: false, reason: "no-lockfile-before", entries: [] };
  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const afterText = readLockfileText(root, deps);
  if (afterText === undefined)
    return { restored: false, reason: "lockfile-removed", entries: [] };
  if (afterText === beforeText)
    return { restored: false, reason: "unchanged", entries: [] };
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return { restored: false, reason: "unparseable", entries: [] };
  }
  const changed = lockfileDepFlagOnlyChanges(before, after);
  if (changed === null)
    return { restored: false, reason: "substantive-change", entries: [] };
  const writeText =
    deps.writeText ??
    ((text) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-flag-restore-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, text);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });
  writeText(beforeText);
  return {
    restored: true,
    reason: changed.length === 0 ? "formatting-only" : "dep-flags-only",
    entries: changed,
  };
}

/**
 * Verify (post-install, still holding the lock) that dependency directories and
 * critical runtime contents actually landed on disk; repair once if not.
 *
 * @param {{
 *   repoRoot?: string,
 *   npmArgs?: string[],
 *   runNpm?: (args: string[]) => number,
 *   probeSpecifiers?: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   deps?: Record<string, any>,
 * }} [options] `probeSpecifiers` and `deps` are forwarded unchanged to the detectors in
 *   scripts/check-declared-deps-extracted.mjs, which define their shapes.
 * @returns {Promise<0|1>} 0 = healthy (possibly after repair), 1 = still broken.
 */
export async function verifyDepsExtracted({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm,
  probeSpecifiers,
  env = process.env,
  deps = {},
} = {}) {
  const runRepair =
    runNpm ??
    ((args, options = {}) =>
      runNpmWithHeartbeat({
        phase: "repair",
        args,
        ...options,
      }));

  const { workspaceDirs, repairWorkspaceArgs } = verificationScopeForNpmArgs({
    repoRoot,
    npmArgs,
    deps,
  });
  const allWorkspaceDirs = resolveWorkspaceDirs(repoRoot, deps);
  const auditNestedWorkspaceLockTrees = (rootLock) => allWorkspaceDirs.flatMap((workspace) => {
    // Reuse the publisher's ownership decision. npm reifies this member from
    // the enclosing lock, not its potentially obsolete standalone lock graph.
    if (enclosingWorkspaceOwner(workspace, [{ dir: "", lock: rootLock }]) !== null) return [];
    const workspacePath = resolve(repoRoot, workspace);
    let realWorkspacePath;
    try {
      realWorkspacePath = realpathSync(workspacePath);
      if (!isStrictlyWithin(realpathSync(repoRoot), realWorkspacePath)) return [];
    } catch {
      return [];
    }
    const shrinkwrapPath = join(realWorkspacePath, "npm-shrinkwrap.json");
    const lockPath = existsSync(shrinkwrapPath)
      ? shrinkwrapPath
      : join(realWorkspacePath, "package-lock.json");
    if (!existsSync(lockPath)) return [];
    // Match the publisher's input census: an ignored, untracked member lock
    // is install residue, not an independently pinned install. Reifying it
    // with ci can reject current manifests or reinstall obsolete dependencies.
    // Run from the member so a submodule answers for its own tracked files.
    if (existsSync(join(repoRoot, ".git")) && spawnSync("git", [
      "check-ignore", "-q", "--", lockPath,
    ], { cwd: realWorkspacePath, stdio: "ignore" }).status === 0) return [];
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const audit = auditLockfile({ lock, lockDir: workspace, treeRoot: repoRoot });
    if (!audit.installed || audit.defects.length === 0) return [];
    return [{ workspace, entries: audit.entries, defects: audit.defects }];
  });
  const inspect = async () => {
    // A scoped reify can leave another workspace's old, resolvable hoisting in
    // place after manifest-only resolution changed the root lock's topology.
    // Publication copies the whole tree, so resolving declared dependencies is
    // insufficient: use the publisher's exact-path detector before copying it.
    const lockPath = existsSync(join(repoRoot, "npm-shrinkwrap.json"))
      ? join(repoRoot, "npm-shrinkwrap.json")
      : join(repoRoot, "package-lock.json");
    const rootLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
    const lockTreeDefects = rootLock
      ? auditLockfile({
          lock: rootLock,
          lockDir: "",
          treeRoot: repoRoot,
        }).defects
      : [];
    const nestedLockTrees = auditNestedWorkspaceLockTrees(rootLock);
    const declared = await findUnextractedDepsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageLocal = await findIncompleteWorkspacePackagesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageVersions = await findInvalidWorkspacePackageVersionsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const unsatisfiedRanges = await findUnsatisfiedDeclaredDepRangesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    if (
      declared.missing.length > 0 ||
      packageLocal.incomplete.length > 0 ||
      packageVersions.invalid.length > 0 ||
      unsatisfiedRanges.invalid.length > 0
    )
      return {
        lockTreeDefects,
        nestedLockTrees,
        missing: declared.missing,
        incomplete: packageLocal.incomplete,
        invalidVersions: packageVersions.invalid,
        unsatisfiedRanges: unsatisfiedRanges.invalid,
        runtimeFailures: [],
        brokenBinLinks: findBrokenBinLinks(repoRoot, { workspaceDirs }),
      };
    const runtime = await findUnusableRuntimeDepsWithRetry({
      repoRoot,
      probeSpecifiers,
      deps,
    });
    return {
      lockTreeDefects,
      nestedLockTrees,
      missing: [],
      incomplete: [],
      invalidVersions: [],
      unsatisfiedRanges: [],
      runtimeFailures: runtime.failures,
      brokenBinLinks: findBrokenBinLinks(repoRoot, { workspaceDirs }),
    };
  };

  const report = ({
    lockTreeDefects,
    nestedLockTrees,
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
    brokenBinLinks,
  }) => {
    for (const defect of lockTreeDefects)
      console.error(`NPM_INSTALL_SAFE lock-tree ${defect.kind}: ${defect.path} (${defect.detail})`);
    for (const tree of nestedLockTrees)
      for (const defect of tree.defects)
        console.error(`NPM_INSTALL_SAFE nested-lock-tree ${defect.kind}: ${defect.path} (${defect.detail})`);
    if (missing.length > 0) console.error(formatMissing(missing));
    if (incomplete.length > 0)
      console.error(formatIncompleteWorkspacePackages(incomplete));
    if (invalidVersions.length > 0)
      console.error(formatInvalidWorkspacePackageVersions(invalidVersions));
    if (unsatisfiedRanges.length > 0)
      console.error(formatUnsatisfiedDeclaredDepRanges(unsatisfiedRanges));
    if (runtimeFailures.length > 0)
      console.error(formatRuntimeFailures(runtimeFailures));
    for (const finding of brokenBinLinks)
      console.error(`NPM_INSTALL_SAFE dangling executable link: ${finding.workspace}/node_modules/${finding.pkg}`);
  };

  const healthy = ({
    lockTreeDefects,
    nestedLockTrees,
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
    brokenBinLinks,
  }) =>
    lockTreeDefects.length === 0 &&
    nestedLockTrees.length === 0 &&
    missing.length === 0 &&
    incomplete.length === 0 &&
    invalidVersions.length === 0 &&
    unsatisfiedRanges.length === 0 &&
    runtimeFailures.length === 0 &&
    brokenBinLinks.length === 0;

  // Scoped npm reify/repair can replace native packages without running the
  // root postinstall. Imports still work, but a fresh database then fails its
  // first VECTOR column. Reuse the postinstall provisioner before accepting
  // either healthy dependency path, while the install writer is still held.
  const verifyNativeExtensions = () => {
    const extensions = installEmbeddedExtensions({ root: repoRoot, env });
    for (const missing of extensions.missingSource) console.error(missingWarning(missing));
    const required = new Set(EMBEDDED_EXTENSIONS.filter(extension => extension.required).map(extension => extension.name));
    const unavailable = extensions.trees.filter(tree => required.has(tree.extension) &&
      !["present", "installed", "updated"].includes(tree.status));
    if (unavailable.length > 0) {
      console.error("NPM_INSTALL_SAFE_FATAL: required embedded Postgres extensions are unavailable: " +
        unavailable.map(tree => `${tree.location} (${tree.extension}: ${tree.status})`).join(", "));
      return 1;
    }
    return 0;
  };

  const first = await inspect();
  if (healthy(first)) {
    if (verifyNativeExtensions() !== 0) return 1;
    return restoreInstalledPatchPostimages({ repoRoot, env });
  }

  report(first);
  // A prefix reifies an independent package tree. Keep the full-root verdict,
  // but never turn its failure into a root install or root-lock mutation.
  // The caller must repair the explicitly selected tree before retrying.
  if (npmArgs.some((arg) => arg === "--prefix" || arg.startsWith("--prefix="))) {
    console.error(
      "NPM_INSTALL_SAFE_FATAL: explicit-prefix install failed full-root verification; refusing to broaden repair to the repository root.",
    );
    return 1;
  }
  const runtimeFindings = first.runtimeFailures.length > 0
    ? runtimeContentRepairFindings({ repoRoot, failures: first.runtimeFailures }) : [];
  // Validate every parent before modifying any detected link or its local owner.
  // unlink removes only the link; it cannot recursively delete its target.
  const binTargets = first.brokenBinLinks.map((finding) => {
    const [target] = packageLocalRepairTargets({
      repoRoot,
      findings: [{ workspace: finding.workspace === '<root>' ? '.' : finding.workspace, package: finding.pkg }],
    });
    if (!isStrictlyWithin(realpathSync(repoRoot), realpathSync(dirname(target))))
      throw new Error(`refusing executable-link repair outside repo root: ${target}`);
    return target;
  });
  const binPackageFindings = first.brokenBinLinks
    .filter((finding) => finding.package)
    .map((finding) => ({ workspace: finding.workspace === '<root>' ? '.' : finding.workspace, package: finding.package }));
  // A scoped package's parent can itself be a symlink. Validate the physical
  // parent before recursive removal, as well as the .bin parent before unlink.
  for (const target of packageLocalRepairTargets({ repoRoot, findings: binPackageFindings })) {
    if (!isStrictlyWithin(realpathSync(repoRoot), realpathSync(dirname(target))))
      throw new Error(`refusing executable-package repair outside repo root: ${target}`);
  }
  for (const target of binTargets) {
    if (lstatSync(target).isSymbolicLink() && !existsSync(target)) unlinkSync(target);
  }
  // Compare the locked link with the observed symlink before deleting the node.
  const removedLockEntries = removePackageLocalRepairLockEntries({
    repoRoot,
    findings: [...first.incomplete, ...first.invalidVersions],
    deps,
  });
  const removedTargets = removePackageLocalRepairTargets({
    repoRoot,
    findings: [...first.incomplete, ...first.invalidVersions, ...binPackageFindings, ...runtimeFindings],
    deps,
  });
  if (removedTargets.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedTargets.length} invalid package-local node${removedTargets.length === 1 ? "" : "s"} before repair:\n${removedTargets
        .map((target) => `  - ${relative(repoRoot, target)}`)
        .join("\n")}`,
    );
  }
  if (removedLockEntries.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedLockEntries.length} stale package-lock entr${removedLockEntries.length === 1 ? "y" : "ies"} before repair:\n${removedLockEntries
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
    );
  }
  // The root lock owns every workspace's installed paths. A repair scoped to
  // the originally selected workspace cannot repair drift elsewhere in it.
  // The repair must keep the install's dev-dependency selection: a bare
  // `npm install` under NODE_ENV=production prunes every devDependency, so a
  // repair that dropped it deleted the very toolchain it was repairing
  // (WI-6554700010029990).
  const needsRootRepair =
    first.lockTreeDefects.length > 0 ||
    first.missing.length > 0 ||
    first.incomplete.length > 0 ||
    first.invalidVersions.length > 0 ||
    first.unsatisfiedRanges.length > 0 ||
    first.runtimeFailures.length > 0 ||
    first.brokenBinLinks.length > 0;
  if (needsRootRepair) {
    const repairArgs = isolateNestedProjectInstallArgs(repoRoot, developmentInstallArgs(repoRoot, [
      ...REPAIR_ARGS,
      ...(first.lockTreeDefects.length > 0 || runtimeFindings.length > 0 ? [] : repairWorkspaceArgs),
      ...dependencySelectionArgs(npmArgs),
    ]));
    console.error(
      `NPM_INSTALL_SAFE repairing: npm ${repairArgs.join(" ")} (one bounded attempt, still holding the lock)`,
    );
    const repairStatus = await runRepair(
      repairArgs,
      {
        cwd: repoRoot,
        stdio: "inherit",
        env,
      },
    ) ?? 1;
    if (repairStatus !== 0) {
      console.error(
        `NPM_INSTALL_SAFE_FATAL: repair npm exited ${repairStatus}; dependency integrity is unverified.`,
      );
      return 1;
    }
  }

  // The enclosing npm workspace install owns hoisted dependencies, but a
  // workspace with its own lockfile can also be published as an isolated tree.
  // Reify that already-installed local tree explicitly after the root repair;
  // --workspaces=false keeps npm on the workspace's own lockfile.
  for (const tree of first.nestedLockTrees) {
    const workspaceRoot = resolve(repoRoot, tree.workspace);
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    if (!isStrictlyWithin(realpathSync(repoRoot), realWorkspaceRoot)) {
      throw new Error(`refusing nested workspace lock repair outside repo root: ${workspaceRoot}`);
    }
    const repairArgs = developmentInstallArgs(realWorkspaceRoot, [
      "ci",
      "--legacy-peer-deps",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
      ...dependencySelectionArgs(npmArgs),
    ]);
    console.error(
      `NPM_INSTALL_SAFE repairing nested workspace lock tree: npm ${repairArgs.join(" ")} (workspace=${tree.workspace}, still holding the root lock)`,
    );
    const repairStatus = await runRepair(repairArgs, {
      cwd: realWorkspaceRoot,
      stdio: "inherit",
      env,
    }) ?? 1;
    if (repairStatus !== 0) {
      console.error(
        `NPM_INSTALL_SAFE_FATAL: nested workspace repair exited ${repairStatus} for ${tree.workspace}; dependency integrity is unverified.`,
      );
      return 1;
    }
  }

  const second = await inspect();
  if (healthy(second)) {
    if (verifyNativeExtensions() !== 0) return 1;
    if (await restoreInstalledPatchPostimages({ repoRoot, env }) !== 0) return 1;
    console.log(
      "NPM_INSTALL_SAFE repaired: dependency directories, package-local manifests and versions, executable links, and critical runtime imports are healthy",
    );
    return 0;
  }
  report(second);
  console.error(
    'NPM_INSTALL_SAFE_FATAL: dependencies are STILL incomplete after a repair install — this is not a race. Do not treat a downstream "cannot find module" as a code bug until this is clear.',
  );
  return 1;
}

/** Restore the root's committed patches after reify, while the install writer is held. */
export async function restoreInstalledPatchPostimages({ repoRoot, env = process.env } = {}) {
  if (!existsSync(join(repoRoot, "patches"))) return 0;
  const { checkInstalledPatchPostimages } = await import("./check-installed-patch-postimages.mjs");
  const check = (sourcesOnly = false) => checkInstalledPatchPostimages({ repoRoot, sourcesOnly });
  const initial = check();
  if (initial.ok) return 0;

  // Reuse the committed-input validator before executing patch-package: a
  // dirty, untracked or malformed patch must never become a repair input.
  const sources = check(true);
  if (!sources.ok) {
    console.error("NPM_INSTALL_SAFE_FATAL: committed patch sources are unverified: " + sources.errors.join("\n"));
    return 1;
  }
  const runner = join(repoRoot, "node_modules", "patch-package", "index.js");
  if (!existsSync(runner)) {
    console.error("NPM_INSTALL_SAFE_FATAL: local patch-package is missing; committed patches cannot be restored after reify.");
    return 1;
  }
  // Execute only the existing local patch tool, without npm lifecycle hooks or
  // a package-runner download. Publication still verifies the exact postimages.
  console.error("NPM_INSTALL_SAFE restoring committed package patches after reify (install writer held)");
  const result = spawnSync(process.execPath, [runner, "--error-on-fail"], {
    cwd: repoRoot, stdio: "inherit", env,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error("NPM_INSTALL_SAFE_FATAL: committed patch restoration failed: " +
      (result.error?.message ?? result.signal ?? result.status));
    return 1;
  }
  const restored = check();
  if (!restored.ok) {
    console.error("NPM_INSTALL_SAFE_FATAL: restored patch postimages are unverified: " + restored.errors.join("\n"));
    return 1;
  }
  return 0;
}

export function repoLockName(repoRoot = DEFAULT_REPO_ROOT) {
  // The derivation lives in scripts/lib/install-lock-name.mjs so runtime code
  // (headless agent launches, WI-10005137) can wait on the SAME lock without
  // importing this CLI module.
  return installLockNameForRoot(repoRoot);
}

/**
 * Hold a shared host-wide cache lease while a package manager may read/write
 * its global cache. Independent safe installs remain concurrent (reader +
 * reader); the scheduled package-cache janitor takes the matching writer lease
 * before native cleanup. This is deliberately separate from the repo-scoped
 * install writer, because staging/release/checkpoint have different realpaths
 * while sharing the same user-level caches.
 */
export function withPackageCacheReadLease(fn, opts = {}) {
  return withFsMutexRead(PACKAGE_CACHE_MUTEX_NAME, fn, opts);
}

const NPM_HEARTBEAT_INTERVAL_MS = 30_000;
const INSTALL_VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "--prefix",
  "--cache",
  "--registry",
  "--tag",
  "--access",
  "--save-prefix",
  "--install-strategy",
  "--include",
  "--omit",
  "--platform",
  "--arch",
  "--cpu",
  "--os",
  "--libc",
  "--userconfig",
  "--globalconfig",
  "--loglevel",
  "--fetch-retries",
  "--fetch-retry-factor",
  "--fetch-retry-mintimeout",
  "--fetch-retry-maxtimeout",
  "--fetch-timeout",
  "--maxsockets",
  "--script-shell",
  "--lockfile-version",
  "--node-options",
  "--proxy",
  "--https-proxy",
  "--save-type",
  "--audit-level",
]);
const INSTALL_BOOLEAN_FLAGS = new Set([
  "--save",
  "--no-save",
  "--save-dev",
  "-D",
  "--save-optional",
  "-O",
  "--save-prod",
  "-P",
  "--save-peer",
  "--save-exact",
  "-E",
  "--save-bundle",
  "-B",
  "--package-lock",
  "--package-lock-only",
  "--ignore-scripts",
  "--foreground-scripts",
  "--audit",
  "--no-audit",
  "--fund",
  "--no-fund",
  "--dry-run",
  "--force",
  "-f",
  "--legacy-peer-deps",
  "--strict-peer-deps",
  "--prefer-dedupe",
  "--workspaces",
  "--no-workspaces",
  "--include-workspace-root",
  "--install-links",
  "--no-install-links",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--global",
  "-g",
  "--global-style",
  "--no-bin-links",
  "--bin-links",
  "--optional",
  "--no-optional",
  "--production",
  "--json",
  "--silent",
  "--quiet",
  "--verbose",
  "--timing",
]);

/** Read the npm process RSS on Linux; other platforms report an unknown value. */
export function readChildRssBytes(pid, platform = process.platform) {
  if (platform !== "linux" || !Number.isSafeInteger(pid)) return null;
  try {
    const status = readFileSync("/proc/" + pid + "/status", "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Capture the bounded identity tuple used to attribute a dependency-path
 * transition. The probe is observational: missing paths are represented as
 * not-observed instead of being treated as a publisher defect.
 */
export function writerAttributionSnapshot({
  repoRoot = DEFAULT_REPO_ROOT,
  nestedPath,
  invocationId = null,
  lockName = null,
  childPid = null,
  phase = null,
  ownerPid = process.pid,
  now = () => new Date().toISOString(),
} = {}) {
  const absolute = nestedPath && isAbsolute(nestedPath)
    ? nestedPath
    : nestedPath ? resolve(repoRoot, nestedPath) : null;
  const packageLock = join(repoRoot, "package-lock.json");
  let canonicalRepoRoot = null;
  try {
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    // A failed probe must not change the install result.
  }
  const stat = (path) => {
    if (!path) return { status: "not-observed", reason: "path-not-configured" };
    try {
      const value = lstatSync(path);
      return {
        status: "observed",
        type: value.isDirectory() ? "directory" : value.isFile() ? "file" : "other",
        dev: value.dev,
        ino: value.ino,
        size: value.size,
        mtimeMs: value.mtimeMs,
        ctimeMs: value.ctimeMs,
      };
    } catch (error) {
      return {
        status: "not-observed",
        reason: error?.code === "ENOENT" ? "absent" : "probe-failed",
      };
    }
  };
  const digest = (() => {
    try {
      return {
        status: "observed",
        sha256: createHash("sha256").update(readFileSync(packageLock)).digest("hex"),
      };
    } catch (error) {
      return {
        status: "not-observed",
        reason: error?.code === "ENOENT" ? "absent" : "probe-failed",
      };
    }
  })();
  return {
    observedAt: now(),
    invocationId,
    repoRoot: canonicalRepoRoot,
    repoRootStatus: canonicalRepoRoot ? "observed" : "not-observed",
    lockName,
    owner: {
      pid: ownerPid,
      processStartIdentity: processIdentityForAttribution(ownerPid) ?? {
        status: "not-observed",
        reason: "process-identity-unavailable",
      },
    },
    childPid,
    phase,
    nestedPath: absolute,
    nestedPathStat: stat(absolute),
    packageJsonStat: stat(absolute ? join(absolute, "package.json") : null),
    rootPackageLockSha256: digest,
  };
}

function processIdentityForAttribution(pid) {
  if (!Number.isSafeInteger(pid) || process.platform !== "linux") return null;
  try {
    const value = readFileSync("/proc/" + pid + "/stat", "utf8");
    const startTicks = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { startTicks, bootId };
  } catch {
    return null;
  }
}

/** A path transition is temporal evidence; a shared reader cannot identify its writer. */
export function writerAttributionRecord({ before, after, ...details }) {
  const first = before?.nestedPathStat;
  const last = after?.nestedPathStat;
  const pathTransition = first?.status === "observed" && last?.reason === "absent"
    ? "disappeared-during-phase"
    : first?.reason === "absent"
      ? "initially-absent"
      : first?.status === "observed" && last?.status === "observed"
        ? "present-after-phase"
        : "not-observed";
  const writerInference = pathTransition !== "disappeared-during-phase"
    ? "none"
    : details.lockMode === "writer"
      ? "candidate-writer-window"
      : "unattributed-shared-or-unlocked-window";
  return { ...details, before, after, pathTransition, writerInference };
}

/** Include wrapper repair and verification work that runs between npm children. */
export async function withWriterAttribution({
  repoRoot,
  nestedPath,
  invocationId,
  lockName,
  lockMode = "writer",
  phase,
  childPid = null,
  log = (line) => console.error(line),
}, action) {
  const base = { repoRoot, nestedPath, invocationId, lockName, phase,
    lockMode, ownerPid: process.pid,
    childPid: typeof childPid === "function" ? childPid(null) : childPid };
  const before = writerAttributionSnapshot(base);
  let status = null;
  let error = null;
  try {
    status = await action();
    return status;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    const finalChildPid = typeof childPid === "function" ? childPid(status) : childPid;
    const after = writerAttributionSnapshot({ ...base, childPid: finalChildPid });
    log("NPM_INSTALL_SAFE attribution=" + JSON.stringify(writerAttributionRecord({
      ...base,
      childPid: finalChildPid,
      exitCode: typeof status === "number" ? status : status?.status ?? null,
      error: error ? String(error?.code ?? error?.message ?? error) : null,
      before,
      after,
    })));
  }
}

/** Spawn npm asynchronously so long resolve/reify/repair phases stay observable. */
export function runNpmWithHeartbeat({
  phase,
  args,
  cwd = DEFAULT_REPO_ROOT,
  env = process.env,
  spawnCommand = spawn,
  heartbeatIntervalMs = NPM_HEARTBEAT_INTERVAL_MS,
  readRssBytes = readChildRssBytes,
  log = (line) => console.error(line),
  now = Date.now,
  attribution = null,
} = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = now();
    const envAttribution = !attribution && env.PAPERCUSP_INSTALL_ATTRIBUTION_ID
      ? {
          invocationId: env.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
          repoRoot: env.PAPERCUSP_INSTALL_ATTRIBUTION_REPO ?? cwd,
          nestedPath: env.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
          lockName: env.PAPERCUSP_INSTALL_ATTRIBUTION_LOCK ?? null,
        }
      : null;
    const attributionBase = attribution || envAttribution
      ? {
          ...(attribution || envAttribution),
          phase,
          lockMode: phase === "resolve" ? "none" : "writer",
          ownerPid: process.pid,
        }
      : null;
    const attributionBefore = attributionBase
      ? writerAttributionSnapshot({ ...attributionBase, childPid: null })
      : null;
    const child = spawnCommand("npm", args, {
      cwd,
      stdio: "inherit",
      env,
    });
    let settled = false;
    let timer;
    const finish = () => {
      if (timer) clearInterval(timer);
    };
    const heartbeat = () => {
      let rssBytes = null;
      try {
        rssBytes = readRssBytes(child.pid);
      } catch {
        rssBytes = null;
      }
      const rssMb =
        rssBytes == null ? "unknown" : (rssBytes / (1024 * 1024)).toFixed(1);
      log(
        "NPM_INSTALL_SAFE phase=" + phase +
          " heartbeat elapsedMs=" + Math.max(0, now() - startedAt) +
          " childPid=" + (child.pid ?? "unknown") +
          " childRssMb=" + rssMb,
      );
    };
    log(
      "NPM_INSTALL_SAFE phase=" + phase +
        " started childPid=" + (child.pid ?? "unknown") +
        " args=npm " + args.join(" ") +
        " (cwd=" + cwd + ")",
    );
    const recordAttribution = ({ code, signal, error }) => {
      if (!attributionBase) return;
      const childPid = child.pid ?? null;
      const attributionAfter = writerAttributionSnapshot({
        ...attributionBase,
        childPid,
      });
      log("NPM_INSTALL_SAFE attribution=" + JSON.stringify(writerAttributionRecord({
        ...attributionBase,
        childPid,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(now()).toISOString(),
        exitCode: code ?? null,
        signal: signal ?? null,
        error: error ? String(error?.code ?? error?.message ?? error) : null,
        before: attributionBefore,
        after: attributionAfter,
      })));
    };
    if (heartbeatIntervalMs > 0) {
      timer = setInterval(heartbeat, heartbeatIntervalMs);
      timer.unref?.();
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      recordAttribution({ error });
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      finish();
      log(
        "NPM_INSTALL_SAFE phase=" + phase +
          " finished elapsedMs=" + Math.max(0, now() - startedAt) +
          " exitCode=" + (code ?? "unknown") +
          " signal=" + (signal ?? "none"),
      );
      recordAttribution({ code, signal });
      resolveResult(code ?? 1);
    });
  });
}

function splitInstallPackageSpecs(npmArgs) {
  if (!Array.isArray(npmArgs) || npmArgs[0] !== "install") return null;
  const reifyArgs = [npmArgs[0]];
  const packageSpecs = [];
  for (let index = 1; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--" || arg === "-") return null;
    if (!arg.startsWith("-")) {
      packageSpecs.push(arg);
      continue;
    }
    reifyArgs.push(arg);
    if (arg.includes("=")) continue;
    if (INSTALL_VALUE_FLAGS.has(arg)) {
      const value = npmArgs[index + 1];
      if (typeof value !== "string" || value.startsWith("-")) return null;
      reifyArgs.push(value);
      index += 1;
      continue;
    }
    if (
      !INSTALL_BOOLEAN_FLAGS.has(arg) &&
      typeof npmArgs[index + 1] === "string" &&
      !npmArgs[index + 1].startsWith("-")
    )
      return null;
  }
  return { reifyArgs, packageSpecs };
}

function npmBooleanArg(npmArgs, option) {
  let value;
  const negative = "--no-" + option.slice(2);
  for (const arg of npmArgs) {
    if (arg === option) value = true;
    else if (arg === negative) value = false;
    else if (arg.startsWith(option + "=")) {
      const rawValue = arg.slice(option.length + 1).toLowerCase();
      value = !["false", "0", "no"].includes(rawValue);
    }
  }
  return value;
}

function npmConfigValue(env, name) {
  return env["npm_config_" + name] ?? env["NPM_CONFIG_" + name.toUpperCase()];
}

function isFalseConfig(value) {
  return typeof value === "string" &&
    ["false", "0", "no"].includes(value.toLowerCase());
}

function isPackageLockOnlyInstall(npmArgs, env) {
  return npmBooleanArg(npmArgs, "--package-lock-only") === true ||
    ["true", "1", "yes"].includes(
      String(npmConfigValue(env, "package_lock_only") ?? "").toLowerCase(),
    );
}

/** Refuse an unusable source archive before resolving, draining readers or reifying. */
export function assertPatchPostimageGitSource({ repoRoot, npmArgs, env = process.env }) {
  if (isPackageLockOnlyInstall(npmArgs, env)) return;
  for (const option of ["ignore-scripts", "dry-run"]) {
    const configured = ["true", "1", "yes"].includes(
      String(npmConfigValue(env, option.replaceAll("-", "_")) ?? "").toLowerCase(),
    );
    if (npmBooleanArg(npmArgs, "--" + option) ?? configured) return;
  }
  const manifestPath = join(repoRoot, "package.json");
  if (!existsSync(manifestPath)) return;
  const postinstall = JSON.parse(readFileSync(manifestPath, "utf8")).scripts?.postinstall;
  if (typeof postinstall !== "string" ||
      !postinstall.includes("scripts/check-installed-patch-postimages.mjs")) return;

  const gitOptions = { cwd: repoRoot, encoding: "utf8", timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"] };
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], gitOptions);
  const head = root.status === 0 && root.stdout.trim() === realpathSync(repoRoot)
    ? spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], gitOptions)
    : null;
  if (head?.status === 0) return;
  throw new Error(
    "NPM_INSTALL_SAFE_GIT_SOURCE_REQUIRED: postinstall verifies committed patch postimages " +
      "and requires this repository's own Git HEAD. A source-only archive cannot run this lifecycle. " +
      "Use scripts/source-preview.mjs verifier-prepare --git-checkout in a supported temporary " +
      "directory before installing dependencies (root=" + repoRoot + ").",
  );
}

function isLocalOrRemotePackageSpec(spec) {
  const unsupportedTarget =
    /^(?:file:|git(?:\+|:)|github:|gitlab:|bitbucket:|https?:|ssh:|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]{1,2})/i;
  const separator = spec.startsWith("@")
    ? spec.indexOf("@", spec.indexOf("/") + 1)
    : spec.indexOf("@");
  const target = separator < 0 ? spec : spec.slice(separator + 1);
  const githubShortcut = /^[^/@\s]+\/[^/\s]+(?:#.*)?$/;
  return unsupportedTarget.test(target) || githubShortcut.test(target);
}

function manifestOnlyInstallPlan(npmArgs, env) {
  if (!Array.isArray(npmArgs) || npmArgs[0] !== "install")
    return { eligible: false };
  const split = splitInstallPackageSpecs(npmArgs);
  if (!split)
    return {
      eligible: false,
      reason: "npm options cannot be separated from package targets safely",
    };
  if (split.packageSpecs.some(isLocalOrRemotePackageSpec))
    return {
      eligible: false,
      reason: "a command-line package target is local or remote",
    };
  const redirectedOrNoSave =
    npmArgs.some((arg) =>
      ["--global", "-g", "--dry-run", "--no-package-lock", "--no-save"].includes(arg) ||
      arg === "--package-lock=false" ||
      arg === "--save=false" ||
      arg === "--prefix" ||
      arg.startsWith("--prefix="),
    ) ||
    isFalseConfig(npmConfigValue(env, "package_lock")) ||
    isFalseConfig(npmConfigValue(env, "save")) ||
    ["true", "1", "yes"].includes(
      String(npmConfigValue(env, "global") ?? "").toLowerCase(),
    ) ||
    Boolean(npmConfigValue(env, "prefix"));
  if (redirectedOrNoSave)
    return {
      eligible: false,
      reason: "the invocation disables or redirects manifest or lockfile writes",
    };
  const packageLockOnly = isPackageLockOnlyInstall(npmArgs, env);
  return {
    eligible: true,
    packageLockOnly,
    reifyArgs: split.reifyArgs,
    resolverArgs: [
      ...npmArgs,
      "--package-lock-only=true",
      "--ignore-scripts=true",
    ],
  };
}

function toRepoRelativePath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function manifestOnlyResolutionLayout(repoRoot) {
  // Verification deliberately excludes foreign hives, but npm still expands
  // their root workspace globs. Omitting those manifests from the scratch tree
  // deletes their lock entries and can detach links when npm reroots actual
  // nodes during a scoped reify. Resolve the full npm population; unsupported
  // dependencies in any workspace must take the existing locked fallback.
  let rootManifest = {};
  try {
    rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    // npm also supports installs in an empty directory. An unreadable existing
    // manifest belongs to npm's normal diagnostic path, not scratch resolution.
    if (error?.code !== "ENOENT")
      return { supported: false, reason: "cannot parse package.json" };
  }
  const workspaceGlobs = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const workspaceDirs = expandWorkspaces(workspaceGlobs, repoRoot).sort();
  const workspaceManifestPaths = workspaceDirs.map((dir) => dir + "/package.json");
  const outputPaths = [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    ...workspaceManifestPaths,
  ];
  const inputPaths = new Set([...outputPaths, ".npmrc"]);
  const pending = ["package.json", ...workspaceManifestPaths];
  const inspected = new Set();
  while (pending.length > 0) {
    const manifestPath = pending.shift();
    if (inspected.has(manifestPath)) continue;
    inspected.add(manifestPath);
    const absolutePath = join(repoRoot, manifestPath);
    if (!existsSync(absolutePath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch {
      return { supported: false, reason: "cannot parse " + manifestPath };
    }
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const spec of Object.values(manifest?.[section] ?? {})) {
        if (typeof spec !== "string") continue;
        if (/^(?:git\+|github:|gitlab:|bitbucket:)/i.test(spec))
          return {
            supported: false,
            reason: "git dependency in " + manifestPath,
          };
        if (!spec.startsWith("file:")) continue;
        const targetPath = resolve(
          dirname(absolutePath),
          spec.slice("file:".length),
        );
        if (!isStrictlyWithin(repoRoot, targetPath))
          return {
            supported: false,
            reason: "file dependency leaves the repository in " + manifestPath,
          };
        // npm also accepts packed local dependencies. Copy their opaque bytes
        // into the resolver snapshot; an archive is not a package directory.
        if (/\.(?:tgz|tar\.gz)$/i.test(targetPath) && existsSync(targetPath) && lstatSync(targetPath).isFile()) {
          inputPaths.add(toRepoRelativePath(repoRoot, targetPath));
          continue;
        }
        const targetManifest = join(targetPath, "package.json");
        if (!existsSync(targetManifest))
          return {
            supported: false,
            reason: "file dependency has no package manifest in " + manifestPath,
          };
        const targetRelative = toRepoRelativePath(repoRoot, targetManifest);
        if (!inputPaths.has(targetRelative)) {
          inputPaths.add(targetRelative);
          pending.push(targetRelative);
        }
      }
    }
  }
  return {
    supported: true,
    inputPaths: [...inputPaths].sort(),
    outputPaths: [...new Set(outputPaths)].sort(),
  };
}

/** The same closed population is used by resolution and selected-object custody. */
export function metadataRepairInputLayout(repoRoot) {
  const layout = manifestOnlyResolutionLayout(repoRoot);
  if (!layout.supported) throw new Error("metadata-repair-layout-unsupported");
  const configs = [...new Set([".npmrc", ...layout.inputPaths
    .filter(path => basename(path) === "package.json")
    .map(path => join(dirname(path), ".npmrc"))])].sort();
  return { layout, configs, inputPaths: [...new Set([...layout.inputPaths, ...configs])].sort() };
}

export function metadataRepairRuntimeIdentity() {
  const glibc = process.platform === "linux" ? process.report.getReport().header.glibcVersionRuntime : null;
  // A libc that this profile cannot identify is unsupported, not a default.
  if (process.platform === "linux" && !glibc) throw new Error("metadata-repair-libc-unknown");
  return { node: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch,
    resolution: { os: process.platform, cpu: process.arch,
      libc: { family: glibc ? "glibc" : "not-applicable", version: glibc ?? null } } };
}

/** Bind the library actually resolved from the selected npm, not this repo. */
export function metadataRepairArboristIdentity(npmCli) {
  const requireNpm = createRequire(npmCli);
  const nodePath = realpathSync(requireNpm.resolve("@npmcli/arborist/lib/node.js"));
  const packagePath = realpathSync(join(dirname(nodePath), "../package.json"));
  const packageBytes = readFileSync(packagePath);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const version = JSON.parse(packageBytes).version;
  const npmPackage = realpathSync(join(dirname(npmCli), "../package.json"));
  const npmVersion = JSON.parse(readFileSync(npmPackage)).version;
  // Temporary compatibility policy for the measured upstream shortcut. Remove
  // it when a pinned upstream release passes the distinct-target matrix without
  // the shim; qualify any other version before admitting it to this profile.
  if (version !== "9.9.1" || npmVersion !== "11.19.0") throw new Error("metadata-repair-arborist-version");
  const files = [
    ["entry", requireNpm.resolve("@npmcli/arborist")],
    ["place-dep", requireNpm.resolve("@npmcli/arborist/lib/place-dep.js")],
    ["link", requireNpm.resolve("@npmcli/arborist/lib/link.js")],
    ["dep-valid", requireNpm.resolve("@npmcli/arborist/lib/dep-valid.js")],
    ["npm-package", npmPackage], ["npm-cli", npmCli],
  ].map(([role, path]) => ({ role, path: realpathSync(path), sha256: digest(readFileSync(path)) }));
  return { nodePath, nodeSha256: digest(readFileSync(nodePath)), packagePath,
    packageSha256: digest(packageBytes), version, npmVersion, policy: "directory-link-realpath-v1",
    bootstrapSha256: digest(METADATA_REPAIR_NPM_BOOTSTRAP), files };
}

// Literal executable input: bundling must not reserialize a function body.
// The parent/global installation stays unchanged. Loaders compile the exact
// verified bytes, and the actual CLI consumer must use that module instance.
export const METADATA_REPAIR_NPM_BOOTSTRAP = String.raw`(function (require) {
  const fs = require("node:fs");
  const path = require("node:path");
  const Module = require("node:module");
  const digest = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const cli = process.argv[1];
  const expected = JSON.parse(process.argv[2]);
  const fail = () => { throw new Error("metadata-repair-arborist-source"); };
  const requireNpm = Module.createRequire(cli);
  const nodePath = fs.realpathSync(requireNpm.resolve("@npmcli/arborist/lib/node.js"));
  const packagePath = fs.realpathSync(path.join(path.dirname(nodePath), "../package.json"));
  const packageBytes = fs.readFileSync(packagePath);
  const npmPackage = fs.realpathSync(path.join(path.dirname(cli), "../package.json"));
  const files = [
    ["entry", requireNpm.resolve("@npmcli/arborist")],
    ["place-dep", requireNpm.resolve("@npmcli/arborist/lib/place-dep.js")],
    ["link", requireNpm.resolve("@npmcli/arborist/lib/link.js")],
    ["dep-valid", requireNpm.resolve("@npmcli/arborist/lib/dep-valid.js")],
    ["npm-package", npmPackage], ["npm-cli", cli],
  ].map(([role, file]) => ({ role, path: fs.realpathSync(file), sha256: digest(fs.readFileSync(file)) }));
  if (nodePath !== expected.nodePath || packagePath !== expected.packagePath ||
      digest(packageBytes) !== expected.packageSha256 || JSON.parse(packageBytes).version !== expected.version ||
      expected.version !== "9.9.1" || expected.npmVersion !== "11.19.0" ||
      JSON.parse(fs.readFileSync(npmPackage)).version !== expected.npmVersion ||
      expected.policy !== "directory-link-realpath-v1" || digest(process._eval) !== expected.bootstrapSha256 ||
      JSON.stringify(files) !== JSON.stringify(expected.files) || require.cache[nodePath]) fail();
  const bound = new Map(files.map(file => [file.path, file.sha256]));
  bound.set(nodePath, expected.nodeSha256);
  bound.set(packagePath, expected.packageSha256);
  const compiled = new Set();
  for (const extension of [".js", ".json"]) {
    const originalLoader = Module._extensions[extension];
    Module._extensions[extension] = (module, filename) => {
      if (!bound.has(filename)) return originalLoader(module, filename);
      const bytes = fs.readFileSync(filename);
      if (digest(bytes) !== bound.get(filename)) fail();
      compiled.add(filename);
      if (extension === ".json") module.exports = JSON.parse(bytes.toString("utf8"));
      else module._compile(bytes.toString("utf8"), filename);
    };
  }
  const Node = requireNpm(nodePath);
  if (!compiled.has(nodePath) || typeof Node.prototype.matches !== "function") fail();
  const matches = Node.prototype.matches;
  const normalized = value => typeof value === "string" && value.trim() && path.isAbsolute(value)
    ? path.resolve(value) : null;
  const corrected = function (other) {
    if (this.isLink && other && other.isLink) {
      const left = normalized(this.realpath);
      const right = normalized(other.realpath);
      if (left && right && left !== right) return false;
    }
    return Reflect.apply(matches, this, arguments);
  };
  Node.prototype.matches = corrected;
  const entry = files.find(file => file.role === "entry").path;
  if (requireNpm(entry).Node !== Node) fail();
  const originalLoad = Module._load;
  let consumers = 0;
  Module._load = function (request, parent, isMain) {
    const result = Reflect.apply(originalLoad, this, arguments);
    if (request === "@npmcli/arborist") {
      if (Module._resolveFilename(request, parent, isMain) !== entry || result.Node !== Node ||
          require.cache[nodePath].exports !== Node || Node.prototype.matches !== corrected) fail();
      consumers++;
    }
    return result;
  };
  process.on("exit", () => {
    if (!consumers || require.cache[nodePath].exports !== Node || Node.prototype.matches !== corrected ||
        files.filter(file => ["entry", "place-dep", "link", "dep-valid"].includes(file.role))
          .some(file => !compiled.has(file.path))) {
      console.error("metadata-repair-arborist-source");
      process.exitCode = 1;
    }
  });
  process.argv.splice(2, 1);
})(require);
require(process.argv[1]);`;

function fileBytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

/** Read the affected virtual graph, never the installed tree. The same guard is
 * used on resolver output and immutable retained candidates. npm owns graph
 * interpretation; the comparisons below only bound the permitted repair. */
export function assertMetadataRepairGraph({ repoRoot, beforeLockBytes, lockPath }, {
  npmCli = realpathSync(join(dirname(process.execPath), "npm")),
  spawnSyncCommand = spawnSync,
} = {}) {
  const refuse = detail => { throw new Error("metadata-repair-graph-" + detail); };
  const bytes = readFileSync(join(repoRoot, lockPath));
  const lock = JSON.parse(bytes);
  const packages = lock.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) refuse("packages");
  const before = beforeLockBytes === null ? null : JSON.parse(beforeLockBytes);
  if (before !== null && (!before.packages || typeof before.packages !== "object")) refuse("base-packages");
  const { layout } = metadataRepairInputLayout(repoRoot);
  const manifests = new Map(layout.inputPaths.filter(path => basename(path) === "package.json")
    .map(path => [dirname(path) === "." ? "" : dirname(path), JSON.parse(readFileSync(join(repoRoot, path), "utf8"))]));
  const lookup = (population, from, name) => {
    for (let cursor = from; ; cursor = dirname(cursor) === "." ? "" : dirname(cursor)) {
      // Match npm/Node ancestor resolution: node_modules itself is never a
      // resolution base (node_modules/node_modules is not an ancestor lookup).
      if (basename(cursor) === "node_modules") continue;
      const path = (cursor ? cursor + "/" : "") + "node_modules/" + name;
      if (population[path]) {
        const entry = population[path];
        return { path, target: entry.link ? entry.resolved : path,
          entry: entry.link ? population[entry.resolved] : entry };
      }
      if (!cursor) return null;
    }
  };
  const edges = entry => Object.assign({}, ...LOCK_MANIFEST_DEPENDENCY_FIELDS.map(field => entry?.[field] ?? {}));
  const localPaths = new Set();
  const localRoots = [];
  const nextRoots = [];
  for (const [dir, manifest] of manifests) {
    const mirror = packages[dir];
    if (!mirror || mirror.link || (manifest.version !== undefined && mirror.version !== manifest.version) ||
        (mirror.name !== undefined && mirror.name !== manifest.name)) refuse("manifest-mirror:" + dir);
    for (const field of LOCK_MANIFEST_DEPENDENCY_FIELDS) {
      if (!isDeepStrictEqual(normalizedRecord(manifest[field]), normalizedRecord(mirror[field]))) {
        refuse("manifest-mirror:" + dir + ":" + field);
      }
    }
    for (const [name, spec] of Object.entries(edges(manifest))) {
      if (typeof spec !== "string") refuse("dependency-spec");
      if (name === "next") {
        const found = lookup(packages, dir, name);
        if (!found?.entry || (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec) && found.entry.version !== spec)) {
          refuse("next-selection:" + dir);
        }
        nextRoots.push({ dir, name });
        for (const [edge, version] of Object.entries(edges(found.entry))) {
          if (edge !== "@next/env" && !edge.startsWith("@next/swc-")) continue;
          const selected = lookup(packages, found.target, edge);
          if (!selected?.entry || selected.entry.version !== version || version !== found.entry.version) {
            refuse("next-edge:" + dir + ":" + edge);
          }
        }
      }
      if (!spec.startsWith("file:") || /\.(?:tgz|tar\.gz)$/i.test(spec)) continue;
      const target = toRepoRelativePath(repoRoot, resolve(repoRoot, dir, spec.slice(5)));
      const selected = manifests.get(target);
      const found = lookup(packages, dir, name);
      if (!selected || !found || !packages[found.path]?.link || found.target !== target ||
          (found.entry?.name !== undefined && found.entry.name !== selected.name) || found.entry?.version !== selected.version) {
        refuse("local-target:" + dir + ":" + name);
      }
      localPaths.add(found.path);
      localPaths.add(target);
      localRoots.push({ dir, name, target });
    }
  }
  // npm may rewrite mirrors and the affected Next/local-target closures, not
  // unrelated registry entries. Traverse each population independently: OLD
  // edges bound deletions and NEW edges bound additions, including relocated
  // and scoped dev dependencies of a selected manifest-relative target.
  // This is a census over lock edges, not a second resolver or a directory grant.
  const permitted = new Set(localPaths);
  const addClosure = population => {
    const queue = nextRoots.flatMap(({ dir, name }) => [lookup(population, dir, name)]).filter(Boolean);
    for (const { dir, name, target } of localRoots) {
      const link = lookup(population, dir, name);
      // The old link may be the wrong same-name workspace. Its link entry can
      // be corrected, but only the selected target's graph grants descendants.
      if (link) permitted.add(link.path);
      if (population[target]) queue.push({ path: target, target, entry: population[target] });
    }
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (seen.has(node.path)) continue;
      seen.add(node.path); permitted.add(node.path); permitted.add(node.target);
      for (const name of Object.keys(edges(node.entry))) {
        const child = lookup(population, node.target, name);
        if (child) queue.push(child);
      }
    }
  };
  addClosure(packages);
  if (before) {
    addClosure(before.packages);
    const stripMirrors = entry => entry && Object.fromEntries(Object.entries(entry)
      // npm elides the optional name of an unscoped workspace whose directory
      // already supplies it. Explicit output names were checked above; reject
      // a wrong baseline name too before comparing the remaining exact fields.
      .filter(([key]) => key !== "name" && !LOCK_MANIFEST_DEPENDENCY_FIELDS.includes(key)));
    const top = value => ({ requires: true, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "packages")) });
    if (!isDeepStrictEqual(top(before), top(lock))) refuse("unrelated-lock-header");
    for (const path of new Set([...Object.keys(before.packages), ...Object.keys(packages)])) {
      const old = before.packages[path];
      const current = packages[path];
      if (isDeepStrictEqual(old, current) || permitted.has(path)) continue;
      if (manifests.has(path) && (old?.name === undefined || old.name === manifests.get(path).name) &&
          isDeepStrictEqual(stripMirrors(old), stripMirrors(current))) continue;
      if (!old && manifests.has(path) && current && Object.entries(current).every(([key, value]) =>
        Object.hasOwn(manifests.get(path), key) && isDeepStrictEqual(value, manifests.get(path)[key]))) continue;
      if (current?.link && manifests.has(current.resolved) &&
          path === "node_modules/" + manifests.get(current.resolved).name &&
          (!old || (old.link && old.resolved === current.resolved))) continue;
      refuse("unrelated-lock-entry:" + path);
    }
  }
  const privateRoot = mkdtempSync(join(tmpdir(), "npm-metadata-graph-"));
  try {
    const userconfig = join(privateRoot, "user.npmrc");
    const globalconfig = join(privateRoot, "global.npmrc");
    for (const path of [userconfig, globalconfig]) writeFileSync(path, "", { mode: 0o600 });
    const env = { HOME: privateRoot, TMPDIR: privateRoot, PATH: dirname(process.execPath), LANG: "C.UTF-8", TZ: "UTC" };
    const common = ["--package-lock-only", "--json", "--long", "--all", "--ignore-scripts", "--no-audit", "--no-fund",
      "--userconfig=" + userconfig, "--globalconfig=" + globalconfig, "--cache=" + join(privateRoot, "cache")];
    const affected = manifests.has("apps/slack-asana-bug-drill") ? "apps/slack-asana-bug-drill" : null;
    const reads = [{ cwd: repoRoot, selectors: affected ? ["--workspace=" + affected] : [] }];
    for (const { dir } of nextRoots) {
      const next = lookup(packages, dir, "next");
      let cwd = repoRoot;
      if (!dir) {
        // npm's workspace-aware root can report the child's Next graph. Read
        // the retained root independently, using the exact lock bytes in an
        // owned manifest-only view with workspace discovery disabled. This is
        // a reader view only; it never becomes resolver or publication output.
        const view = createManifestOnlyTree(repoRoot, layout.inputPaths, privateRoot);
        const manifest = { ...manifests.get("") };
        const rootLock = structuredClone(lock);
        delete manifest.workspaces;
        delete rootLock.packages[""].workspaces;
        writeFileSync(join(view.scratchRoot, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(view.scratchRoot, lockPath), JSON.stringify(rootLock));
        cwd = view.scratchRoot;
      }
      reads.push({ cwd, selectors: ["next", ...Object.keys(edges(next.entry)).filter(name => name.startsWith("@next/")),
        ...(dir ? ["--workspace=" + dir] : ["--workspaces=false"])] });
    }
    for (const { cwd, selectors } of reads) {
      const result = spawnSyncCommand(process.execPath, [npmCli, "ls", ...common, ...selectors], {
        cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.signal || result.status !== 0) {
        refuse("npm-ls:" + (result.error?.message ?? result.status) + ":" + String(result.stderr ?? "").slice(0, 1500));
      }
      let graph;
      try { graph = JSON.parse(result.stdout); } catch { refuse("npm-json"); }
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) refuse("npm-json");
      const visit = node => {
        if (!node || typeof node !== "object" || Array.isArray(node) ||
            (node.problems !== undefined && (!Array.isArray(node.problems) || node.problems.length !== 0)) ||
            node.invalid || node.extraneous || node.missing || node.error) refuse("npm-problems");
        if (node.dependencies !== undefined && (!node.dependencies || typeof node.dependencies !== "object" || Array.isArray(node.dependencies))) refuse("npm-dependencies");
        for (const child of Object.values(node.dependencies ?? {})) visit(child);
      };
      visit(graph);
    }
    if (!bytes.equals(readFileSync(join(repoRoot, lockPath)))) refuse("lock-moved");
  } finally { rmSync(privateRoot, { recursive: true, force: true }); }
}

function createManifestOnlyTree(repoRoot, inputPaths, parent = tmpdir()) {
  const scratchRoot = mkdtempSync(join(parent, "npm-install-safe-resolve-"));
  const snapshot = new Map();
  try {
    for (const path of inputPaths) {
      const absolutePath = join(repoRoot, path);
      const contents = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
      snapshot.set(path, contents);
      if (contents === null) continue;
      const destination = join(scratchRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    return { scratchRoot, snapshot };
  } catch (error) {
    rmSync(scratchRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Resolve repair bytes in the existing manifest-only layout. The caller supplies
 * a selected-object materialization, never the shared checkout. This does not
 * apply output or authorize publication: custody must bind this receipt to its
 * selected Git inputs and recheck them under the existing writer fence.
 */
export async function resolveMetadataRepairLock({ repoRoot }, {
  // The existing child-process seam lets the maintained suite observe the real
  // launch, including refusal when its private cache was contaminated.
  spawnCommand = spawn,
  npmCli = realpathSync(join(dirname(process.execPath), "npm")),
  log = (line) => console.error(line),
} = {}) {
  const repositoryRealpath = realpathSync(repoRoot);
  const { layout, configs, inputPaths } = metadataRepairInputLayout(repositoryRealpath);
  // The ordinary installer supports sources outside this repair profile. Reuse
  // its target classifier, but admit only public registry specs or the file:
  // inputs already enumerated by the manifest-only layout. Inspect raw schemes
  // before name@range parsing so URL user-info cannot hide a remote source.
  const inspectTarget = (spec, localAllowed) => {
    if (typeof spec !== "string") throw new Error("metadata-repair-dependency-unsupported");
    if (localAllowed && spec.startsWith("file:")) return;
    const target = spec.startsWith("npm:") ? spec.slice(4) : spec;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || isLocalOrRemotePackageSpec(target)) {
      throw new Error("metadata-repair-dependency-unsupported");
    }
  };
  const inspectOverrides = value => {
    if (typeof value === "string") return inspectTarget(value, false);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("metadata-repair-dependency-unsupported");
    }
    for (const nested of Object.values(value)) inspectOverrides(nested);
  };
  for (const path of layout.inputPaths.filter(path => basename(path) === "package.json")) {
    if (!existsSync(join(repositoryRealpath, path))) continue;
    const manifest = JSON.parse(readFileSync(join(repositoryRealpath, path), "utf8"));
    for (const field of LOCK_MANIFEST_DEPENDENCY_FIELDS) {
      for (const spec of Object.values(manifest[field] ?? {})) inspectTarget(spec, true);
    }
    if (manifest.overrides !== undefined) inspectOverrides(manifest.overrides);
  }
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const projectConfig = [];
  for (const path of inputPaths) {
    const absolute = join(repositoryRealpath, path);
    // A manifest-only copy must not follow symlinks out of the selected tree.
    for (let cursor = absolute; cursor !== repositoryRealpath; cursor = dirname(cursor)) {
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error("metadata-repair-symlink-input");
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    if (existsSync(absolute) && !lstatSync(absolute).isFile()) throw new Error("metadata-repair-input-type");
    if (!configs.includes(path)) continue;
    const bytes = existsSync(absolute) ? readFileSync(absolute) : null;
    const values = {};
    for (const line of bytes?.toString("utf8").split(/\r?\n/) ?? []) {
      const text = line.trim();
      if (!text || text.startsWith("#") || text.startsWith(";")) continue;
      const match = /^(registry|legacy-peer-deps|strict-peer-deps|install-links|engine-strict)\s*=\s*(\S+)$/.exec(text);
      if (!match || Object.hasOwn(values, match[1]) ||
          (match[1] === "registry" ? match[2] !== "https://registry.npmjs.org/" : !["true", "false"].includes(match[2]))) {
        throw new Error("metadata-repair-project-config-unsupported");
      }
      values[match[1]] = match[2];
    }
    projectConfig.push({ path, sha256: bytes === null ? null : digest(bytes), values });
  }
  const attemptId = randomUUID();
  const attemptRoot = mkdtempSync(join(tmpdir(), "npm-metadata-repair-"));
  const receipt = { schemaVersion: 1, attemptId, repositoryRealpath, attemptRoot,
    cleanup: { removed: false } };
  let stage = "prepare";
  let resolverRoot;
  let resolverLockPath;
  let resolution;
  let failure;
  const withFailureEvidence = error => {
    const candidate = { path: resolverLockPath ?? null, bytes: null, sha256: null,
      size: null, omission: "not-produced" };
    // Keep diagnostics in memory, never the disposable tree. Do not follow a
    // substituted path or read an unbounded output after a failed child.
    if (resolution && resolverRoot && resolverLockPath) {
      try {
        const output = join(resolverRoot, resolverLockPath);
        const rootStat = lstatSync(resolverRoot);
        const stat = lstatSync(output);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(resolverRoot) !== resolverRoot ||
            !stat.isFile() || stat.isSymbolicLink()) candidate.omission = "unsafe-type";
        else {
          candidate.size = stat.size;
          if (stat.size > 16 * 1024 * 1024) candidate.omission = "size-limit";
          else {
            candidate.bytes = readFileSync(output);
            candidate.sha256 = digest(candidate.bytes);
            candidate.omission = null;
          }
        }
      } catch (readError) {
        candidate.omission = readError?.code === "ENOENT" ? "absent" : "unreadable";
      }
    }
    const caught = error instanceof Error ? error : new Error(String(error));
    // Non-enumerable: ordinary error logging must not dump the lock bytes.
    Object.defineProperty(caught, "metadataRepairFailure", { value: {
      schemaVersion: 1, stage, candidate, resolution: resolution ?? null, receipt,
    } });
    return caught;
  };
  try {
    const input = createManifestOnlyTree(repositoryRealpath, inputPaths, attemptRoot);
    const lockPath = input.snapshot.get("npm-shrinkwrap.json") !== null ? "npm-shrinkwrap.json" : "package-lock.json";
    resolverRoot = input.scratchRoot;
    resolverLockPath = lockPath;
    // Keep selected input evidence unchanged. Only the owned resolver copy's
    // mirrors are derived from selected manifests, before npm reads its graph.
    const privateSnapshot = new Map(input.snapshot);
    const selectedLock = input.snapshot.get(lockPath);
    if (selectedLock !== null) {
      const lock = JSON.parse(selectedLock);
      if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
        throw new Error("metadata-repair-output-graph");
      }
      for (const path of layout.inputPaths.filter(path => basename(path) === "package.json")) {
        const selected = input.snapshot.get(path);
        if (selected === null) continue;
        const manifest = JSON.parse(selected);
        const dir = dirname(path) === "." ? "" : dirname(path);
        const mirror = lock.packages[dir] ??= Object.fromEntries(["name", "version"]
          .filter(key => Object.hasOwn(manifest, key)).map(key => [key, manifest[key]]));
        if (mirror.link || typeof mirror !== "object" || Array.isArray(mirror)) {
          throw new Error("metadata-repair-manifest-mirror");
        }
        for (const field of LOCK_MANIFEST_DEPENDENCY_FIELDS) {
          const value = normalizedRecord(manifest[field]);
          if (Object.keys(value).length) mirror[field] = value;
          else delete mirror[field];
        }
      }
      const bytes = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
      writeFileSync(join(input.scratchRoot, lockPath), bytes);
      privateSnapshot.set(lockPath, bytes);
    }
    const home = join(attemptRoot, "home");
    const temporary = join(attemptRoot, "tmp");
    const cache = join(attemptRoot, "cache");
    for (const path of [home, temporary, cache]) mkdirSync(path, { mode: 0o700 });
    const ownedRoot = lstatSync(attemptRoot);
    const ownedCache = lstatSync(cache);
    receipt.attempt = { device: ownedRoot.dev, inode: ownedRoot.ino, createdAt: new Date().toISOString() };
    const userconfig = join(attemptRoot, "user.npmrc");
    const globalconfig = join(attemptRoot, "global.npmrc");
    for (const path of [userconfig, globalconfig]) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const node = realpathSync(process.execPath);
    const cli = realpathSync(npmCli);
    const arborist = metadataRepairArboristIdentity(cli);
    const argv = ["--input-type=commonjs", "--eval", METADATA_REPAIR_NPM_BOOTSTRAP, cli, JSON.stringify(arborist),
      "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
      "--workspaces", "--include-workspace-root", "--registry=https://registry.npmjs.org/",
      "--userconfig=" + userconfig, "--globalconfig=" + globalconfig, "--cache=" + cache];
    // Construct from nothing. In particular npm_config, proxy, TLS and loader
    // settings from the calling shell are neither inherited nor serialized.
    const env = { HOME: home, TMPDIR: temporary, PATH: dirname(node), LANG: "C.UTF-8", TZ: "UTC" };
    receipt.command = { executable: node, executableSha256: digest(readFileSync(node)),
      npmCli: cli, npmCliSha256: digest(readFileSync(cli)), arborist, argv: [...argv], cwd: input.scratchRoot,
      runner: realpathSync(fileURLToPath(import.meta.url)), runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))) };
    receipt.runtime = { ...metadataRepairRuntimeIdentity(),
      npm: JSON.parse(readFileSync(join(dirname(cli), "../package.json"), "utf8")).version };
    receipt.projectConfig = projectConfig;
    receipt.environment = { ...env };
    receipt.selectedInputs = [...input.snapshot].map(([path, bytes]) => ({ path,
      sha256: bytes === null ? null : digest(bytes),
      mode: bytes === null ? null : lstatSync(join(repositoryRealpath, path)).mode & 0o777 }));
    receipt.configFiles = [userconfig, globalconfig].map(path => ({ path, sha256: digest(readFileSync(path)) }));
    const privateModes = new Map([...input.snapshot].map(([path, bytes]) => [path,
      bytes === null ? null : lstatSync(join(input.scratchRoot, path)).mode & 0o777]));
    const matchesSnapshot = (root, path, bytes, mode) => {
      // Absence is a measured input too. Inspect ancestors before reading so a
      // replaced directory or a dangling symlink cannot escape this snapshot.
      if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) return false;
      const absolute = join(root, path);
      for (let cursor = absolute; cursor !== root; cursor = dirname(cursor)) {
        try { if (lstatSync(cursor).isSymbolicLink()) return false; }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      let stat;
      try { stat = lstatSync(absolute); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      return bytes === null ? stat === undefined : stat?.isFile() &&
        (stat.mode & 0o777) === mode && fileBytesEqual(bytes, readFileSync(absolute));
    };
    // This wrapper executes at the actual spawn boundary of the maintained
    // observable runner, after its logging/attribution preparation.
    const launch = (_command, args, options) => {
      log("NPM_INSTALL_SAFE metadata-repair launch prepared (cwd=" + input.scratchRoot + ")");
      const rootStat = lstatSync(attemptRoot);
      const cacheStat = lstatSync(cache);
      if (args.length !== argv.length || args.some((arg, i) => arg !== argv[i]) ||
          options.cwd !== input.scratchRoot || JSON.stringify(options.env) !== JSON.stringify(env) ||
          !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== ownedRoot.dev || rootStat.ino !== ownedRoot.ino ||
          realpathSync(attemptRoot) !== attemptRoot || !cacheStat.isDirectory() || cacheStat.dev !== ownedCache.dev ||
          cacheStat.ino !== ownedCache.ino || cacheStat.isSymbolicLink() || readdirSync(cache).length !== 0) {
        throw new Error("metadata-repair-launch-inputs-changed");
      }
      // Logging/attribution is observable preparation, not the launch itself.
      // Reconcile the complete discovered population and raw bytes at spawn;
      // checking only argv/cache permits a different graph or npm config to run.
      let currentArborist;
      try { currentArborist = metadataRepairArboristIdentity(cli); }
      catch { throw new Error("metadata-repair-launch-inputs-changed"); }
      if (JSON.stringify(manifestOnlyResolutionLayout(repositoryRealpath)) !== JSON.stringify(layout) ||
          JSON.stringify(manifestOnlyResolutionLayout(input.scratchRoot)) !== JSON.stringify(layout) ||
          receipt.selectedInputs.some(({ path, mode }) =>
            !matchesSnapshot(repositoryRealpath, path, input.snapshot.get(path), mode) ||
            !matchesSnapshot(input.scratchRoot, path, privateSnapshot.get(path), privateModes.get(path))) ||
          projectConfig.some(({ path, sha256 }) => {
            const bytes = input.snapshot.get(path);
            return (bytes === null ? null : digest(bytes)) !== sha256;
          }) ||
          receipt.configFiles.some(({ path, sha256 }) =>
            !matchesSnapshot(attemptRoot, basename(path), Buffer.alloc(0), 0o600) ||
            digest(readFileSync(path)) !== sha256) ||
          digest(readFileSync(node)) !== receipt.command.executableSha256 ||
          realpathSync(npmCli) !== cli || digest(readFileSync(cli)) !== receipt.command.npmCliSha256 ||
          JSON.stringify(currentArborist) !== JSON.stringify(arborist) ||
          digest(readFileSync(receipt.command.runner)) !== receipt.command.runnerSha256) {
        throw new Error("metadata-repair-launch-inputs-changed");
      }
      receipt.cache = { path: cache, attemptId, device: cacheStat.dev, inode: cacheStat.ino,
        emptyBeforeLaunch: true, checkedAt: new Date().toISOString(),
        launchSha256: digest(JSON.stringify({ node, argv, cwd: options.cwd, env })) };
      return spawnCommand(node, args, options);
    };
    stage = "resolve";
    const status = await runNpmWithHeartbeat({ phase: "metadata-repair-resolve", args: argv,
      cwd: input.scratchRoot, env, spawnCommand: launch, log });
    resolution = { exitCode: status };
    if (status !== 0) throw new Error("metadata-repair-resolution-failed");
    stage = "validate-inputs";
    log("NPM_INSTALL_SAFE phase=metadata-repair stage=" + stage);
    // npm may rewrite mirror metadata in the lock; it may not change a source
    // manifest, config, local target or archive to make the graph look valid.
    for (const [path, bytes] of input.snapshot) {
      if (path === lockPath) continue;
      const output = join(input.scratchRoot, path);
      const actual = existsSync(output) ? readFileSync(output) : null;
      if (!fileBytesEqual(bytes, actual)) throw new Error("metadata-repair-resolver-changed-input");
    }
    stage = "validate-output";
    log("NPM_INSTALL_SAFE phase=metadata-repair stage=" + stage);
    const output = join(input.scratchRoot, lockPath);
    if (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink()) throw new Error("metadata-repair-output-type");
    const bytes = readFileSync(output);
    const packages = JSON.parse(bytes).packages;
    if (!packages || typeof packages !== "object" || Array.isArray(packages)) throw new Error("metadata-repair-output-graph");
    stage = "validate-graph";
    log("NPM_INSTALL_SAFE phase=metadata-repair stage=" + stage);
    assertMetadataRepairGraph({ repoRoot: input.scratchRoot, beforeLockBytes: input.snapshot.get(lockPath), lockPath }, { npmCli: cli });
    log("NPM_INSTALL_SAFE phase=metadata-repair stage=graph-complete");
    receipt.output = { path: lockPath, sha256: digest(bytes), mode: lstatSync(output).mode & 0o777,
      registry: Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => ({
        path, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null,
      })) };
    return { bytes, snapshot: input.snapshot, receipt };
  } catch (error) {
    failure = withFailureEvidence(error);
    throw failure;
  } finally {
    // Only this attempt's exclusively-created root is owned here. A failure is
    // surfaced, never converted into a successful cleanup receipt.
    try {
      rmSync(attemptRoot, { recursive: true, force: true });
      receipt.cleanup.removed = !existsSync(attemptRoot);
      if (!receipt.cleanup.removed) throw new Error("metadata-repair-cleanup-incomplete");
      log("NPM_INSTALL_SAFE phase=metadata-repair stage=cleanup-complete");
    } catch (error) {
      receipt.cleanup.errorCode = error?.code ?? "metadata-repair-cleanup-incomplete";
      // Preserve the original refusal and record cleanup failure alongside it.
      if (!failure) { stage = "cleanup"; throw withFailureEvidence(error); }
    }
  }
}

function resolvedManifestFiles(scratchRoot, outputPaths) {
  return new Map(
    outputPaths.map((path) => {
      const absolutePath = join(scratchRoot, path);
      return [
        path,
        existsSync(absolutePath) ? readFileSync(absolutePath) : null,
      ];
    }),
  );
}

/** Apply resolver output only while the source snapshot is current. */
export function applyResolvedManifestFiles({
  repoRoot,
  snapshot,
  files,
  outputPaths,
}) {
  for (const [path, expected] of snapshot) {
    const absolutePath = join(repoRoot, path);
    const actual = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
    if (!fileBytesEqual(actual, expected))
      return { applied: false, reason: "source-changed", path };
  }
  for (const path of outputPaths) {
    const next = files.get(path);
    if (next === null && snapshot.get(path) !== null)
      return { applied: false, reason: "resolver-removed-source-file", path };
  }
  for (const path of outputPaths) {
    const next = files.get(path);
    const before = snapshot.get(path);
    if (next === null || fileBytesEqual(before, next)) continue;
    const absolutePath = join(repoRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const temporaryPath = join(
      dirname(absolutePath),
      "." + basename(absolutePath) + ".install-safe-" +
        process.pid + "-" + randomUUID(),
    );
    try {
      writeFileSync(temporaryPath, next);
      renameSync(temporaryPath, absolutePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return { applied: true };
}

// Call under an install reader so the admission decision observes one graph.
async function installedGraphNeedsRepair({ repoRoot, npmArgs }) {
  const { workspaceDirs } = verificationScopeForNpmArgs({ repoRoot, npmArgs });
  const ranges = await findUnsatisfiedDeclaredDepRangesWithRetry({ repoRoot, workspaceDirs });
  const declared = await findUnextractedDepsWithRetry({ repoRoot, workspaceDirs });
  const lockPath = join(repoRoot, existsSync(join(repoRoot, "npm-shrinkwrap.json"))
    ? "npm-shrinkwrap.json" : "package-lock.json");
  const lockTreeDefects = existsSync(lockPath) ? auditLockfile({
    lock: JSON.parse(readFileSync(lockPath, "utf8")), lockDir: "", treeRoot: repoRoot,
  }).defects : [];
  return ranges.invalid.length > 0 || declared.missing.length > 0 || lockTreeDefects.length > 0;
}

async function runManifestOnlyInstall({
  repoRoot,
  lockName,
  npmArgs,
  npmEnv,
  plan,
}) {
  const resolverLockName = lockName + "-resolver";
  return withFsMutex(
    resolverLockName,
    async () => {
      let input;
      // Set when the resolution was computed from manifests that changed before it could be
      // applied; main() then re-resolves against the current manifests (WI-10006714).
      let stale = null;
      const layout = await withFsMutexRead(lockName, async () => {
        const mismatches = findRootLockManifestMismatches(repoRoot);
        if (mismatches.length > 0) {
          console.error(formatRootLockManifestMismatches(mismatches));
          return { supported: false, preflightDrift: true };
        }
        const value = manifestOnlyResolutionLayout(repoRoot);
        if (!value.supported) return value;
        // A transitive security override can leave every direct range satisfied
        // while the installed runtime differs from the selected lock. Reuse the
        // publisher's exact-path audit, as post-reify verification already does;
        // that graph needs repair admission rather than an unbounded pre-drain.
        // A broken installed graph needs a writer reservation so sustained new
        // readers cannot starve its repair. Existing readers still drain under
        // the exclusive mutex; healthy installs retain the D-009 pre-drain.
        value.repairInstalledGraph = await installedGraphNeedsRepair({ repoRoot, npmArgs });
        input = createManifestOnlyTree(repoRoot, value.inputPaths);
        return value;
      });
      if (layout.preflightDrift)
        return { supported: true, status: 1 };
      if (!layout.supported)
        return { supported: false, reason: layout.reason };
      try {
        const cacheStatus = await verifyNpmCacheExclusive({
          verify: () => verifyNpmCache({ repoRoot, npmArgs, env: npmEnv }),
        });
        if (cacheStatus !== 0) {
          console.error(
            "NPM_INSTALL_SAFE_FATAL: npm cache verify exited " +
              cacheStatus + "; cache integrity is unverified.",
          );
          return { supported: true, status: cacheStatus };
        }
        // Do not hold the repo mutex here, including a shared reader: git-sync needs
        // the exclusive repo writer and would otherwise queue for the full npm resolve.
        const resolveStatus = await withPackageCacheReadLease(() =>
          runNpmWithHeartbeat({
            phase: "resolve",
            args: plan.resolverArgs,
            cwd: input.scratchRoot,
            env: npmEnv,
          }),
        );
        if (resolveStatus !== 0)
          return { supported: true, status: resolveStatus };
        const files = resolvedManifestFiles(input.scratchRoot, layout.outputPaths);
        const status = await withFsMutex(
          lockName,
          async () => withWriterAttribution({
            repoRoot,
            nestedPath: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
            invocationId: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
            lockName,
            phase: "reify-transaction",
          }, async () => {
            const applied = applyResolvedManifestFiles({
              repoRoot,
              snapshot: input.snapshot,
              files,
              outputPaths: layout.outputPaths,
            });
            if (!applied.applied) {
              if (applied.reason === "source-changed") {
                stale = { reason: applied.reason, path: applied.path ?? "unknown" };
                return 1;
              }
              console.error(
                "NPM_INSTALL_SAFE_RESOLUTION_STALE: " + applied.reason +
                  " at " + (applied.path ?? "unknown") +
                  "; no reify ran. Retry the install against the current manifests.",
              );
              return 1;
            }
            // The resolver can rewrite flags before reify starts. Preserve its
            // original snapshot here, while holding the writer, so the later
            // reify/repair snapshot cannot accept those rewritten flags as its
            // baseline. Substantive dependency changes remain authoritative.
            const before = input.snapshot.get("package-lock.json");
            if (
              before !== null &&
              workspaceSelectorsForNpmArgs(npmArgs).length > 0
            ) {
              const restore = restoreScopedFlagOnlyLockfileRewrite({
                repoRoot,
                beforeText: before.toString("utf8"),
              });
              if (restore.restored)
                console.log(
                  "NPM_INSTALL_SAFE kept the pre-install package-lock.json: " +
                    "this workspace-scoped command rewrote only npm dependency-type flags (" +
                    restore.reason + ", " + restore.entries.length +
                    " entries); a scoped install is not authoritative for them (WI-10003114)",
                );
            }
            if (plan.packageLockOnly) return 0;
            return withPackageCacheReadLease(async () => {
              console.log(
                "NPM_INSTALL_SAFE reifying resolved lockfile: npm " +
                  plan.reifyArgs.join(" ") + " (root=" + repoRoot +
                  ", lock=" + lockName + ")",
              );
              const lockfileBeforeScopedCommand =
                workspaceSelectorsForNpmArgs(npmArgs).length > 0
                  ? readLockfileText(repoRoot)
                  : undefined;
              const status = await runNpmWithHeartbeat({
                phase: "reify",
                args: plan.reifyArgs,
                cwd: repoRoot,
                env: npmEnv,
              });
              if (status !== 0) return status;
              const verdict =
                npmEnv.PAPERCUSP_SKIP_DEP_VERIFY === "1"
                  ? 0
                  : await verifyDepsExtracted({
                      repoRoot,
                      npmArgs,
                      env: npmEnv,
                    });
              if (lockfileBeforeScopedCommand !== undefined) {
                const restore = restoreScopedFlagOnlyLockfileRewrite({
                  repoRoot,
                  beforeText: lockfileBeforeScopedCommand,
                });
                if (restore.restored)
                  console.log(
                    "NPM_INSTALL_SAFE kept the pre-install package-lock.json: " +
                      "this workspace-scoped command rewrote only npm dependency-type flags (" +
                      restore.reason + ", " + restore.entries.length +
                      " entries); a scoped install is not authoritative for them (WI-10003114)",
                  );
              }
              return verdict;
            });
          }),
          {
            waitForReadersBeforeReserve: !layout.repairInstalledGraph,
            ...installLockWaitReporter({
              lock: "writer",
              describe: (owner, elapsedMs) =>
                "NPM_INSTALL_SAFE waiting to reify behind another agent's install (" +
                Math.round(elapsedMs / 1000) + "s so far) — holder: " + owner,
              log: (line) => console.log(line),
              budgetMs: resolveFsMutexTimeoutMs(),
            }),
            waitingNoticeIntervalMs: 30_000,
          },
        );
        return stale
          ? { supported: true, status, stale }
          : { supported: true, status };
      } finally {
        rmSync(input.scratchRoot, { recursive: true, force: true });
      }
    },
    {
      onWaiting: ({ owner, elapsedMs }) =>
        console.error(
          "NPM_INSTALL_SAFE waiting to serialize dependency resolution (" +
            Math.round(elapsedMs / 1000) + "s so far) — holder: " +
            String(owner).trim(),
        ),
      waitingNoticeIntervalMs: 30_000,
    },
  );
}

/**
 * npm treats config flags before a command as global flags. Preserve the
 * long-documented `npm run install:safe -- --legacy-peer-deps` form by making
 * the implicit install explicit before spawning npm.
 */
export function normalizeNpmArgs(argv) {
  if (argv.length === 0) return ["install"];
  return argv[0].startsWith("-") ? ["install", ...argv] : argv;
}

/**
 * Build the environment for npm children without changing the parent process.
 * The offline override is deliberately opt-in: ordinary installs retain an
 * explicit caller setting (including `ONNXRUNTIME_NODE_INSTALL=skip`).
 */
export function npmChildEnv({
  env = process.env,
  offlineSafe = false,
} = {}) {
  const hasExplicitInstallSetting =
    Object.prototype.hasOwnProperty.call(env, "ONNXRUNTIME_NODE_INSTALL") &&
    env.ONNXRUNTIME_NODE_INSTALL !== undefined;
  return {
    ...env,
    ...(offlineSafe && !hasExplicitInstallSetting
      ? { ONNXRUNTIME_NODE_INSTALL: "skip" }
      : {}),
  };
}

/** A separately locked project can still match an enclosing npm workspace.
 * Keep npm on the selected standalone project during resolution, reify and
 * repair. Its install mutex still belongs to the enclosing workspace root.
 */
function isolateNestedProjectInstallArgs(repoRoot, npmArgs) {
  if (!["install", "i", "ci", "update", "up", "dedupe", "prune", "uninstall", "remove", "rm", "link", "unlink"].includes(npmArgs[0]))
    return npmArgs;
  if (!existsSync(join(repoRoot, "package-lock.json")) && !existsSync(join(repoRoot, "npm-shrinkwrap.json")))
    return npmArgs;
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  if (workspaces.length > 0 || installLockRootForPath(repoRoot) === realpathSync(repoRoot))
    return npmArgs;
  return npmBooleanArg(npmArgs, "--workspaces") === false
    ? npmArgs
    : [...npmArgs, "--workspaces=false"];
}

/** A development checkout must not lose its tools because NODE_ENV, npm config,
 * or .npmrc implicitly omits dev dependencies. An explicit production selection
 * on this invocation remains authoritative. Apply before resolve AND reify so
 * repairs inherit the same selection. Reader/cache commands never reach here.
 * @param {string} repoRoot @param {string[]} npmArgs
 */
export function developmentInstallArgs(repoRoot, npmArgs) {
  if (!["install", "i", "ci", "update", "up", "dedupe", "prune", "uninstall", "remove", "rm", "link", "unlink"].includes(npmArgs[0]))
    return npmArgs;
  const savesDev = npmBooleanArg(npmArgs, "--save-dev") === true || npmArgs.includes("-D");
  const manifestPath = join(repoRoot, "package.json");
  if (!savesDev && (!existsSync(manifestPath) ||
      !Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).devDependencies ?? {}).length)) return npmArgs;
  for (let index = 1; index < npmArgs.length; index++) {
    const [flag, inline] = npmArgs[index].split(/=(.*)/s);
    const value = inline ?? npmArgs[index + 1];
    if ((flag === "--omit" && value?.split(/[\s,]+/).includes("dev")) ||
        (flag === "--include" && value?.split(/[\s,]+/).includes("dev")) ||
        (flag === "--only" && ["prod", "production"].includes(value)) ||
        (flag === "--also" && ["dev", "development"].includes(value)) ||
        ["--production", "--no-production", "--dev"].includes(flag)) return npmArgs;
  }
  return [...npmArgs, "--include=dev"];
}

/** The dev-dependency selection flags of an npm command, verbatim and in order
 * (`--include=dev`, `--omit dev`, `--production`, ...), so a follow-up reify can
 * apply exactly the selection the original install used.
 * @param {string[]} npmArgs
 * @returns {string[]}
 */
export function dependencySelectionArgs(npmArgs) {
  const selected = [];
  for (let index = 1; index < npmArgs.length; index++) {
    const token = npmArgs[index];
    const [flag, inline] = token.split(/=(.*)/s);
    if (["--production", "--no-production", "--dev"].includes(flag)) {
      selected.push(token);
    } else if (["--omit", "--include", "--only", "--also"].includes(flag)) {
      if (inline !== undefined) selected.push(token);
      else if (index + 1 < npmArgs.length) selected.push(token, npmArgs[++index]);
    }
  }
  return selected;
}

/**
 * Publish the verified install as an immutable dependency generation under a
 * shared reader marker for the repo-keyed install mutex. The generation builder
 * carries its own before/after fingerprint guard and a short atomic-publish
 * lock; this reader boundary keeps a concurrent safe install from reifying
 * node_modules during the potentially long copy while still allowing other
 * dependency readers to proceed together.
 */
export async function publishDependencyGeneration({
  repoRoot = DEFAULT_REPO_ROOT,
  runPublisher = spawnSync,
  env = process.env,
  log = (line) => console.error(line),
} = {}) {
  if (env.PAPERCUSP_SKIP_DEP_GENERATION === "1") return 0;
  const lockName = repoLockName(repoRoot);
  let publisherResult = null;
  const result = await withFsMutexRead(
    lockName,
    () => withWriterAttribution({
      repoRoot,
      nestedPath: env.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
      invocationId: env.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
      lockName,
      lockMode: "reader",
      phase: "generation-publish",
      childPid: () => publisherResult?.pid ?? null,
      log,
    }, async () => {
      // A scoped install can skip the root postinstall, and a generation cache
      // hit only proves the copied trees match their donor. Validate the donor's
      // tracked patches before either a cache hit or a fresh publication can
      // advertise success. Keep this inside the same install-reader boundary.
      if (existsSync(join(repoRoot, "patches"))) {
        try {
          const { checkInstalledPatchPostimages } = await import("./check-installed-patch-postimages.mjs");
          const patches = checkInstalledPatchPostimages({ repoRoot });
          if (!patches.ok) throw new Error(patches.errors.join("\n"));
        } catch (error) {
          log("NPM_INSTALL_SAFE_FATAL: installed patch postimages are unverified; " +
            "refusing dependency generation publication. Repair through the root postinstall " +
            "under the install writer before retrying. " +
            (error instanceof Error ? error.message : String(error)));
          return { status: 1 };
        }
      }
      publisherResult = runPublisher(
        "bash",
        // The install reader ends with this process. Retain its latest handoff
        // until a consumer can select it, using the publisher's existing
        // expiring, one-pin-per-repo/label contract (24 hours by default).
        [DEPENDENCY_GENERATION_SCRIPT, "--integration", repoRoot,
          "--retain-input-as", "npm-install-safe"],
        { cwd: repoRoot, stdio: "inherit", env },
      );
      return publisherResult;
    }),
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.error(
          `NPM_INSTALL_SAFE dependency generation waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
      waitingNoticeIntervalMs: 30_000,
    },
  );
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(
      `NPM_INSTALL_SAFE_FATAL: immutable dependency generation publish exited ${status}; the install is healthy but no checkpoint-safe generation was published.`,
    );
  }
  return status;
}

/**
 * Parse the wrapper-only target selector without stealing npm's own flags.
 * `--repo-root` is recognized only as the first wrapper argument and an
 * optional `--` cleanly separates it from the npm argv.
 */
export function parseCliArgs(
  argv = process.argv.slice(2),
  { cwd = process.cwd() } = {},
) {
  // EI-24937341882865098: a wrapper-level help request. Without this, normalizeNpmArgs turns
  // `--help` into `npm install --help`, which waits on the repo-keyed install mutex first and
  // reads as a silent multi-minute install. Only the FIRST argument is the wrapper's, so an
  // explicit `install --help` still reaches npm.
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };

  let repoRoot = DEFAULT_REPO_ROOT;
  let npmArgv = [...argv];
  let offlineSafe = false;

  if (npmArgv[0] === "--repo-root" || npmArgv[0]?.startsWith("--repo-root=")) {
    const inline = npmArgv[0].startsWith("--repo-root=")
      ? npmArgv[0].slice("--repo-root=".length)
      : null;
    const rawRoot = inline ?? npmArgv[1];
    if (!rawRoot) throw new Error("--repo-root requires a path");
    repoRoot = resolve(cwd, rawRoot);
    npmArgv = npmArgv.slice(inline === null ? 2 : 1);
  }
  if (npmArgv[0] === OFFLINE_SAFE_FLAG) {
    offlineSafe = true;
    npmArgv = npmArgv.slice(1);
  }
  if (npmArgv[0] === EXEC_UNDER_LOCK_FLAG || npmArgv[0] === "--exec-under-cache-lock") {
    const cacheRead = npmArgv[0] === "--exec-under-cache-lock";
    const commandArgs = npmArgv.slice(npmArgv[1] === "--" ? 2 : 1);
    if (commandArgs.length === 0)
      throw new Error(`${npmArgv[0]} requires a command`);
    return {
      repoRoot,
      commandArgs,
      ...(cacheRead ? { cacheRead: true } : {}),
      ...(offlineSafe ? { offlineSafe: true } : {}),
    };
  }

  if (npmArgv[0] === "--") npmArgv = npmArgv.slice(1);

  return {
    repoRoot,
    npmArgs: normalizeNpmArgs(npmArgv),
    ...(offlineSafe ? { offlineSafe: true } : {}),
  };
}

/**
 * WI-10006385: pair a lock's "waiting" notices with ONE closing line that says how long
 * the wait actually lasted and under what budget. Without it a build log shows
 * "waiting … (0s so far)" and then nothing, so nobody can tell a 1 s wait from a 50 min
 * one, or whether PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC raised the budget. Prints nothing
 * for an uncontested lock: the closing line only follows a printed notice.
 *
 * @param {{ lock: 'writer' | 'reader', describe: (owner: string, elapsedMs: number) => string, log: (line: string) => void, budgetMs: number }} opts
 * @returns {{ onWaiting: (info: { owner: string, elapsedMs: number }) => void, onAcquired: (info: { waitedMs: number }) => void }}
 */
export function installLockWaitReporter({ lock, describe, log, budgetMs }) {
  let noticed = false;
  return {
    onWaiting: ({ owner, elapsedMs }) => {
      noticed = true;
      const ownerText = String(owner).trim();
      // A writer first reserves admission, then drains protected readers.
      // Those holders are not competing installs: generation publication can
      // legitimately keep this phase occupied for much longer than reifying.
      let waitingForReaders = false;
      if (lock === "writer") {
        try {
          waitingForReaders = JSON.parse(ownerText)?.mode === "read";
        } catch {
          // Missing/unreadable owner diagnostics retain the caller's fallback.
        }
      }
      log(waitingForReaders
        ? `NPM_INSTALL_SAFE writer waiting for dependency readers (${Math.round(elapsedMs / 1000)}s so far) — holder: ${ownerText}`
        : describe(ownerText, elapsedMs));
    },
    onAcquired: ({ waitedMs }) => {
      if (!noticed) return;
      log(`NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=${lock} waitedMs=${waitedMs} budgetMs=${budgetMs}`);
    },
  };
}

/** Retained source shadows import dependencies from their recorded donor chain. */
function installReaderLockNames(repoRoot) {
  const roots = new Set();
  let root = realpathSync(repoRoot);
  while (true) {
    if (roots.has(root)) throw new Error("Cyclic retained-source dependency donor provenance");
    roots.add(root);
    const markerPath = join(root, ".git", "lint-as-committed-owner.json");
    if (!existsSync(markerPath)) break;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    // These retained roots own independently materialized dependencies. Their
    // source provenance remains useful, but it is no longer a dependency borrow.
    if (marker.dependencyMode === "independent-copy-v1") break;
    if (typeof marker.sourceRepoRoot !== "string" || !isAbsolute(marker.sourceRepoRoot)) {
      throw new Error("Missing retained-source dependency donor provenance");
    }
    root = realpathSync(marker.sourceRepoRoot);
  }
  return [...new Set([...roots].map(root => repoLockName(root)))].sort();
}

/**
 * Run a dependency reader under the SAME repo-keyed mutex as install:safe.
 * The marker environment prevents a wrapped script from recursively wrapping
 * itself while keeping the contract explicit and testable at the child seam.
 *
 * @param {{
 *   repoRoot?: string,
 *   commandArgs?: string[],
 *   runCommand?: (command: string, args: string[], options: {
 *     cwd: string, stdio: 'inherit', env: NodeJS.ProcessEnv,
 *   }) => { status?: number | null, signal?: NodeJS.Signals | null, error?: Error },
 *   acquireReadMutex?: typeof withFsMutexRead,
 *   log?: (line: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   cacheRead?: boolean — guard the shared package cache instead of repo dependencies,
 * }} [options]
 */
export async function runCommandUnderInstallMutex({
  repoRoot = DEFAULT_REPO_ROOT,
  commandArgs,
  runCommand = spawnSync,
  acquireReadMutex = withFsMutexRead,
  log = console.error,
  env = process.env,
  cacheRead = false,
} = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
  }
  const [command, ...args] = commandArgs;
  const lockNames = cacheRead ? [] : installReaderLockNames(repoRoot);
  const pendingLocks = lockNames.filter(name => !installMutexIsHeld(name, env));
  const mutexAlreadyHeld = pendingLocks.length === 0;
  const childEnv = lockNames.reduce((child, name) => envWithInstallMutex(name, child), env);
  let childStarted = false;

  const executeReader = async () => {
    if (!cacheRead && isGuardedTestRunner(commandArgs, repoRoot)) {
      const mismatches = findRootLockManifestMismatches(repoRoot);
      if (mismatches.length > 0) {
        log(formatRootLockManifestMismatches(mismatches));
        log("TEST_RUN_NOT_MEASURED reason=workspace-lock-manifest-drift");
        return TEST_FILE_EXIT_NOT_MEASURED;
      }
    }
    childStarted = true;
    // Reader diagnostics belong on stderr: callers such as ptool expose the
    // child command's stdout as a machine-readable JSON stream.
    console.error(
      `${cacheRead ? "NPM_INSTALL_SAFE guarding package-cache reader" : mutexAlreadyHeld ? "NPM_INSTALL_SAFE mutex already held; running nested reader directly" : "NPM_INSTALL_SAFE guarding reader"}: ${commandArgs.join(" ")} (root=${repoRoot}, lock=${cacheRead ? PACKAGE_CACHE_MUTEX_NAME : lockNames.join(",")})`,
    );
    const result = runCommand(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: childEnv,
    });
    if (result.error) throw result.error;
    if (result.signal) {
      // spawnSync reports a signal with status:null. Keep the shell status
      // and diagnostic so bundle callers can distinguish a killed compiler
      // from a normal compilation failure, including after candidate cleanup.
      const signalNumber = osConstants.signals[result.signal];
      const status = signalNumber ? 128 + signalNumber : 1;
      log(`NPM_INSTALL_SAFE reader terminated signal=${result.signal} exitCode=${status}`);
      return status;
    }
    return result.status ?? 1;
  };

  // A command launched by an install-safe reader inherits this marker. Its
  // nested reader for THIS repository is already inside the install boundary and must not install
  // another reader marker beneath the writer it is waiting on: that is a
  // self-deadlock when the outer command still owns the writer lock.
  // Package runners share the host cache even when their repository is isolated.
  // A repo reader marker is not proof that the cache lease is held.
  if (cacheRead) return withPackageCacheReadLease(executeReader);
  if (mutexAlreadyHeld) return executeReader();

  try {
    const acquireReader = (index) => index === pendingLocks.length
      ? executeReader()
      : acquireReadMutex(pendingLocks[index], () => acquireReader(index + 1), {
      // Reader diagnostics stay on stderr (see executeReader).
      ...installLockWaitReporter({
        lock: "reader",
        describe: (owner, elapsedMs) =>
          `NPM_INSTALL_SAFE reader waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner}`,
        log,
        // The budget withFsMutexRead itself applies (it resolves from process.env).
        budgetMs: resolveFsMutexTimeoutMs(),
      }),
      waitingNoticeIntervalMs: 30_000,
    });
    return await acquireReader(0);
  } catch (error) {
    const testFileRouter = resolve(repoRoot, "scripts/test-files.mjs");
    const invokesTestFileRouter = commandArgs.some(
      (arg) => typeof arg === "string" && resolve(repoRoot, arg) === testFileRouter,
    );
    if (childStarted || !invokesTestFileRouter) throw error;

    const message = error instanceof Error ? error.message : String(error);
    log(`NPM_INSTALL_SAFE_ERROR ${message}`);
    log(
      `TEST_FILE_NOT_MEASURED reason=install-reader-lock-acquisition — test child never started (${message})`,
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
}

/** Printed for `--help` / `-h`; never takes the install mutex. */
export const USAGE = `Usage: npm run install:safe [-- <npm args>]   (defaults to plain \`npm install\`)
       node scripts/npm-install-safe.mjs [--repo-root <path>] [--offline-safe] [--] [<npm args>]
       node scripts/npm-install-safe.mjs [--repo-root <path>] --exec-under-lock [--] <command> [args...]
       node scripts/npm-install-safe.mjs [--repo-root <path>] --exec-under-cache-lock [--] <command> [args...]

Serializes npm installs in a shared checkout behind a repo-keyed mutex, then verifies every
declared dependency landed on disk. Arguments that start with "-" get an implicit \`install\`
prepended, so \`-- --legacy-peer-deps\` means \`npm install --legacy-peer-deps\`.
--help / -h is recognised only as the first argument; use \`install --help\` for npm's own help.
Installs in roots declaring devDependencies include dev tools by default, even under
NODE_ENV=production or inherited omit config. Use --omit=dev for an explicit production install.
`;

export const RESOLUTION_STALE_ATTEMPTS_DEFAULT = 3;

/**
 * How many times a manifest-only install resolves before giving up on manifests that keep
 * changing underneath it. PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS overrides it (a positive
 * integer; 1 restores the old single-attempt behaviour); anything else uses the default.
 */
export function resolutionStaleAttempts(env = process.env) {
  const raw = env.PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS;
  if (raw === undefined || raw === "") return RESOLUTION_STALE_ATTEMPTS_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1
    ? value
    : RESOLUTION_STALE_ATTEMPTS_DEFAULT;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("commandArgs" in parsed) return runCommandUnderInstallMutex(parsed);

  const { repoRoot } = parsed;
  const npmArgs = isolateNestedProjectInstallArgs(repoRoot, developmentInstallArgs(repoRoot, parsed.npmArgs));
  assertPatchPostimageGitSource({ repoRoot, npmArgs });
  const lockName = repoLockName(repoRoot);
  const npmEnv = {
    ...npmChildEnv({
      env: process.env,
      offlineSafe: parsed.offlineSafe === true,
    }),
    PAPERCUSP_INSTALL_SAFE_ACTIVE: "1",
    PAPERCUSP_INSTALL_ATTRIBUTION_ID: randomUUID(),
    PAPERCUSP_INSTALL_ATTRIBUTION_REPO: repoRoot,
    PAPERCUSP_INSTALL_ATTRIBUTION_PATH: join(
      repoRoot,
      "apps/slack-asana-bug-drill/node_modules/@types/node/node_modules/undici-types",
    ),
    PAPERCUSP_INSTALL_ATTRIBUTION_LOCK: lockName,
  };
  const installPlan = manifestOnlyInstallPlan(npmArgs, npmEnv);
  const packageLockOnly = isPackageLockOnlyInstall(npmArgs, npmEnv);

  if (installPlan.eligible) {
    // The resolve runs outside the repo mutex, so a peer can change the manifests under it, and
    // the apply step then refuses the stale resolution. The remedy is always to re-resolve
    // against the current manifests, which needs no human, so do it here, bounded. Exiting
    // instead killed an unattended deb build after a 470 s lock wait (WI-10006714).
    const maxAttempts = resolutionStaleAttempts(process.env);
    let result;
    for (let attempt = 1; ; attempt += 1) {
      result = await runManifestOnlyInstall({
        repoRoot,
        lockName,
        npmArgs,
        npmEnv,
        plan: installPlan,
      });
      if (!result.supported || !result.stale) break;
      if (attempt >= maxAttempts) {
        console.error(
          "NPM_INSTALL_SAFE_RESOLUTION_STALE: source-changed at " + result.stale.path +
            " on all " + maxAttempts + " attempt(s); no reify ran. The manifests kept " +
            "changing while npm resolved; retry once they settle.",
        );
        break;
      }
      console.error(
        "NPM_INSTALL_SAFE_RESOLUTION_RETRY: source-changed at " + result.stale.path +
          " during attempt " + attempt + "/" + maxAttempts +
          "; no reify ran. Re-resolving against the current manifests.",
      );
    }
    if (result.supported) {
      if (result.status !== 0) return result.status;
      // Lock-only resolution applies manifests without reifying or repairing
      // node_modules. Publishing here would bind the new lock to the old
      // installed tree and can fail a healthy metadata operation on copy
      // headroom. Actual reify/repair paths still publish below.
      if (installPlan.packageLockOnly) return 0;
      return publishDependencyGeneration({ repoRoot, env: npmEnv });
    }
    console.error(
      "NPM_INSTALL_SAFE_RESOLUTION_FALLBACK: " + result.reason +
        "; running the original npm command under the repo writer.",
    );
  } else if (installPlan.reason) {
    console.error(
      "NPM_INSTALL_SAFE_RESOLUTION_FALLBACK: " + installPlan.reason +
        "; running the original npm command under the repo writer.",
    );
  }

  // Fallback commands need the same repair admission as manifest installs.
  // prune explicitly repairs extraneous packages, which declared/locked-path
  // probes cannot detect. Reserve first, then drain every existing reader.
  const repairInstalledGraph = !packageLockOnly && (npmArgs[0] === "prune" ||
    await withFsMutexRead(lockName, () => installedGraphNeedsRepair({ repoRoot, npmArgs })));

  // Lock order: repo writer → EXCLUSIVE cache (verify only, released) → shared cache
  // READ lease (reify). Verify must never overlap another checkout's reify — see
  // verifyNpmCacheExclusive (WI-10004430).
  const installStatus = await withFsMutex(
    lockName,
    async () => withWriterAttribution({
      repoRoot,
      nestedPath: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
      invocationId: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
      lockName,
      phase: "install-transaction",
    }, async () => {
      const mismatches = findRootLockManifestMismatches(repoRoot);
      if (mismatches.length > 0) {
        console.error(formatRootLockManifestMismatches(mismatches));
        return 1;
      }
      const cacheStatus = await verifyNpmCacheExclusive({
        verify: () => verifyNpmCache({ repoRoot, npmArgs, env: npmEnv }),
      });
      if (cacheStatus !== 0) {
        console.error(
          `NPM_INSTALL_SAFE_FATAL: npm cache verify exited ${cacheStatus}; cache integrity is unverified.`,
        );
        return cacheStatus;
      }
      return withPackageCacheReadLease(
        async () => {
          console.log(
            `NPM_INSTALL_SAFE running: npm ${npmArgs.join(" ")} (root=${repoRoot}, lock=${lockName})`,
          );
          // WI-10003114: a workspace-scoped command recomputes dependency-type flags from a
          // partial view of the graph; snapshot the lockfile so a flag-only rewrite can be undone.
          const lockfileBeforeScopedCommand =
            workspaceSelectorsForNpmArgs(npmArgs).length > 0
              ? readLockfileText(repoRoot)
              : undefined;
          // Tell the root `preinstall` guard that THIS install is the sanctioned one — it holds the
          // writer lock, so it cannot tear a green-checkpoint dependency copy. Without the marker the
          // guard cannot distinguish us from the bare `npm install` it exists to refuse.
          const status = await runNpmWithHeartbeat({
            phase: "install",
            args: npmArgs,
            cwd: repoRoot,
            env: npmEnv,
          });
          // A FAILED npm run reports its own error — never mask it with a dep verdict.
          if (status !== 0) return status;
          const verdict =
            packageLockOnly || process.env.PAPERCUSP_SKIP_DEP_VERIFY === "1"
              ? 0
              : await verifyDepsExtracted({ repoRoot, npmArgs, env: npmEnv });
          // After verification, because its bounded repair re-runs a scoped install.
          if (lockfileBeforeScopedCommand !== undefined) {
            const restore = restoreScopedFlagOnlyLockfileRewrite({
              repoRoot,
              beforeText: lockfileBeforeScopedCommand,
            });
            if (restore.restored)
              console.log(
                `NPM_INSTALL_SAFE kept the pre-install package-lock.json: this workspace-scoped command rewrote only npm dependency-type flags (${restore.reason}, ${restore.entries.length} entr${restore.entries.length === 1 ? "y" : "ies"}); a scoped install is not authoritative for them (WI-10003114)`,
              );
          }
          return verdict;
        },
        {
          onWaiting: ({ owner, elapsedMs }) => {
            console.log(
              `NPM_INSTALL_SAFE waiting on package-cache maintenance (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
            );
          },
        },
      );
    }),
    {
      // A queued install must not reserve every test/tool reader while a
      // protected generation snapshot is still being published (D-009).
      waitForReadersBeforeReserve: !repairInstalledGraph,
      // WI-10006385: re-announce every 30 s (was once) and close with the real wait.
      ...installLockWaitReporter({
        lock: "writer",
        describe: (owner, elapsedMs) =>
          `NPM_INSTALL_SAFE waiting on another agent's install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner}`,
        log: (line) => console.log(line),
        budgetMs: resolveFsMutexTimeoutMs(),
      }),
      waitingNoticeIntervalMs: 30_000,
    },
  );
  if (installStatus !== 0) return installStatus;
  // A fallback can still be metadata-only (for example a local tarball).
  // Its new lock describes future installs, not the unchanged node_modules.
  if (packageLockOnly) return 0;
  return publishDependencyGeneration({ repoRoot, env: npmEnv });
}

// Imported by the bundled host's metadata validator. A bundle gives every
// inlined module its entry URL; only the shared guard keeps this CLI inert.
if (isCliEntry(import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        `NPM_INSTALL_SAFE_ERROR ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
