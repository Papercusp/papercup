/**
 * Shared core for the typecheck fan-out gates (WI-7155 / EI-19376779013716004).
 *
 * Extracted VERBATIM from scripts/lint-tsc-papercusp-libs.mjs (WI-6841), which had already
 * solved every hard part of this problem and solved it well: discovery instead of a hardcoded
 * roster, an OOM retry-then-skip that refuses to red the gate for a load condition no commit
 * caused, an infrastructure-vs-real-error distinction, and a present-but-gating-nothing warning
 * that refuses to report a vacuous green. EI-19376779013716004 was filed claiming "no prior art
 * in the repo does a repo-wide tsconfig discovery" — half wrong, and the half that was wrong is
 * the half that mattered. This module exists so the SECOND caller reuses that work rather than
 * reimplementing it (and drifting from it).
 *
 * Two callers, one core:
 *   - scripts/lint-tsc-papercusp-libs.mjs  — the libs/papercusp submodule (8 packages)
 *   - scripts/lint-tsc-workspaces.mjs      — apps/*, packages/*, libs/generic/*
 *
 * The split between them is genuine, not incidental: libs/papercusp is a git SUBMODULE whose
 * pin can legitimately predate its typecheck scripts, so "present but gating nothing" must WARN
 * rather than red. The superproject roots have no such excuse.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export const SKIP_DIRS = new Set([
  'node_modules',
  '_retired',
  'dist',
  'build',
  '.git',
  'coverage',
  '.turbo',
]);

/** Deep enough for packages/harness/docs-viewer (3), with headroom; bounded so a symlink loop
 *  or a stray vendored tree can never turn discovery into an unbounded walk. */
export const MAX_DEPTH = 5;

/** Directory entries worth descending into — shared by both walks so they cannot disagree
 *  about what "inside the tree" means (a symlink out of the tree is never followed). */
function childDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const child = join(dir, e.name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(child);
  }
  return out;
}

/** Every package.json under `dir` that declares a `typecheck` script. `relativeTo` only shapes
 *  the human-readable `rel` label (the repo root in production, a fixture root in tests) —
 *  discovery itself is driven entirely by `dir`.
 *
 *  DISCOVERY, not a hardcoded list. A new package that adds a `typecheck` script is gated the
 *  moment it lands; a hardcoded roster would reproduce the exact silently-not-gated defect these
 *  items are about, one level further down. */
export function discover(dir, depth = 0, relativeTo = dir) {
  if (depth > MAX_DEPTH) return [];
  const found = [];
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      // A package.json that exists but will not parse is NOT "this package opts out"
      // (WI-6056's discipline, one level down): report it as a hard failure rather than
      // letting a corrupt/partial file silently shrink the gated set.
      found.push({ dir, rel: relative(relativeTo, dir), unreadable: String(err?.message ?? err) });
      return found;
    }
    if (pkg?.scripts?.typecheck) {
      found.push({
        dir,
        name: pkg.name ?? relative(relativeTo, dir),
        rel: relative(relativeTo, dir),
        typecheckScript: String(pkg.scripts.typecheck),
      });
    }
  }
  for (const child of childDirs(dir)) found.push(...discover(child, depth + 1, relativeTo));
  return found;
}

/** Every directory under `dir` that HAS a tsconfig.json but declares NO `typecheck` script.
 *
 *  This is the population EI-19376779013716004 is really about, and the one the WI-6841 fan-out
 *  cannot reach by construction: discovery there is by OPT-IN (the package declares a script),
 *  so a package that never declares one is not "passing" — it is INVISIBLE to every routine
 *  gate, and no amount of running the fan-out will ever say so. Reporting it is what turns the
 *  ABSENCE of a gate into a finding rather than silence.
 *
 *  Deliberately report-only at this stage. 61 such directories exist as of 2026-08-02 under
 *  apps/*, packages/* and libs/generic/* — the live count is printed on every run, so trust that
 *  over this comment. None of them has ever been typechecked by anything; making absence blocking
 *  in the same change that first measures it would red-pin the shared gate for the whole fleet —
 *  inflicting precisely the failure the item exists to prevent, with its own fix. */
export function discoverInvisible(dir, depth = 0, relativeTo = dir) {
  if (depth > MAX_DEPTH) return [];
  const found = [];
  if (existsSync(join(dir, 'tsconfig.json'))) {
    let pkg = null;
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch {
        // A corrupt package.json is reported by discover() above as a hard failure; here it
        // simply means we cannot prove a typecheck script exists, so the dir counts as invisible.
        pkg = null;
      }
    }
    if (!pkg?.scripts?.typecheck) {
      found.push({ dir, rel: relative(relativeTo, dir), name: pkg?.name ?? null });
    }
  }
  for (const child of childDirs(dir)) found.push(...discoverInvisible(child, depth + 1, relativeTo));
  return found;
}

/** tsc under fleet load gets OOM-killed; that is an INFRASTRUCTURE outcome, never a verdict
 *  about the code (EI-18667028218882894). Detect it so we retry-then-skip instead of reddening
 *  the release gate for a condition no commit caused. */
export function looksOom(res) {
  if (res.signal === 'SIGKILL' || res.signal === 'SIGABRT') return true;
  if (res.status === 134 || res.status === 137) return true;
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return /JavaScript heap out of memory|FATAL ERROR:.*heap|Killed process|Cannot allocate memory/i.test(text);
}

/** The real spawn seam — replaced in tests so the aggregation logic is asserted without
 *  running real tsc projects. */
export const realSpawn = (pkg) =>
  spawnSync('npm', ['run', 'typecheck'], {
    cwd: pkg.dir,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });

export function runOne(pkg, spawn = realSpawn, warn = console.warn) {
  let res = spawn(pkg);
  if (looksOom(res)) {
    warn(`⚠ ${pkg.rel}: typecheck looks OOM-killed under load — retrying once`);
    res = spawn(pkg);
    if (looksOom(res)) {
      warn(
        `⚠ ${pkg.rel}: OOM-killed again — SKIPPING this package rather than reddening the gate ` +
          `for a load condition no commit caused (EI-18667028218882894). It is NOT verified this run.`,
      );
      return { ...pkg, status: 'skipped-oom' };
    }
  }
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status === 0) return { ...pkg, status: 'passed' };
  // A non-zero run with ZERO parseable diagnostics is an INFRASTRUCTURE failure, never
  // "0 errors" — reading a crashed run as clean is what once lowered a watermark 170→0 and
  // red-pinned the gate (WI-4721). Say which it is so the reader is not left staring at a
  // failure block with no error lines in it.
  const diagnostics = out.split('\n').filter((l) => /error TS\d+/.test(l)).length;
  return {
    ...pkg,
    status: 'failed',
    infrastructure: diagnostics === 0,
    exit: res.status,
    signal: res.signal ?? null,
    output: out,
  };
}

/**
 * Run every package, print a per-package line with its timing, then one coherent failure block.
 * Returns the results plus the counts, so the caller decides what is fatal — the same fan-out
 * is BLOCKING for libs/papercusp and, per-package, advisory for a newly-covered root.
 */
export function runPackages({
  packages,
  label,
  unreadableCount = 0,
  spawn = realSpawn,
  log = console.log,
  warn = console.warn,
  error = console.error,
}) {
  const results = [];
  for (const pkg of packages) {
    const started = Date.now();
    const r = runOne(pkg, spawn, warn);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const mark = r.status === 'passed' ? '✓' : r.status === 'skipped-oom' ? '⚠' : '✗';
    log(`${mark} ${pkg.rel} (${secs}s)${r.status === 'skipped-oom' ? ' — SKIPPED (OOM)' : ''}`);
    results.push(r);
  }

  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped-oom');
  const passed = results.filter((r) => r.status === 'passed');

  for (const f of failed) {
    error(`\n--- ${f.rel} — npm run typecheck exited ${f.exit}${f.signal ? ` (${f.signal})` : ''} ---`);
    if (f.infrastructure) {
      error(
        '⚠ NON-ZERO EXIT WITH ZERO PARSEABLE `error TS` LINES — treat this as an INFRASTRUCTURE\n' +
          '  failure (a crashed/misconfigured tsc), NOT as "0 errors" (WI-4721).',
      );
    }
    error(f.output.trimEnd());
  }

  log(
    `\n${label} typecheck: ${passed.length} passed, ${failed.length} failed` +
      `${skipped.length ? `, ${skipped.length} skipped (OOM)` : ''}` +
      `${unreadableCount ? `, ${unreadableCount} unreadable package.json` : ''}.`,
  );

  return { results, failed, skipped, passed };
}
