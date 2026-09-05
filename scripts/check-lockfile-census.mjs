#!/usr/bin/env node
/**
 * P-007 — the SBOM/inventory half of the audit's F12 recommendation
 * (docs/audits/security-usability-2026-09-04.md:170, plan
 * security-boundary-remediation-and-usability-2026-09-04, WI-2144851):
 *
 *     "inventory shipped JS/Rust artifacts ... and add advisory/SBOM checks to the
 *      existing verification pipeline."
 *
 * WHY THIS EXISTS — IT IS A GENERALIZATION OF TWO MEASURED BLIND SPOTS
 *
 * Two advisory gates now guard this tree. Each scans exactly ONE lockfile:
 *
 *   check-reachable-advisories.mjs  ->  `npm audit` with cwd = REPO ROOT
 *   check-rust-advisories.mjs       ->  SHIPPED_LOCKFILES[0] (the desktop Cargo.lock)
 *
 * Both scopes are correct, and both were chosen by hand. Neither gate can see a lockfile
 * outside its own scope, so a package graph that enters the tree outside them is not
 * "reported as clean" — it is NOT MEASURED AT ALL, which reads identically from outside.
 * That is the failure mode this file exists to make loud, and it has already occurred
 * twice, both times found only because a human re-read the audit:
 *
 *   1. papercusp-desktop/src-tauri/Cargo.lock — 615 shipped crates, zero advisory
 *      coverage until 2026-09-05. `cargo audit` was not installed and
 *      check-reachable-advisories.mjs has no cargo cataloger. Fixed by the Rust gate.
 *
 *   2. papercusp-desktop/package-lock.json — the SHIPPED desktop app's own npm graph.
 *      `npm audit` at the repo root cannot reach it: papercusp-desktop is deliberately
 *      NOT a root workspace member (CLAUDE.md, "Run the emitted command"), so its
 *      dependencies are never hoisted into the root lockfile the audit walks.
 *
 * Finding #2 by hand, one day after fixing #1, is the whole argument for this guard: the
 * class recurs, and nothing in the pipeline announces it. So the census is DERIVED from
 * the filesystem and every row must be EXPLICITLY classified. A lockfile that is neither
 * scanned, nor provably subsumed by a scanned one, nor curated with a stated reason, is a
 * hard failure naming its own repair.
 *
 * This is the derived-truth ladder (CLAUDE.md) applied to the two curated scopes above:
 * rung 1 DERIVES the population, rung 4 CURATES the judgment, and the guard forces every
 * derived row into a curated bucket so the two cannot drift apart in silence.
 *
 * WHAT `subsumed` MEANS, AND WHY IT IS DERIVED RATHER THAN ASSERTED
 *
 * Three of this tree's nested package-lock.json files are vestigial: their package IS a
 * root workspace member, so npm hoists its dependencies into the root lockfile and the
 * root `npm audit` genuinely covers them. Writing that down as a curated claim would be a
 * second copy of a truth the root lockfile already owns. Instead it is read back from the
 * root lockfile's own `packages` map: a directory present there is a workspace npm
 * installed, and its transitive graph is in the audited tree. A package that stops being a
 * workspace member therefore stops being subsumed automatically, with no list to update.
 *
 * Measured 2026-09-05: 13 lockfiles — 7 Cargo.lock, 6 package-lock.json. 2 covered,
 * 3 subsumed, 6 not-shipped, 2 uncovered-baselined.
 *
 * FALSIFIABILITY
 *
 * Every leg of this guard fails CLOSED, because each of its inputs can go quietly empty:
 *   - a census that finds ZERO lockfiles is a broken walker, not a clean tree  -> refuse
 *   - a root lockfile that will not parse makes EVERY nested lock look unsubsumed, which
 *     would report the tree as full of new blind spots                          -> refuse
 *   - a curated entry naming a path that no longer exists is stale bookkeeping   -> report
 *
 * Usage:
 *   node scripts/check-lockfile-census.mjs           # report
 *   node scripts/check-lockfile-census.mjs --strict  # exit 1 on an unclassified lockfile
 *   node scripts/check-lockfile-census.mjs --sbom out.json   # emit the syft inventory
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

/** Lockfile basenames that pin a resolved dependency graph, by ecosystem. */
export const LOCKFILE_ECOSYSTEMS = new Map([
  ['package-lock.json', 'npm'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['poetry.lock', 'python'],
  ['uv.lock', 'python'],
  ['Pipfile.lock', 'python'],
  ['Gemfile.lock', 'rubygems'],
  ['composer.lock', 'composer'],
  ['pubspec.lock', 'pub'],
  ['mix.lock', 'hex'],
]);

/** Directories that never contain a lockfile we ship or audit. */
export const PRUNED_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  '_retired',
  'dist',
  '.next',
  '.papercusp',
  'coverage',
  'build',
  '.cache',
  'vendor-dist',
]);

/**
 * Lockfiles an advisory gate ACTUALLY scans, and the gate that scans each. Keep this
 * keyed by the gate's own exported scope wherever the gate exports one, so widening the
 * gate widens the census automatically instead of requiring two edits.
 */
export const COVERED_LOCKFILES = new Map([
  ['package-lock.json', 'check-reachable-advisories.mjs (npm audit, cwd=repo root)'],
  ['papercusp-desktop/src-tauri/Cargo.lock', 'check-rust-advisories.mjs (RustSec/OSV)'],
]);

/**
 * Lockfiles that do NOT describe a shipped artifact. Each states WHY — the judgment the
 * derivation cannot make. A path here that no longer exists is reported as stale so the
 * list shrinks with the tree instead of accumulating.
 */
export const NOT_SHIPPED_LOCKFILES = new Map([
  [
    'apps/tui/Cargo.lock',
    'apps/tui is a developer terminal UI built from source on a dev box; it is not bundled into any desktop installer target',
  ],
  [
    'apps/pui-zellij-plugin/Cargo.lock',
    'a zellij WASM plugin for local development panes; not referenced by any tauri.conf bundle target',
  ],
  [
    'apps/pui-companion-proto/Cargo.lock',
    'prototype companion binary (12 crates); not built or bundled by the release pipeline',
  ],
  [
    'papercusp-desktop/src-tauri/vendor/tao/Cargo.lock',
    'vendored fork checked in for `[patch]` resolution — the crates that actually build are pinned by the parent src-tauri/Cargo.lock, which IS scanned',
  ],
  [
    'papercusp-desktop/src-tauri/vendor/tauri-runtime-wry/Cargo.lock',
    'vendored fork checked in for `[patch]` resolution — see the tao entry; the parent lockfile is the one that resolves the build',
  ],
  [
    'libs/papercusp/apps/desktop/src-tauri/Cargo.lock',
    'the superseded in-submodule desktop shell; papercusp-desktop/ is the shipped Tauri app (CLAUDE.md, "Running / testing this app")',
  ],
]);

/**
 * Lockfiles that DO describe shipped or potentially-shipped code and are NOT covered by
 * any advisory gate. This is acknowledged debt, and it is SHRINK-ONLY: an entry leaves
 * when a gate starts scanning the lockfile, and a NEW uncovered lockfile is a hard
 * failure rather than a quiet append. `deps` is the measured graph size at the time of
 * baselining, so the cost of the gap is legible without re-measuring.
 */
export const UNCOVERED_BASELINE = new Map([
  [
    'papercusp-desktop/package-lock.json',
    {
      deps: 12,
      reason:
        'the shipped desktop app own npm graph. papercusp-desktop is deliberately not a root workspace member, so `npm audit` at the repo root never walks it. Small graph (12 entries), but it is SHIPPED — this is the highest-priority row here.',
    },
  ],
  [
    'libs/papercusp/packages/harness/docs-viewer/package-lock.json',
    {
      deps: 509,
      reason:
        'harness docs viewer; 509 entries, the largest uncovered graph. Not a root workspace member, so the root audit cannot reach it. Whether it ships is unsettled — resolve that first, then either gate it or move it to NOT_SHIPPED_LOCKFILES with the reason.',
    },
  ],
]);

/**
 * Walk the tree for lockfiles. Returns repo-relative POSIX paths, sorted.
 *
 * Symlinked directories are NOT followed. That is deliberate and is the opposite of the
 * `find -L` advice for cross-checkout searches: here a symlink out of the repo would
 * import a SIBLING hive's lockfiles into this repo's census, which is a false positive,
 * not a missed row. The population is bounded by the repo, so a positive control on the
 * result (see censusOrThrow) is what protects against an under-read.
 */
export function walkLockfiles(root, { pruned = PRUNED_DIRS, names = LOCKFILE_ECOSYSTEMS } = {}) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (pruned.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  return found.sort();
}

/**
 * The census plus its own falsifier. A walk that returns nothing has either been pointed
 * at the wrong root or had its prune set widened until it excludes the whole tree; both
 * produce an EMPTY offender list, which is indistinguishable from a fully-classified one.
 * The repo's own root package-lock.json is the positive control: it is the one lockfile
 * whose presence is structurally guaranteed.
 */
export function censusOrThrow(root, options) {
  const rows = walkLockfiles(root, options);
  if (rows.length === 0) {
    throw new Error(
      `lockfile census found ZERO lockfiles under ${root} — the walker is broken or mis-rooted. ` +
        'Refusing rather than reporting an empty census as a clean tree.',
    );
  }
  if (!rows.includes('package-lock.json')) {
    throw new Error(
      `lockfile census did not find the repo root package-lock.json (found ${rows.length} other ` +
        'lockfile(s)). That file is the census positive control; without it the walk cannot be ' +
        'trusted to have covered the tree.',
    );
  }
  return rows;
}

/**
 * Directories whose npm dependencies are hoisted into the root lockfile.
 *
 * Read back from the root lockfile's `packages` map rather than asserted: every root
 * workspace member appears there as its own directory key. Throws on an unreadable or
 * shapeless root lockfile, because a silent {} makes every nested lock look UNSUBSUMED —
 * turning a parse failure into a page of fabricated blind spots.
 */
export function rootWorkspaceDirs(rootLockJson) {
  const packages = rootLockJson?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(
      'root package-lock.json has no `packages` map — cannot derive which nested lockfiles are ' +
        'subsumed by the audited root graph. Refusing rather than reporting every nested lockfile ' +
        'as a new uncovered blind spot.',
    );
  }
  const dirs = new Set();
  for (const key of Object.keys(packages)) {
    if (key === '' || key.startsWith('node_modules/')) continue;
    dirs.add(key);
  }
  if (dirs.size === 0) {
    throw new Error(
      'root package-lock.json declares no workspace directories — expected dozens. Refusing: a ' +
        'zero-workspace read makes every nested lockfile look unsubsumed.',
    );
  }
  return dirs;
}

/**
 * Classify every census row into exactly one bucket. Pure: all IO is the caller's.
 *
 * @param {object} input
 * @param {string[]} input.lockfiles          repo-relative census rows
 * @param {Set<string>} input.workspaceDirs   directories hoisted into the root lockfile
 * @param {Map<string,string>} [input.covered]
 * @param {Map<string,string>} [input.notShipped]
 * @param {Map<string,{deps:number,reason:string}>} [input.uncovered]
 */
export function classifyCensus({
  lockfiles,
  workspaceDirs,
  covered = COVERED_LOCKFILES,
  notShipped = NOT_SHIPPED_LOCKFILES,
  uncovered = UNCOVERED_BASELINE,
}) {
  const rows = [];
  for (const path of lockfiles) {
    const name = path.split('/').pop() ?? path;
    const ecosystem = LOCKFILE_ECOSYSTEMS.get(name) ?? 'unknown';
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

    if (covered.has(path)) {
      rows.push({ path, ecosystem, bucket: 'covered', note: covered.get(path) });
      continue;
    }
    // Derived, not asserted: an npm lockfile whose directory is a root workspace member
    // has its graph hoisted into the audited root lockfile.
    if (ecosystem === 'npm' && dir !== '' && workspaceDirs.has(dir)) {
      rows.push({
        path,
        ecosystem,
        bucket: 'subsumed',
        note: `${dir} is a root workspace member; its dependencies hoist into the audited root lockfile`,
      });
      continue;
    }
    if (notShipped.has(path)) {
      rows.push({ path, ecosystem, bucket: 'not-shipped', note: notShipped.get(path) });
      continue;
    }
    if (uncovered.has(path)) {
      const entry = uncovered.get(path);
      rows.push({
        path,
        ecosystem,
        bucket: 'uncovered-baselined',
        deps: entry.deps,
        note: entry.reason,
      });
      continue;
    }
    rows.push({ path, ecosystem, bucket: 'UNCLASSIFIED' });
  }

  // A curated entry pointing at a path the census no longer contains is stale. Reported,
  // never fatal: deleting a lockfile is a good thing, and failing the build for it would
  // punish the cleanup.
  const present = new Set(lockfiles);
  const stale = [];
  for (const [source, map] of [
    ['COVERED_LOCKFILES', covered],
    ['NOT_SHIPPED_LOCKFILES', notShipped],
    ['UNCOVERED_BASELINE', uncovered],
  ]) {
    for (const path of map.keys()) {
      if (!present.has(path)) stale.push({ path, source });
    }
  }

  const offenders = rows.filter((r) => r.bucket === 'UNCLASSIFIED');
  const byBucket = {};
  for (const row of rows) byBucket[row.bucket] = (byBucket[row.bucket] ?? 0) + 1;

  return { rows, offenders, stale, byBucket, total: rows.length };
}

/** Lockfiles the SBOM should inventory: everything that ships and is not vestigial. */
export function sbomSubjects(rows) {
  return rows
    .filter((r) => r.bucket === 'covered' || r.bucket === 'uncovered-baselined')
    .map((r) => r.path);
}

/**
 * Emit a CycloneDX inventory of the shipped lockfiles via syft.
 *
 * syft is a dev-box tool, not a pipeline dependency, so its ABSENCE must refuse loudly:
 * an SBOM step that silently skips when the binary is missing produces no file and a
 * green exit, which is the same "measured nothing" reading this whole guard is built to
 * prevent. The gate legs above never touch syft, so the gate stays runnable without it.
 */
export function emitSbom(subjects, outPath, { root = ROOT, syft = process.env.SYFT_BIN } = {}) {
  const bin = syft || join(process.env.HOME ?? '', '.local', 'bin', 'syft');
  if (!existsSync(bin)) {
    throw new Error(
      `syft not found at ${bin} — cannot emit the shipped-artifact inventory. Install syft or set ` +
        'SYFT_BIN. Refusing rather than writing no SBOM and exiting 0.',
    );
  }
  const documents = [];
  for (const subject of subjects) {
    const out = execFileSync(
      bin,
      ['scan', `file:${join(root, subject)}`, '-o', 'cyclonedx-json', '-q'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out);
    const components = parsed.components?.length ?? 0;
    if (components === 0) {
      throw new Error(
        `syft catalogued ZERO components from ${subject}. An empty inventory is not evidence of a ` +
          'small dependency graph; it means the cataloger did not read the file.',
      );
    }
    documents.push({ subject, components, bom: parsed });
  }
  writeFileSync(outPath, `${JSON.stringify({ generatedFrom: subjects, documents }, null, 2)}\n`);
  return documents.map(({ subject, components }) => ({ subject, components }));
}

function main(argv) {
  const strict = argv.includes('--strict');
  const sbomIdx = argv.indexOf('--sbom');
  const sbomOut = sbomIdx >= 0 ? argv[sbomIdx + 1] : null;

  const lockfiles = censusOrThrow(ROOT);
  const rootLock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const workspaceDirs = rootWorkspaceDirs(rootLock);
  const result = classifyCensus({ lockfiles, workspaceDirs });

  const order = ['covered', 'subsumed', 'not-shipped', 'uncovered-baselined', 'UNCLASSIFIED'];
  console.log(`lockfile census: ${result.total} lockfile(s)`);
  for (const bucket of order) {
    if (result.byBucket[bucket]) console.log(`  ${String(result.byBucket[bucket]).padStart(3)}  ${bucket}`);
  }

  const uncoveredRows = result.rows.filter((r) => r.bucket === 'uncovered-baselined');
  if (uncoveredRows.length > 0) {
    const deps = uncoveredRows.reduce((n, r) => n + (r.deps ?? 0), 0);
    console.log(`\n⚠ ${uncoveredRows.length} shipped lockfile(s) with NO advisory coverage (~${deps} deps) — baselined debt, shrink-only:`);
    for (const row of uncoveredRows) console.log(`     ${row.path}  (${row.deps} deps)\n       ${row.note}`);
  }

  for (const row of result.stale) {
    console.log(`\n⚠ stale ${row.source} entry: ${row.path} is no longer in the tree — remove it.`);
  }

  if (result.offenders.length > 0) {
    console.log(`\n❌ ${result.offenders.length} lockfile(s) are in NO classification:`);
    for (const row of result.offenders) console.log(`     ${row.path}  [${row.ecosystem}]`);
    console.log(
      '\n   A lockfile nobody has classified is a dependency graph nobody is scanning — the exact\n' +
        '   shape of the two blind spots this guard was built from. Pick one, deliberately:\n' +
        '     • COVER it — extend an advisory gate to scan it, then add it to COVERED_LOCKFILES.\n' +
        '     • DECLARE it unshipped — add it to NOT_SHIPPED_LOCKFILES with the reason it does not ship.\n' +
        '     • BASELINE it — add it to UNCOVERED_BASELINE with its measured dep count and why the\n' +
        '       coverage is not there yet. That list is shrink-only; it is debt, recorded, not hidden.',
    );
  }

  if (sbomOut) {
    const emitted = emitSbom(sbomSubjects(result.rows), sbomOut);
    console.log(`\nSBOM written to ${sbomOut}:`);
    for (const row of emitted) console.log(`     ${row.subject}  ${row.components} components`);
  }

  if (strict && result.offenders.length > 0) process.exit(1);
}

/**
 * Basename pin, not `import.meta.url === file://${argv[1]}`. This gate must stay
 * importable with no operator-core dependency (it runs standalone, before any build), and
 * the naive URL comparison becomes true for EVERY inlined module once esbuild bundles a
 * tree — which is how an imported CLI's main() ends up running during host boot.
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-lockfile-census\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
