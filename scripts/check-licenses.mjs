#!/usr/bin/env node
/**
 * License gate — npm and Rust dependency licenses.
 * Plan open-source-release-2026-09-29, P-017 / D-001, WI-10003906.
 * [owner 2026-09-29, directive #931] "lets run the npm, Rust and installer checks in CI
 * as a gate". The owner chose to BLOCK main on it (green-checkpoint + GitHub CI).
 *
 * WHY THIS EXISTS
 * Papercusp is being prepared for a public source release. A dependency under a license
 * that forbids commercial use, or a strong-copyleft license that would force the whole app
 * under its terms, must never slip in unnoticed. The first audit (2026-09-29) read each
 * package's DECLARED license by hand and found @codesandbox/nodebox (non-commercial) only
 * because someone opened its LICENSE file. This gate makes that check mechanical.
 *
 * WHY LOCKFILES, NOT node_modules
 * Tools like license-checker read the INSTALLED tree, which on this Linux box never
 * contains the macOS/Windows optional packages (sharp's libvips builds, the Claude agent
 * SDK's per-platform binaries). The lockfile records every platform's entry with its
 * declared license, so reading it covers every platform from any host.
 *
 * WHY `cargo metadata`, NOT cargo-deny
 * Cargo.lock carries no license field. `cargo metadata` resolves every crate for every
 * target and reports the crate's declared SPDX license, with nothing to install beyond
 * cargo itself — the same no-extra-binary property check-rust-advisories.mjs chose over
 * `cargo audit`. It tries --offline first and falls back to a normal (networked) resolve.
 *
 * THE POPULATION IS DERIVED, NOT LISTED
 * Lockfiles come from check-lockfile-census.mjs's filesystem walk (censusOrThrow), so a new
 * lockfile anywhere in the tree is scanned automatically. Local path crates (our own code,
 * the vendored tao/wry forks) are skipped: they are source in this repo, not dependencies.
 *
 * POLICY
 *   permissive      MIT, Apache-2.0, BSD, ISC, … — allowed.
 *   weak-copyleft   MPL, LGPL, EPL, CDDL — allowed; obligations apply only to that
 *                   component's own files (listed in the report so notices can be shipped).
 *   denied          everything else: GPL, AGPL, SSPL, BUSL, Elastic, non-commercial,
 *                   proprietary, unknown, missing, "SEE LICENSE IN …".
 * An SPDX `OR` takes the best alternative, `AND` the worst. A denied package passes only
 * through scripts/license-exceptions.json, where each entry was reviewed against the
 * package's real license text. An exception applies only while the lockfile still declares
 * exactly the `declared` value recorded in it, so a license change forces a fresh review.
 *
 * Exit codes: 0 pass · 1 denied package found (with --strict) · 2 not measured (a Cargo
 * resolve failed, or a lockfile yielded nothing) — "re-run", never "clean".
 *
 * Usage:
 *   node scripts/check-licenses.mjs                      # report, both ecosystems
 *   node scripts/check-licenses.mjs --strict             # the gate
 *   node scripts/check-licenses.mjs --ecosystem npm      # npm | cargo | all
 *   node scripts/check-licenses.mjs --list               # every package + effective license
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusOrThrow } from './check-lockfile-census.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const EXCEPTIONS_PATH = join(HERE, 'license-exceptions.json');

export const TIER = Object.freeze({ DENIED: 0, WEAK_COPYLEFT: 1, PERMISSIVE: 2 });
export const TIER_NAME = ['denied', 'weak-copyleft', 'permissive'];

/** Licenses that impose only notice/attribution obligations. */
export const PERMISSIVE = new Set([
  '0BSD', 'AFL-2.1', 'Apache-2.0', 'Artistic-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0', 'CDLA-Permissive-2.0',
  'ISC', 'MIT', 'MIT-0', 'NCSA', 'PSF-2.0', 'Python-2.0', 'Unicode-3.0', 'Unicode-DFS-2016',
  'Unlicense', 'WTFPL', 'X11', 'Zlib',
]);

/** File-level copyleft: usable in a closed or differently-licensed app; changes to the
 *  component's own files must be shared, and its license + source offer shipped. */
export const WEAK_COPYLEFT = new Set([
  'CDDL-1.0', 'CDDL-1.1', 'EPL-1.0', 'EPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MPL-1.1',
  'MPL-2.0',
]);

/**
 * Tier of one SPDX license id (a trailing `+` means "or later" and does not change it).
 * The deprecated bare LGPL ids (`LGPL-2.1`, `LGPL-2.1+`) that older packages still declare
 * map to their current `-only` / `-or-later` forms, so they classify as weak-copyleft.
 */
export function tierOfId(id) {
  const plus = id.endsWith('+');
  let bare = id.replace(/\+$/, '');
  if (/^LGPL-(2\.0|2\.1|3\.0)$/.test(bare)) bare = `${bare}-${plus ? 'or-later' : 'only'}`;
  if (PERMISSIVE.has(bare)) return TIER.PERMISSIVE;
  if (WEAK_COPYLEFT.has(bare)) return TIER.WEAK_COPYLEFT;
  return TIER.DENIED;
}

/**
 * Evaluate an SPDX license expression. Returns { tier, ids } where `ids` are the license
 * ids that decided the verdict's worst branch. Legacy separators are accepted because real
 * lockfiles carry them: `MIT/Apache-2.0` (old Cargo style) reads as OR, and lowercase
 * operators read like uppercase. A malformed expression is DENIED, never guessed at.
 */
export function evaluateExpression(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return { tier: TIER.DENIED, ids: [] };
  const src = expression.replace(/\s*\/\s*/g, ' OR ').replace(/([()])/g, ' $1 ');
  const tokens = src.split(/\s+/).filter(Boolean);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t, op) => typeof t === 'string' && t.toUpperCase() === op;
  const fail = () => { throw new Error(`malformed SPDX expression: ${expression}`); };

  function parseOr() {
    let node = parseAnd();
    while (isOp(peek(), 'OR')) { pos++; node = { op: 'OR', left: node, right: parseAnd() }; }
    return node;
  }
  function parseAnd() {
    let node = parseWith();
    while (isOp(peek(), 'AND')) { pos++; node = { op: 'AND', left: node, right: parseWith() }; }
    return node;
  }
  function parseWith() {
    const node = parseAtom();
    if (isOp(peek(), 'WITH')) { pos++; if (!peek() || peek() === ')' || peek() === '(') fail(); pos++; }
    return node;
  }
  function parseAtom() {
    const t = peek();
    if (t === undefined) fail();
    if (t === '(') { pos++; const inner = parseOr(); if (peek() !== ')') fail(); pos++; return inner; }
    if (t === ')' || isOp(t, 'OR') || isOp(t, 'AND') || isOp(t, 'WITH')) fail();
    pos++;
    return { id: t };
  }
  function evalNode(node) {
    if (node.id) return { tier: tierOfId(node.id), ids: [node.id] };
    const a = evalNode(node.left);
    const b = evalNode(node.right);
    if (node.op === 'OR') return a.tier >= b.tier ? a : b;
    const tier = Math.min(a.tier, b.tier);
    return { tier, ids: [...a.ids, ...b.ids].filter((id) => tierOfId(id) === tier) };
  }

  try {
    const tree = parseOr();
    if (pos !== tokens.length) fail();
    return evalNode(tree);
  } catch {
    return { tier: TIER.DENIED, ids: [expression] };
  }
}

/**
 * The license string a lockfile entry declares. npm records `license` as a string, but
 * legacy packages carry an array of ids or of `{ type }` objects; those read as OR.
 * A package with no license field declares the sentinel `<none>`.
 */
export function declaredNpmLicense(entry) {
  const raw = entry?.license ?? entry?.licenses;
  if (raw === undefined || raw === null || raw === '') return '<none>';
  if (typeof raw === 'string') return raw;
  const items = (Array.isArray(raw) ? raw : [raw])
    .map((x) => (typeof x === 'string' ? x : x?.type))
    .filter((x) => typeof x === 'string' && x !== '');
  return items.length ? items.join(' OR ') : '<none>';
}

/** Every third-party package in one npm lockfile: { name, version, declared }. */
export function npmPackagesOf(lockJson) {
  const out = [];
  for (const [key, entry] of Object.entries(lockJson?.packages ?? {})) {
    if (!key.includes('node_modules/') || entry?.link) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: entry.version ?? '?', declared: declaredNpmLicense(entry) });
  }
  return out;
}

/** Every registry/git crate in `cargo metadata` output (path crates are this repo's source). */
export function cargoPackagesOf(metadata) {
  return (metadata?.packages ?? [])
    .filter((p) => p.source !== null && p.source !== undefined)
    .map((p) => ({
      name: p.name,
      version: p.version,
      declared: p.license ?? (p.license_file ? `<license-file:${p.license_file}>` : '<none>'),
    }));
}

/**
 * Classify packages against the policy and the reviewed exceptions for one ecosystem.
 * Pure: every input is passed in, so the guard test runs on fixtures.
 */
export function classify(packages, exceptions = {}) {
  const seen = new Map();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!seen.has(key)) seen.set(key, { ...pkg, lockfiles: new Set() });
    if (pkg.lockfile) seen.get(key).lockfiles.add(pkg.lockfile);
  }
  const rows = [];
  const usedExceptions = new Set();
  for (const pkg of seen.values()) {
    const exc = exceptions[pkg.name];
    let effective = pkg.declared;
    let tier;
    let via = 'declared';
    if (exc && exc.declared === pkg.declared) {
      usedExceptions.add(pkg.name);
      via = 'exception';
      if (exc.allow === true) { tier = TIER.PERMISSIVE; effective = `${pkg.declared} (reviewed exception)`; }
      else { effective = exc.license; tier = evaluateExpression(exc.license).tier; }
    } else {
      tier = evaluateExpression(pkg.declared).tier;
    }
    rows.push({ ...pkg, lockfiles: [...pkg.lockfiles].sort(), effective, tier, via,
      exceptionMismatch: exc && exc.declared !== pkg.declared ? exc.declared : null });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const stale = Object.keys(exceptions).filter((n) => !n.startsWith('$') && !usedExceptions.has(n)).sort();
  return {
    rows,
    denied: rows.filter((r) => r.tier === TIER.DENIED),
    weakCopyleft: rows.filter((r) => r.tier === TIER.WEAK_COPYLEFT),
    permissive: rows.filter((r) => r.tier === TIER.PERMISSIVE),
    stale,
  };
}

/** Validate the exceptions file shape; a malformed entry must not silently admit anything. */
export function validateExceptions(file) {
  const problems = [];
  for (const eco of ['npm', 'cargo']) {
    for (const [name, exc] of Object.entries(file?.[eco] ?? {})) {
      if (name.startsWith('$')) continue;
      if (typeof exc?.declared !== 'string') problems.push(`${eco}:${name} has no "declared" string`);
      if (typeof exc?.reason !== 'string' || exc.reason.trim().length < 10) problems.push(`${eco}:${name} has no real "reason"`);
      const hasLicense = typeof exc?.license === 'string';
      if (hasLicense === (exc?.allow === true)) problems.push(`${eco}:${name} needs exactly one of "license" or "allow": true`);
      if (hasLicense && evaluateExpression(exc.license).tier === TIER.DENIED) {
        problems.push(`${eco}:${name} "license" ${exc.license} is itself denied — use "allow": true with a reason if it is deliberately permitted`);
      }
    }
  }
  return problems;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectNpm(root, lockfiles) {
  const packages = [];
  const empty = [];
  for (const rel of lockfiles) {
    const pkgs = npmPackagesOf(readJson(join(root, rel)));
    // A lockfile whose package has no dependencies legitimately yields zero rows, so only
    // the ROOT lockfile is a positive control: it structurally carries the whole tree.
    if (rel === 'package-lock.json' && pkgs.length === 0) empty.push(rel);
    for (const p of pkgs) packages.push({ ...p, lockfile: rel });
  }
  return { packages, undetermined: empty.map((f) => `${f}: parsed 0 packages`) };
}

function cargoMetadata(dir) {
  const base = ['metadata', '--format-version', '1', '--locked'];
  const opts = { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 };
  try {
    return JSON.parse(execFileSync('cargo', [...base, '--offline'], opts));
  } catch {
    return JSON.parse(execFileSync('cargo', base, opts));
  }
}

function collectCargo(root, lockfiles) {
  const packages = [];
  const undetermined = [];
  for (const rel of lockfiles) {
    const dir = join(root, dirname(rel));
    if (!existsSync(join(dir, 'Cargo.toml'))) { undetermined.push(`${rel}: no Cargo.toml beside it`); continue; }
    let meta;
    try { meta = cargoMetadata(dir); } catch (err) {
      undetermined.push(`${rel}: cargo metadata failed — ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
      continue;
    }
    if (!Array.isArray(meta?.packages) || meta.packages.length === 0) { undetermined.push(`${rel}: cargo metadata returned no packages`); continue; }
    for (const p of cargoPackagesOf(meta)) packages.push({ ...p, lockfile: rel });
  }
  return { packages, undetermined };
}

function parseArgs(argv) {
  const args = { strict: false, list: false, ecosystem: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--list') args.list = true;
    else if (a === '--ecosystem') args.ecosystem = argv[++i];
    else if (a.startsWith('--ecosystem=')) args.ecosystem = a.slice('--ecosystem='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['all', 'npm', 'cargo'].includes(args.ecosystem)) throw new Error(`--ecosystem must be npm, cargo or all (got ${args.ecosystem})`);
  return args;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const args = parseArgs(argv);
  const exceptionsFile = readJson(EXCEPTIONS_PATH);
  const problems = validateExceptions(exceptionsFile);
  if (problems.length) {
    for (const p of problems) console.error(`LICENSE_GATE_EXCEPTION_INVALID ${p}`);
    console.log('LICENSE_GATE_RESULT status=fail reason=invalid-exceptions');
    return 1;
  }

  const census = censusOrThrow(root);
  const ecosystems = args.ecosystem === 'all' ? ['npm', 'cargo'] : [args.ecosystem];
  let failed = false;
  let undetermined = false;

  for (const eco of ecosystems) {
    const lockfiles = census.filter((f) => basename(f) === (eco === 'npm' ? 'package-lock.json' : 'Cargo.lock'));
    const collected = eco === 'npm' ? collectNpm(root, lockfiles) : collectCargo(root, lockfiles);
    const result = classify(collected.packages, exceptionsFile[eco] ?? {});

    console.log(`LICENSE_GATE ecosystem=${eco} lockfiles=${lockfiles.length} packages=${result.rows.length} ` +
      `permissive=${result.permissive.length} weakCopyleft=${result.weakCopyleft.length} denied=${result.denied.length} ` +
      `viaException=${result.rows.filter((r) => r.via === 'exception').length}`);

    if (args.list) for (const r of result.rows) console.log(`  ${TIER_NAME[r.tier].padEnd(13)} ${r.name}@${r.version}  ${r.effective}`);

    if (result.weakCopyleft.length) {
      const byLicense = new Map();
      for (const r of result.weakCopyleft) byLicense.set(r.effective, [...(byLicense.get(r.effective) ?? []), r.name]);
      console.log(`  weak-copyleft (allowed; ship each license + honour file-level terms):`);
      for (const [lic, names] of [...byLicense].sort()) console.log(`    ${lic}: ${[...new Set(names)].join(', ')}`);
    }
    for (const r of result.denied) {
      const hint = r.exceptionMismatch
        ? `declared license changed from the reviewed "${r.exceptionMismatch}" — re-review it`
        : `remove the dependency, or review its license text and add it to scripts/license-exceptions.json`;
      console.log(`  DENIED ${r.name}@${r.version}  "${r.declared}"  (${r.lockfiles.join(', ')}) — ${hint}`);
    }
    for (const n of result.stale) console.log(`  STALE exception ${eco}:${n} — no longer in any lockfile; delete the entry`);
    for (const u of collected.undetermined) console.log(`  UNDETERMINED ${u}`);

    if (result.denied.length) failed = true;
    if (collected.undetermined.length || (eco === 'npm' && result.rows.length === 0)) undetermined = true;
  }

  if (undetermined) {
    console.log('LICENSE_GATE_RESULT status=undetermined — part of the dependency graph was not measured; re-run');
    return 2;
  }
  console.log(`LICENSE_GATE_RESULT status=${failed ? 'fail' : 'pass'}`);
  return failed && args.strict ? 1 : 0;
}

// Basename pin (symlink-robust), matching check-lockfile-census.mjs.
if (basename(process.argv[1] ?? '') === 'check-licenses.mjs') {
  process.exitCode = main();
}
