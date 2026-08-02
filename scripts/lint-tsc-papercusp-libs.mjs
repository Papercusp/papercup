#!/usr/bin/env node
/**
 * typecheck fan-out over every `libs/papercusp` workspace that declares a `typecheck` script.
 *
 * WI-6841: eight libs/papercusp packages had earned a typecheck gate one at a time
 * (libs/db, packages/{file-claim, blueprint-distribution, harness, harness/docs-viewer,
 * locks}, plugins/gitnexus-bridge at a strict zero; packages/orchestrator on a per-file
 * baseline, WI-6826) — and NOTHING EXECUTED ANY OF THEM. `test:affected` is type-blind by
 * design (esbuild/Vitest never typechecks), `lint:tsc` resolves to packages/operator-core
 * alone, and `libs/papercusp/package.json` has no typecheck equivalent to `build`/`test
 * --workspaces`. So a type regression anywhere under libs/papercusp surfaced NOWHERE: the
 * gates existed, passed when run by hand, and gated nothing.
 *
 * ⚠ This script alone does NOT fix that — a fan-out nobody calls has the identical defect one
 * level up, which is the whole trap WI-6841 exists to avoid. It is wired as a POST-SUITE LEG in
 * `runPostSuiteLegs` (apps/operator/lib/release/green-checkpoint.ts), immediately after the
 * operator-core typecheck leg. The leg is what gives this teeth; keep them wired together.
 *
 * Cost (measured 2026-08-02 through `capability:bash` at load 107, uncoalesced):
 * orchestrator 6.4s (the largest, 157 files) · gitnexus-bridge 3.4s · blueprint-distribution
 * 2.7s · locks 1.9s · file-claim 1.6s · harness 1.6s · libs/db 15.1s. **≈33s total against a
 * ~55min suite (~1%).** One aggregating leg, not eight, keeps the failure block readable and
 * pays the pc-heavy admission toll once.
 * ⚠ Do NOT re-derive that from wall-clock on the dev box: `pc-heavy.sh`'s WI-3821 admission
 * gate QUEUES under load, so wall-clock = queue + execution and the queue is wildly variable
 * (the same orchestrator run read 6.4s and, minutes earlier, hit a 10-minute timeout).
 *
 * DISCOVERY, not a hardcoded list. A new libs/papercusp package that adds a `typecheck`
 * script is gated the moment it lands — a hardcoded roster would reproduce the exact
 * silently-not-gated defect this item is about, one level further down.
 *
 * Usage:
 *   npm run lint:tsc:papercusp-libs           # every discovered package; any failure reds
 *   npm run lint:tsc:papercusp-libs -- --list # discovery only, run nothing (what IS gated?)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIBS_ROOT = join(REPO_ROOT, 'libs', 'papercusp');
const SKIP_DIRS = new Set(['node_modules', '_retired', 'dist', 'build', '.git', 'coverage', '.turbo']);
/** Deep enough for packages/harness/docs-viewer (3), with headroom; bounded so a symlink
 *  loop or a stray vendored tree can never turn discovery into an unbounded walk. */
const MAX_DEPTH = 5;

/** Every package.json under libs/papercusp that declares a `typecheck` script. */
function discover(dir, depth = 0) {
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
      found.push({ dir, name: relative(REPO_ROOT, dir), unreadable: String(err?.message ?? err) });
      return found;
    }
    if (pkg?.scripts?.typecheck) {
      found.push({ dir, name: pkg.name ?? relative(REPO_ROOT, dir), rel: relative(REPO_ROOT, dir) });
    }
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const child = join(dir, e.name);
    // Never follow a symlink out of the tree — discovery must stay inside libs/papercusp.
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push(...discover(child, depth + 1));
  }
  return found;
}

/** tsc under fleet load gets OOM-killed; that is an INFRASTRUCTURE outcome, never a verdict
 *  about the code (EI-18667028218882894). Detect it so we retry-then-skip instead of reddening
 *  the release gate for a condition no commit caused. */
function looksOom(res) {
  if (res.signal === 'SIGKILL' || res.signal === 'SIGABRT') return true;
  if (res.status === 134 || res.status === 137) return true;
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return /JavaScript heap out of memory|FATAL ERROR:.*heap|Killed process|Cannot allocate memory/i.test(text);
}

function runOne(pkg) {
  const opts = { cwd: pkg.dir, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 };
  let res = spawnSync('npm', ['run', 'typecheck'], opts);
  if (looksOom(res)) {
    console.warn(`⚠ ${pkg.rel}: typecheck looks OOM-killed under load — retrying once`);
    res = spawnSync('npm', ['run', 'typecheck'], opts);
    if (looksOom(res)) {
      console.warn(
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

function main() {
  const listOnly = process.argv.includes('--list');

  // The submodule genuinely absent (a subject hive, an uninitialised checkout) is a legitimate
  // opt-out — there is nothing to gate. Distinct from "present but gating nothing" below.
  if (!existsSync(join(LIBS_ROOT, 'package.json'))) {
    console.log('libs/papercusp not present in this tree — nothing to typecheck.');
    return 0;
  }

  const discovered = discover(LIBS_ROOT);
  const unreadable = discovered.filter((p) => p.unreadable);
  const packages = discovered.filter((p) => !p.unreadable).sort((a, b) => a.rel.localeCompare(b.rel));

  for (const p of unreadable) {
    console.error(`✗ ${p.name}: package.json exists but could not be parsed — ${p.unreadable}`);
  }

  console.log(`libs/papercusp typecheck fan-out — ${packages.length} package(s) declare a typecheck script:`);
  for (const p of packages) console.log(`  · ${p.rel}`);

  if (listOnly) return unreadable.length > 0 ? 1 : 0;

  // Present but gating NOTHING is the silent-un-gating class this item exists to stop — the
  // same reasoning as `lint:design-primitives` pinning its files through a router that
  // hard-fails a zero match. Fail LOUDLY instead of reporting a vacuous green.
  if (packages.length === 0) {
    console.error(
      '\n✗ libs/papercusp is present but NO package declares a `typecheck` script.\n' +
        '  This gate has lost its subjects — either the scripts were removed (restore them) or\n' +
        '  they moved (update discovery in scripts/lint-tsc-papercusp-libs.mjs). Refusing to\n' +
        '  report a vacuous pass: a gate that checks nothing must never look green (WI-6841).',
    );
    return 1;
  }

  const results = [];
  for (const pkg of packages) {
    const started = Date.now();
    const r = runOne(pkg);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const mark = r.status === 'passed' ? '✓' : r.status === 'skipped-oom' ? '⚠' : '✗';
    console.log(`${mark} ${pkg.rel} (${secs}s)${r.status === 'skipped-oom' ? ' — SKIPPED (OOM)' : ''}`);
    results.push(r);
  }

  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped-oom');

  if (failed.length) {
    for (const f of failed) {
      console.error(`\n--- ${f.rel} — npm run typecheck exited ${f.exit}${f.signal ? ` (${f.signal})` : ''} ---`);
      if (f.infrastructure) {
        console.error(
          '⚠ NON-ZERO EXIT WITH ZERO PARSEABLE `error TS` LINES — treat this as an INFRASTRUCTURE\n' +
            '  failure (a crashed/misconfigured tsc), NOT as "0 errors" (WI-4721).',
        );
      }
      console.error(f.output.trimEnd());
    }
  }

  console.log(
    `\nlibs/papercusp typecheck: ${results.filter((r) => r.status === 'passed').length} passed, ` +
      `${failed.length} failed${skipped.length ? `, ${skipped.length} skipped (OOM)` : ''}` +
      `${unreadable.length ? `, ${unreadable.length} unreadable package.json` : ''}.`,
  );

  return failed.length > 0 || unreadable.length > 0 ? 1 : 0;
}

process.exit(main());
