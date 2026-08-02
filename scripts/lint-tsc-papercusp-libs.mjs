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
 * ⚠ SCOPE: this covers the libs/papercusp SUBMODULE only. The superproject roots — apps/*,
 * packages/*, libs/generic/* — are covered by its sibling `lint:tsc:workspaces`
 * (scripts/lint-tsc-workspaces.mjs, WI-7155/EI-19376779013716004), which shares this script's
 * machinery via scripts/lib/typecheck-fanout.mjs. Keep the two roots disjoint: covering a
 * package twice doubles its compile and reports one regression as two.
 *
 * Usage:
 *   npm run lint:tsc:papercusp-libs           # every discovered package; any failure reds
 *   npm run lint:tsc:papercusp-libs -- --list # discovery only, run nothing (what IS gated?)
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, looksOom, realSpawn, runOne, runPackages } from './lib/typecheck-fanout.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIBS_ROOT = join(REPO_ROOT, 'libs', 'papercusp');

// Re-exported so this module stays the stable import surface for its own test and for any
// caller that already depends on it; the implementations now live in the shared core, which is
// what keeps this fan-out and lint-tsc-workspaces.mjs from drifting apart.
export { discover, looksOom, runOne };

export function main({
  libsRoot = LIBS_ROOT,
  relativeTo = REPO_ROOT,
  listOnly = process.argv.includes('--list'),
  spawn = realSpawn,
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  // The submodule genuinely absent (a subject hive, an uninitialised checkout) is a legitimate
  // opt-out — there is nothing to gate. Distinct from "present but gating nothing" below.
  if (!existsSync(join(libsRoot, 'package.json'))) {
    log('libs/papercusp not present in this tree — nothing to typecheck.');
    return 0;
  }

  const discovered = discover(libsRoot, 0, relativeTo);
  const unreadable = discovered.filter((p) => p.unreadable);
  const packages = discovered.filter((p) => !p.unreadable).sort((a, b) => a.rel.localeCompare(b.rel));

  for (const p of unreadable) {
    error(`✗ ${p.rel}: package.json exists but could not be parsed — ${p.unreadable}`);
  }

  log(`libs/papercusp typecheck fan-out — ${packages.length} package(s) declare a typecheck script:`);
  for (const p of packages) log(`  · ${p.rel}`);

  if (listOnly) return unreadable.length > 0 ? 1 : 0;

  // Present but gating NOTHING must never be reported as a pass — but it must not RED the
  // release gate either, and that distinction was worth getting right. `libs/papercusp` is a
  // git SUBMODULE: the candidate tree checks it out at the superproject's PINNED commit, which
  // can legitimately predate the typecheck scripts (the live papercup-checkpoint tree, pinned
  // Jul 2, declares ZERO of them). Reddening here would hold `main` for the WHOLE FLEET on a
  // stale pin — "a condition no commit caused", which is precisely what the WI-6768 adoption
  // probe was made report-only to avoid.
  //
  // So the anti-silent-un-gating protection lives where it cannot hold the fleet hostage: a
  // WARN here (never a silent green — the operator log says the gate covered nothing), plus a
  // test asserting the REAL tree still declares them (lint-tsc-papercusp-libs.test.ts). A
  // genuine removal reds a TEST at development time; a stale submodule pin just warns.
  //
  // ⚠ Its sibling lint-tsc-workspaces.mjs FAILS in the same situation rather than warning. The
  // asymmetry is deliberate, not an inconsistency: those roots are in the superproject and
  // always contain packages, so discovering none there means discovery itself broke.
  if (packages.length === 0) {
    warn(
      '\n⚠ libs/papercusp is present but NO package declares a `typecheck` script — this run\n' +
        '  gated NOTHING. Not failing the release (the submodule pin may simply predate the\n' +
        '  scripts), but this is NOT evidence that libs/papercusp typechecks. If the scripts were\n' +
        '  removed or moved, restore them / update discovery in scripts/lib/typecheck-fanout.mjs.',
    );
    return 0;
  }

  const { failed } = runPackages({ packages, label: 'libs/papercusp', unreadableCount: unreadable.length, spawn, log, warn, error });
  return failed.length > 0 || unreadable.length > 0 ? 1 : 0;
}

// Only run when invoked as a CLI — the test imports the pure pieces above, and a module-level
// process.exit() would tear the test runner down on import (same pattern as lint-tsc.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
