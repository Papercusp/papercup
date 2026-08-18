#!/usr/bin/env node
/**
 * Run exact Vitest files from the configuration that owns each file.
 *
 * A root-level `vitest --config path/to/config path/to/test` is subtly wrong for
 * package configs whose include globs are relative to their workspace. This router
 * discovers the owning cwd/config, asks `vitest list` what would actually execute,
 * fails before the run when any requested file matched zero tests, and then runs the
 * exact matched files. One command therefore works from any directory in the repo.
 *
 * Usage: npm run test:file -- path/to/a.test.ts [path/to/b.test.ts] [<vitest args>]
 * Vitest args may follow the file list directly or after an explicit `--` separator.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg, availableParallelism } from 'node:os';
import { applyWorkerCapEnv } from './lib/worker-cap.mjs';
import { stripVitestAnsi, parseTransformFailure } from './lib/vitest-summary.mjs';

// Re-exported so this module's own callers and tests (packages/operator-core/lib/__tests__/
// test-file-router.test.ts) keep importing it from here unchanged. The IMPLEMENTATION moved to
// lib/vitest-summary.mjs (WI-37607) so `test:affected` can share the one detector instead of
// having none — see that function's header for why the split existed and what it cost.
export { parseTransformFailure };
import { peekFsMutexSync } from './lib/fs-mutex.mjs';
import { repoLockName } from './npm-install-safe.mjs';
import { ensurePapercuspTmpdir } from '../libs/test-config/src/tmpdir-guard.ts';

// EI-20767792192323374 — MUST happen HERE, in the launcher, and not in vitest.config.ts.
// Vitest fixes its module-cache root as a class field initializer (`_tmpDir = join(tmpdir(),
// nanoid())`) when `new Vitest()` is constructed, which `createVitest()` does BEFORE it loads any
// vitest config — so the identical call inside @papercusp/test-config's vitest-config.ts is always
// too late for it. Left unset, that root lands at bare `/tmp/<nanoid>`: un-namespaced,
// un-attributable, and in the blast radius of anything sweeping `/tmp/*`. On 2026-08-18 something
// swept it mid-run and 5,448 rows across 4,789 files failed with `ENOENT ... mkdir
// '/tmp/<nanoid>/ssr'`, red-pinning the release gate on an infra artifact.
// Every vitest spawn below passes `env: process.env`, so this propagates to every worker — and it
// covers workspaces whose config does NOT import @papercusp/test-config (the libs/generic
// submodules, which generic-first forbids from depending on it).
ensurePapercuspTmpdir();

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// WI-5621 (2026-07-20): this is THE most frequently invoked test runner in the
// repo (CLAUDE.md tells every agent to reach for `npm run test:file` after any
// edit), yet — unlike scripts/affected-tests.mjs (capped since WI-3792) — it
// ran every invocation at Vitest's uncapped, cores-sized default fork pool. On
// a ~90-agent fleet where dozens of agents run `test:file` concurrently, that
// is the dominant source of the fleet-wide CPU oversubscription observed in
// WI-5621 (loadavg 60-100+ on a 128-core box, causing unrelated tests to flake
// under scheduling contention). Apply the same shared, load-adaptive cap
// affected-tests.mjs uses — see scripts/lib/worker-cap.mjs for the rationale.
applyWorkerCapEnv({ cores: availableParallelism(), load1: loadavg()[0] });

const UNIT_CONFIG_RE = /^vitest\.config\.(?:[cm]?[jt]s)$/;
const INTEGRATION_CONFIG_RE = /^vitest\.integration\.config\.(?:[cm]?[jt]s)$/;

// `release:trace` reports paths relative to the workspace that owns each test, while the
// root-level `test:file` command is normally invoked with repo-relative paths. Keep the
// package-relative compatibility lookup deliberately narrow: only concrete npm workspaces
// declared by the root manifest are candidates, and a path that exists in more than one
// workspace is refused instead of being routed arbitrarily.
const workspaceDirsCache = new Map();

function workspaceDirs(root) {
  const cached = workspaceDirsCache.get(root);
  if (cached) return cached;

  let patterns;
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    patterns = Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces
      : packageJson.workspaces?.packages;
  } catch {
    patterns = [];
  }
  if (!Array.isArray(patterns)) patterns = [];

  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (pattern.endsWith('/*')) {
      const parent = resolve(root, pattern.slice(0, -2));
      let entries;
      try {
        entries = readdirSync(parent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') || !existsSync(resolve(parent, entry, 'package.json'))) continue;
        dirs.push(resolve(parent, entry));
      }
    } else if (existsSync(resolve(root, pattern, 'package.json'))) {
      dirs.push(resolve(root, pattern));
    }
  }

  const result = [...new Set(dirs)];
  workspaceDirsCache.set(root, result);
  return result;
}

function isWithinRoot(candidate, root) {
  const rootRelative = relative(root, candidate);
  return rootRelative !== '..' && !rootRelative.startsWith(`..${sep}`) && !isAbsolute(rootRelative);
}

function resolveRequestedTestFile(file, root) {
  const direct = resolve(root, file);
  if (existsSync(direct) || isAbsolute(file) || file.split(/[\\/]/).includes('..')) return direct;

  const candidates = workspaceDirs(root)
    .map((dir) => resolve(dir, file))
    .filter((candidate) => isWithinRoot(candidate, root) && existsSync(candidate))
    .sort();
  if (candidates.length > 1) {
    const listed = candidates.map((candidate) => relative(root, candidate)).join(', ');
    throw new Error(`requested test file is ambiguous across workspaces: ${file} (${listed})`);
  }
  return candidates[0] ?? direct;
}

function configsIn(dir) {
  try {
    return readdirSync(dir).filter((name) => UNIT_CONFIG_RE.test(name) || INTEGRATION_CONFIG_RE.test(name));
  } catch {
    return [];
  }
}

/**
 * A directory is a config-less Vitest workspace when it holds a `package.json` whose `test`
 * script runs `vitest` but ships no explicit `vitest.config.*`. This is the standard
 * `libs/generic/*` borrowable-lib shape (CLAUDE.md § "Borrowable libraries — generic-first"):
 * its documented `npm test` is a plain config-less `vitest run` from the package cwd, so the
 * router must be able to route those files there instead of falling off the end of the walk-up.
 */
function isVitestPackageDir(dir) {
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const test = pkg?.scripts?.test;
    return typeof test === 'string' && /\bvitest\b/.test(test);
  } catch {
    return false;
  }
}

export function discoverVitestRoute(file, root = REPO_ROOT) {
  root = resolve(root);
  const absolute = resolveRequestedTestFile(file, root);
  if (!existsSync(absolute)) throw new Error(`requested test file does not exist: ${relative(root, absolute)}`);
  const rootRelative = relative(root, absolute);
  if (rootRelative.startsWith(`..${sep}`) || rootRelative === '..' || isAbsolute(rootRelative)) {
    throw new Error(`requested test file is outside the repository: ${absolute}`);
  }

  const wantsIntegration = /\.integration\.(?:test|spec)\.[cm]?[jt]sx?$/.test(absolute);
  let dir = dirname(absolute);
  let unitFallback = null;
  let packageFallback = null;
  while (dir === root || dir.startsWith(`${root}${sep}`)) {
    const configs = configsIn(dir);
    const integration = configs.find((name) => INTEGRATION_CONFIG_RE.test(name));
    const unit = configs.find((name) => UNIT_CONFIG_RE.test(name));
    if (wantsIntegration && integration) return { cwd: dir, config: integration, absolute, requested: relative(dir, absolute) };
    if (!wantsIntegration && unit) return { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    if (unit && !unitFallback) unitFallback = { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    // Nearest config-less Vitest package (`libs/generic/*` shape): its own `npm test` is a plain
    // config-less `vitest run`, so route there (config: null) when no config file owns the file.
    if (!packageFallback && configs.length === 0 && isVitestPackageDir(dir)) {
      packageFallback = { cwd: dir, config: null, absolute, requested: relative(dir, absolute) };
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  if (unitFallback) return unitFallback;
  if (packageFallback) return packageFallback;
  throw new Error(
    `no Vitest config owns ${rootRelative}; add a vitest.config.* at the workspace root or run the suite's documented non-Vitest command`,
  );
}

export function groupRoutes(routes) {
  const groups = new Map();
  for (const route of routes) {
    const key = `${route.cwd}\0${route.config}`;
    const group = groups.get(key) ?? { cwd: route.cwd, config: route.config, routes: [] };
    group.routes.push(route);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * EI-18822211427354845: a caller that wants a machine-readable report passes ONE
 * `--outputFile=<path>` through the `--` passthrough (this is exactly what the
 * `testing:run` tool does), and every group below forwarded it verbatim to its OWN
 * `vitest run`. Each group therefore OVERWROTE the previous group's report, and only
 * the LAST group survived on disk — so a caller distilling that file reported ONE
 * group as if it were the whole run. A two-workspace request whose FIRST group was
 * red came back `failed:0, failures:[]`: the verdict bit survived (callers also AND
 * the exit code) but the diagnostics silently described the wrong group.
 *
 * This is the same defect EI-13535 fixed for the router's OWN verdict, one layer up:
 * `aggregateGroupResults` already sums across groups, so the report the router emits
 * must follow the same rule rather than being last-writer-wins.
 *
 * Group 0 KEEPS the caller's exact path; only groups 1..N-1 are suffixed
 * `<base>.<index><ext>`. That is deliberate and load-bearing for the rollout: this
 * script is spawned fresh from the working tree on every run, while its `testing:run`
 * consumer is server-side code that only goes live on the next deploy. Suffixing EVERY
 * group would mean the not-yet-updated consumer finds no file at the path it asked for
 * and hard-fails `no_report` on every multi-workspace run during that window. Leaving
 * group 0 in place keeps an old consumer working exactly as well as it did before (it
 * reads one group's report), while a NEW consumer merges every `*.json` in the private
 * temp dir it owns and gets the complete run. A single-group run is byte-identical to
 * the caller's request either way.
 */
export function perGroupVitestArgs(vitestArgs, groupIndex, groupCount) {
  if (groupCount <= 1 || groupIndex === 0) return vitestArgs;
  const perGroupPath = (p) => {
    const dot = p.lastIndexOf('.');
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf(sep));
    // Only treat a dot AFTER the last separator as an extension, so a dotted
    // DIRECTORY (…/my.dir/report) is never split in the middle.
    return dot > slash && dot > 0
      ? `${p.slice(0, dot)}.${groupIndex}${p.slice(dot)}`
      : `${p}.${groupIndex}.json`;
  };
  const out = [];
  for (let i = 0; i < vitestArgs.length; i += 1) {
    const arg = vitestArgs[i];
    if (arg.startsWith('--outputFile=')) {
      out.push(`--outputFile=${perGroupPath(arg.slice('--outputFile='.length))}`);
    } else if (arg === '--outputFile' && i + 1 < vitestArgs.length) {
      out.push(arg, perGroupPath(vitestArgs[i + 1]));
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

/**
 * Strip `--outputFile` for the EI-18099113673609528 detail-recovery re-runs below.
 * Those re-run INDIVIDUAL files purely to print human-readable detail to a live
 * stdio; letting them keep the report path would clobber the group's real report
 * with a single file's results — the same last-writer-wins bug as above, arriving
 * by a different door.
 */
export function withoutOutputFileArg(vitestArgs) {
  const out = [];
  for (let i = 0; i < vitestArgs.length; i += 1) {
    const arg = vitestArgs[i];
    if (arg.startsWith('--outputFile=')) continue;
    if (arg === '--outputFile') { i += 1; continue; }
    out.push(arg);
  }
  return out;
}

export function listedFiles(output, cwd) {
  return [...new Set(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes(' > '))
      .map((line) => line.split(' > ', 1)[0]?.trim())
      .filter(Boolean)
      .map((file) => resolve(cwd, file)),
  )];
}

/**
 * The false-green refusal decision, isolated from I/O so it is unit-testable (P-009 / WI-4534).
 *
 * A run is SAFE only when three things all hold: Vitest's own `list` exited cleanly, every
 * requested file resolved to a listed test, and at least one test was listed. Zero-match and
 * partial-match are the two ways a raw `vitest run <paths>` reports success while silently
 * skipping what you asked for — vitest exits 0 on a PARTIAL match (asked 3, ran 2), and exits 0
 * on a zero match under `--passWithNoTests`. Neither is catchable by a vitest flag alone; only
 * comparing REQUESTED against what `vitest list` actually resolved catches both. This is that
 * comparison, so the caller can turn a false-green into a hard error.
 *
 * @param {{ routes: {absolute: string, requested: string}[], matched: string[], listStatus: number }} args
 * @returns {{ ok: boolean, unmatched: {absolute: string, requested: string}[], requested: number, matched: number }}
 */
export function evaluateMatch({ routes, matched, listStatus }) {
  const matchedSet = new Set(matched);
  const unmatched = routes.filter((route) => !matchedSet.has(route.absolute));
  const ok = listStatus === 0 && unmatched.length === 0 && matched.length > 0;
  return { ok, unmatched, requested: routes.length, matched: matched.length };
}

/**
 * Combine every GROUP's outcome (one per owning cwd/config — a multi-workspace request produces
 * >1) into a single honest final verdict, isolated from I/O so it is unit-testable (EI-13535).
 *
 * BUG THIS FIXES: the router used to `return` the moment ANY one group either mismatched
 * (`evaluateMatch` refused it) or its `vitest run` failed — silently abandoning every group that
 * hadn't been reached yet. A 3-file request spanning 2 workspaces (1 file in workspace A, 2 in
 * workspace B) whose workspace-A group ran first and failed reported `executed=1` and returned
 * WITHOUT EVER RUNNING (or even checking the match of) workspace B's 2 files — so an agent fixing
 * the one reported failure and re-running could get a clean `status=passed` while the other 2
 * files were NEVER EXECUTED AT ALL, exactly the false-green class this router exists to prevent
 * (CLAUDE.md's "hard-fails a zero or partial match before executing" promise did not cover this
 * cross-group case). The fix: `main` now runs EVERY group unconditionally (no early return inside
 * the loop) and this function aggregates their results afterward, so `executed` always reflects
 * every group that could run, a mismatch in one group never hides another group's files, and the
 * final status is decided from the true combined outcome.
 *
 * @param {{ requested: number, matched: number, executed: number, unmatchedCount: number, failed: boolean, launchError: boolean }[]} groupResults
 * @returns {{ ok: boolean, requested: number, matched: number, executed: number, anyUnmatched: boolean, anyFailed: boolean, launchError: boolean }}
 */
/**
 * EI-18099113673609528: Vitest 4's default (and verbose) reporter silently drops ALL per-suite
 * error detail — no "Failed Suites" section, no per-file `FAIL` line, no stack, no message —
 * when TWO OR MORE requested files fail to even COLLECT (a transform/parse/top-level-throw
 * error, not a normal assertion failure) in the same run. A single collection failure still
 * prints a full "Failed Suites" block with the underlying error; add a second simultaneous one
 * and the whole block vanishes, leaving only the bare summary lines:
 *
 *   Test Files  2 failed (2)
 *        Tests  no tests
 *
 * Reproduced directly against vitest 4.1.8 (two sibling files each with a deliberately
 * unterminated template literal, run together) — confirmed upstream reporter behavior, not a
 * flag/config issue in this repo (no custom reporter is configured; `--reporter=verbose` shows
 * the SAME empty output). Detects that exact silent-failure signature so the caller can recover
 * by re-running the files individually (where the same collection error DOES print in full).
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {boolean} true when the run failed with zero per-suite/per-test error detail
 */
export function looksLikeSilentCollectionFailure(output) {
  // EI-18819483316574031: strip ANSI FIRST. vitest colourises both the summary row and the
  // `❯ <file> (0 test)` tree rows, inserting SGR escapes between `Test Files` and its count
  // and around the `❯`/parens — so every matcher below silently missed on real (coloured)
  // output and this detector never fired outside tests, which all use clean text. Same root
  // cause, same day, as the green-checkpoint guard that let a red suite advance the pin.
  const plain = stripVitestAnsi(output ?? '');
  if (!/Test Files\s+\d+ failed/.test(plain)) return false;
  // A "Failed Suites"/"Failed Tests" block means Vitest DID print the underlying error for at
  // least one file — the single-collection-failure case, which is unaffected by this bug.
  if (/Failed Suites|Failed Tests/.test(plain)) return false;
  // Each file whose collection failed renders as "❯ <file> (0 test)" in the tree with nothing
  // beneath it (a normal per-test failure instead renders "(N test | M failed)" plus a `×` line
  // per failing test — real detail). Two or more zero-test files with no Failed-Suites block is
  // exactly the reproduced silent-failure signature (a single one always gets its own block).
  const zeroTestFiles = (plain.match(/❯\s*\S+\s*\(0 test\)/g) ?? []).length;
  return zeroTestFiles >= 2;
}

/**
 * EI-18662389554660036: a concurrent `npm install` on this shared tree rewrites
 * `node_modules` out from under every other agent's test run — `vitest`'s own
 * bin can vanish mid-install, or an overlapping second install can leave a
 * package half-written (e.g. `@vitest/mocker`'s `dist/` with only `.d.ts`
 * files, zero `.js`). Neither failure mode names its actual cause: the shell
 * reports a bare "command not found", and Node reports a bare
 * ERR_MODULE_NOT_FOUND stack into node_modules — both read exactly like a
 * real dependency/build problem. Detect the signature so the caller can print
 * an actionable hint (check for a concurrent installer) instead of leaving the
 * agent to chase a phantom bug.
 *
 * @param {string} output combined stdout+stderr of a `vitest list`/`vitest run` invocation
 * @returns {boolean} true when the output looks like node_modules was being rewritten concurrently
 */
export function looksLikeMidInstallCorruption(output) {
  if (/\bvitest:\s*not found\b/i.test(output)) return true;
  if (/ERR_MODULE_NOT_FOUND/.test(output) && /node_modules/.test(output)) return true;
  return false;
}

const MID_INSTALL_HINT =
  'TEST_FILE_MID_INSTALL_SUSPECTED node_modules looks mid-install or corrupt (a peer agent may be running ' +
  '`npm install` on this shared tree right now — see EI-18662389554660036). Check `ps aux | grep "npm install"` ' +
  'and locks:list, then retry once it finishes. Prefer `npm run install:safe` for any future install on this tree ' +
  'so it serializes instead of racing concurrent test runs.';

/**
 * EI-19304880034803985 — the hint above only ever fires on the FAILURE
 * signature (`looksLikeMidInstallCorruption`), but the dominant real symptom
 * is a HANG: `npx vitest list`/`npx vitest run` blocks indefinitely while
 * node_modules is being rewritten out from under it, so this script never
 * reaches the code that would print a hint at all — the caller just burns its
 * outer timeout (120s/560s measured) and sees an unexplained stall.
 *
 * Widen the TRIGGER rather than write a new detector (the fix `install:safe`
 * already holds is `scripts/lib/fs-mutex.mjs`'s named mutex): peek it — a
 * non-blocking read, never an acquire — immediately BEFORE each vitest spawn
 * point, and print a hint UP FRONT when it is held. This turns a silent hang
 * into a stated wait: the message is already flushed to stdout the moment the
 * (possibly-hanging) spawnSync call begins, so it survives even if the outer
 * caller kills this process on its own timeout.
 */
export function warnIfInstallInFlight(label) {
  let peek;
  try {
    peek = peekFsMutexSync(repoLockName());
  } catch {
    return; // diagnostic only — must never affect the real run
  }
  if (!peek.held) return;
  const owner = peek.owner ?? {};
  const heldSince = owner.startedAt ? ` since ${owner.startedAt}` : '';
  const pidInfo = owner.pid ? ` (pid ${owner.pid}${owner.host ? `@${owner.host}` : ''})` : '';
  console.error(
    `TEST_FILE_MID_INSTALL_SUSPECTED an \`npm install\` is in flight${pidInfo}${heldSince} — ` +
      `${label} may HANG (not fail) until it completes — see EI-19304880034803985 / EI-18662389554660036. ` +
      'Check locks:list / `ps aux | grep "npm install"`, then retry once it finishes.',
  );
}

/**
 * EI-19462803905923939 — a transform/parse failure ANYWHERE in a workspace's import graph makes
 * `vitest list` collect zero test files and exit non-zero, so the zero-match guard below fires and
 * the terminal line reads `TEST_FILE_ROUTE_ERROR ... requested=1 matched=0`. That is a statement
 * about ROUTING and about the file the caller named — and both halves are wrong: the router worked
 * perfectly and the named file was fine.
 *
 * Measured 2026-08-03: a peer mid-edit on this shared tree left `libs/generic/search/src/hybrid.ts`
 * in a broken intermediate state (a `*​/` closed a JSDoc block and the next line continued with
 * `*`). `npm run lint:tool-prompts` reported `unmatched lib/__tests__/tools-md-sync.test.ts` and
 * refused; the real cause sat ~20 lines earlier, above the `| tail -N` cut that CLAUDE.md's own
 * idioms prescribe throughout. The wrong conclusions that misattribution invites are both
 * expensive: "the router is broken / my file moved" (go debug this script) or "my change broke the
 * import graph" (go revert or bisect your own correct work).
 *
 * This changes ONLY the attribution: the zero-match refusal keeps its semantics (non-zero exit, no
 * false green, `TEST_FILE_RESULT` still absent). Reproduced against the real vitest+esbuild for
 * BOTH shapes — a broken file the caller NAMED and a broken file only reachable through the import
 * graph — whose output is byte-identical apart from the path. That is precisely why the culprit is
 * compared against the requested set instead of being assumed external: telling a caller whose own
 * file has a syntax error that "your file is fine" would just swap one confident false statement
 * for another.
 *
 * ⚠ THE IMPLEMENTATION NOW LIVES IN `lib/vitest-summary.mjs` and is re-exported at the top of this
 * file (WI-37607). The docblock above is kept here because it records WHY the detector exists and
 * what the misattribution cost — context a reader of this runner still needs.
 */

/**
 * EI-19467022057492490 — the sibling gap `transformFailureMarker` above leaves open. That fix
 * covers exactly one culprit shape: an esbuild "Transform failed with N error" parse failure.
 * `vitest list` can ALSO fail-to-collect a whole group for a RUNTIME reason — a `vi.mock` factory
 * that throws at import time, a top-level side effect that crashes, a module self-installing
 * something the batch's other files don't expect — none of which esbuild ever sees, so
 * `parseTransformFailure` returns `[]` and the caller falls back to the bare, undifferentiated
 * `TEST_FILE_ROUTE_ERROR requested=N matched=0`. That line reads as "all N requested files are
 * broken", which INVERTS the real situation when only one of them is: a peer re-running the whole
 * named set at HEAD to triage a gate red (the documented recipe CLAUDE.md itself prescribes) sees
 * every file "still red", starts fixing files that were never broken, or disbelieves a correct
 * "it's green here" report from whoever already isolated the real culprit.
 *
 * Reproduced 2026-08-03 on green-checkpoint candidate 8564677998c4 (EI-19467022057492490): a
 * 3-file GATE_HELD_BY set batched into one `test:file` call reported `matched=0` for all three
 * (`Error: [vitest] No "configureSearchDefaults" export is defined on the "@papercusp/search"
 * mock` — a vi.mock factory crash in ONE file), while two of the three collect and pass cleanly
 * the moment they are listed alone.
 *
 * Fixes the misattribution the same way `transformFailureMarker` does: name exactly which
 * requested files are broken and which are healthy, instead of leaving the caller to (wrongly)
 * infer "all of them". Isolated from I/O — `perFile` is the caller's own per-file re-list outcomes
 * (main() below performs the actual re-listing, matching the untested-orchestration /
 * tested-decision split every other attribution helper in this file already uses) — so the
 * decision of what to print is unit testable without spawning a real `vitest list`.
 *
 * @param {{ requested: string, ok: boolean }[]} perFile per-file re-list outcome, one per requested route
 * @param {string} cwd the group's cwd (for the label only)
 * @param {number} groupRequested the group's original `requested` count (for the header)
 * @param {number} groupMatched the group's original `matched` count (for the header)
 * @returns {string | null} null when nothing was broken in isolation (a different, non-per-file cause —
 *   caller keeps today's undifferentiated output rather than a misleading "all healthy" claim)
 */
export function collectionAttributionMarker({ perFile, cwd, groupRequested, groupMatched }) {
  if (!perFile || perFile.length === 0) return null;
  const broken = perFile.filter((f) => !f.ok);
  const healthy = perFile.filter((f) => f.ok);
  // Nothing collects alone either — the whole-group matched=0 has no per-file attribution to add;
  // keep today's plain route-error rather than a marker that (falsely) claims to have narrowed it.
  if (broken.length === 0) return null;
  const cwdLabel = relative(REPO_ROOT, cwd) || '.';
  const lines = [
    `TEST_FILE_COLLECTION_ATTRIBUTION (group cwd=${cwdLabel}) requested=${groupRequested} matched=${groupMatched} — ` +
      `a collection crash in ${broken.length} of ${perFile.length} requested file(s) poisoned the whole batch's ` +
      "\`vitest list\` (not an esbuild parse error — parseTransformFailure found none), which is why matched=0 " +
      'above misreports EVERY requested file as unmatched. Re-listed each file alone to attribute it:',
  ];
  for (const f of broken) lines.push(`  ✗ BROKEN  ${f.requested} — fails to collect even alone`);
  for (const f of healthy) lines.push(`  ✓ ok      ${f.requested} — collects cleanly alone; NOT the cause`);
  if (healthy.length > 0) {
    lines.push(
      '  Treat only the BROKEN file(s) as suspect. The ok file(s) are not "still red" — re-verify them ' +
        'with their own `npm run test:file -- <that one file>` rather than trusting this batch\'s route error.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the honest terminal marker for a zero-match run whose real cause was a transform failure.
 *
 * Isolated from I/O so the ATTRIBUTION — the part that can be wrong in a costly way — is unit
 * testable. esbuild prints the culprit path relative to the vite root when it is inside it and
 * absolute when it is not, so both forms are resolved against the group cwd before comparison.
 *
 * @returns {string | null} null when no transform failure is present (caller keeps today's output)
 */
export function transformFailureMarker({ locations, routes, cwd, requested, matched }) {
  if (!locations || locations.length === 0) return null;
  const requestedAbs = new Set((routes ?? []).map((route) => route.absolute));
  const named = [];
  const external = [];
  for (const loc of locations) {
    const abs = isAbsolute(loc.file) ? loc.file : resolve(cwd, loc.file);
    (requestedAbs.has(abs) ? named : external).push({ ...loc, abs });
  }
  const fmt = (loc) => `${relative(REPO_ROOT, loc.abs) || loc.abs}:${loc.line}:${loc.col}`;
  const head =
    `TEST_FILE_TRANSFORM_ERROR requested=${requested} matched=${matched} cause=transform ` +
    `culprit=${[...named, ...external].map(fmt).join(',')}`;
  if (named.length > 0) {
    return (
      `${head}\n  A file you NAMED failed to PARSE (${named.map(fmt).join(', ')}) — vitest could ` +
      'not collect it, which is why matched=0 above. That is a real syntax error in your own ' +
      'file: NOT a routing problem, and NOT a peer mid-edit. Fix the parse error printed above.'
    );
  }
  return (
    `${head}\n  The file(s) you named are FINE — a module in their import graph failed to PARSE, ` +
    'so vitest collected zero test files and the zero-match guard fired. This is NOT a routing ' +
    'problem and NOT a fault in the file you named.\n  On this shared tree that is usually a PEER ' +
    'mid-edit (EI-19462803905923939): re-run in a minute before investigating, and check ' +
    '`git status` on the module named above.'
  );
}

/**
 * EI-19425177453558152 — `-t <pattern>` matching ZERO tests used to report `status=passed`.
 *
 * `executed` in this router counts FILES, not tests, so a run where vitest collected 625 tests
 * and executed none of them still reported `executed=1 status=passed` and exit 0. The router
 * already hard-fails a zero-or-partial FILE match before executing — and CLAUDE.md advertises
 * exactly that, which is precisely what teaches callers to trust its verdict. Closing the first
 * door and leaving the second open is worse than closing neither.
 *
 * Report the pattern AS VITEST RECEIVED IT. The reported invocation was `-t 'cd + EXIT-trap'`;
 * npm's arg chain ate the quotes, so vitest got `-t cd` plus two stray POSITIONALS (which vitest
 * reads as extra FILE filters, narrowing the run further). Echoing the received form makes the
 * quote-eating self-diagnosing instead of a mystery.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {{ flag: string, pattern: string, strays: string[] } | null}
 */
export function nameFilterFrom(vitestArgs) {
  const args = vitestArgs ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const joined = /^(-t|--testNamePattern)=([\s\S]*)$/.exec(arg);
    if (joined) {
      return { flag: joined[1], pattern: joined[2], strays: positionalsAfter(args, i + 1) };
    }
    if (arg === '-t' || arg === '--testNamePattern') {
      const next = args[i + 1];
      // A trailing flag with no value: vitest never received a pattern, so there is no
      // name-filter run to police. Never invent one.
      if (next === undefined) return null;
      return { flag: arg, pattern: next, strays: positionalsAfter(args, i + 2) };
    }
  }
  return null;
}

/**
 * WI-39830 — vitest's CAC parser reads a `-`-prefixed pattern as a NEW OPTION, never as the
 * value of a preceding `-t`, so the SPLIT form makes every test whose name starts with `-`
 * unaddressable by name. Measured here against `lib/harness-invoke-once.test.ts` (65 tests, 2
 * of them named `--model=<x> …`):
 *
 *   no filter                     -> exit 0, 65 matched   (positive control)
 *   -t '--model='                 -> exit 1,  0 matched   CACError: Unknown option `--model`
 *   --testNamePattern=--model=    -> exit 0,  2 matched   (both real tests)
 *
 * A pattern CAC *does* know fails differently but just as hard (`-t '--silent'` ->
 * "option `-t, --testNamePattern <pattern>` value is missing"), so neither shape degrades to a
 * quiet wrong answer — but neither runs the test either, and an opaque CACError reads as
 * "my pattern is wrong" rather than "the router mangled it".
 *
 * This repo's test names routinely START with `--` (lint-tsc.test.ts, mutation-probe-script.test.ts,
 * harness-invoke-once.test.ts, scripts-pg-url.test.ts …), so this is a live trap, not a corner
 * case. Rewriting HERE — the one seam the `testing:run` tool, `npm run test:file`, and the
 * per-file fallback re-run all funnel through — fixes every caller at once.
 *
 * Converts unconditionally rather than sniffing for a leading dash: the joined form is
 * unambiguous for EVERY value (CAC splits on the FIRST `=`, so a pattern that itself contains
 * `=` survives intact), and one rule with no branch cannot be wrong about which branch it is in.
 * A trailing `-t` with no value is left alone — there is no pattern to join, and vitest's own
 * error for it is the correct one.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {string[]} the same args, with any split `-t <pattern>` joined to `--testNamePattern=<pattern>`
 */
export function joinNameFilterArgs(vitestArgs) {
  const args = vitestArgs ?? [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '-t' || arg === '--testNamePattern') && i + 1 < args.length) {
      out.push(`--testNamePattern=${args[i + 1]}`);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Bare (non-flag) args left after the pattern — the fingerprint of shell/npm quote-eating. */
function positionalsAfter(args, from) {
  const strays = [];
  for (let i = from; i < args.length; i += 1) {
    if (args[i].startsWith('-')) break;
    strays.push(args[i]);
  }
  return strays;
}

/**
 * How many tests actually EXECUTED, read from vitest's `Tests` summary row. Skipped is not
 * executed — that distinction IS the bug: `Tests  20 skipped (20)` is a run that measured nothing.
 *
 * Returns null when there is no readable summary row (e.g. `--reporter=json`), which the caller
 * must treat as UNVERIFIED rather than as a measured zero: fabricating a red on an unreadable
 * count is the opposite, equally expensive mistake.
 *
 * ANSI is stripped FIRST. vitest colourises this row, and EI-18819483316574031 is the same file's
 * previous instance of exactly this trap — a matcher that skipped the strip passed every
 * hand-written test and never once fired on real coloured output.
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {number | null} tests executed, or null when unreadable
 */
export function testsExecutedFrom(output) {
  const plain = stripVitestAnsi(output ?? '');
  // `Test Files` cannot match: it is `Test` + space, never `Tests` + whitespace. Take the LAST
  // row so appended output can never leave us reading a superseded summary.
  const rows = [...plain.matchAll(/^[ \t]*Tests[ \t]+(.*)$/gm)];
  if (rows.length === 0) return null;
  const body = rows[rows.length - 1][1];
  if (/^\s*no tests\b/i.test(body)) return 0;
  let ran = null;
  for (const seg of body.matchAll(/(\d+)\s+(passed|failed)\b/g)) {
    ran = (ran ?? 0) + Number(seg[1]);
  }
  if (ran !== null) return ran;
  // Only skipped/todo segments — collected, deliberately not run.
  if (/\d+\s+(skipped|todo)\b/.test(body)) return 0;
  return null;
}

/**
 * EI-19451028801041450 — the machine-reporter half of the guard above.
 *
 * `testsExecutedFrom` parses vitest's HUMAN summary row, so it is inert for any caller that
 * passes `--reporter=json`: there is no `Tests` row on stdout at all, the parse returns
 * "unreadable", and the check fails OPEN on every single call, forever. That is not a
 * hypothetical caller — `testing:run` (the surface CLAUDE.md's routing table tells every agent
 * to prefer over `npm run test:file`) ALWAYS passes `--reporter=json --outputFile=…`.
 *
 * THE GENERALIZABLE SHAPE, worth more than this fix: an output-sniffing guard silently scopes
 * itself to whichever output format its author happened to test with. It does not fail loudly
 * when a caller changes reporters — it just quietly stops being a guard, while still reporting
 * itself as working and still passing its own CLI-level verification.
 *
 * The router already KNOWS the report path (`--outputFile` is in vitestArgs and it already
 * rewrites it per group), so read the report and count EXACTLY instead of sniffing stdout.
 *
 * ⚠ The two readers MUST agree on what "executed" means, which is why they live adjacent:
 * executed = passed + failed. A skipped/pending/todo test was COLLECTED, not run — counting it
 * would defeat the whole guard, since a zero-match `-t` is precisely the case where vitest
 * collects every test and skips every one (measured: numTotalTests 19, numPendingTests 19,
 * numPassedTests 0).
 *
 * Returns `null` — never 0 — for anything unreadable (no path, missing file, malformed JSON, a
 * report without the count fields). `null` means UNVERIFIED and preserves the existing
 * three-state contract in aggregateGroupResults; fabricating a 0 here would invent reds.
 *
 * @param {string | null} reportPath value of `--outputFile`, if any
 * @param {string} [cwd] the group's cwd — vitest resolves a relative --outputFile against it
 * @returns {number | null} tests executed, or null if the report could not be read
 */
export function testsExecutedFromReport(reportPath, cwd) {
  if (!reportPath) return null;
  const resolved = isAbsolute(reportPath) ? reportPath : resolve(cwd ?? process.cwd(), reportPath);
  let report;
  try {
    report = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    return null; // diagnostic only — an unreadable report must never fail a real run
  }
  if (!report || typeof report !== 'object') return null;
  const { numPassedTests: passed, numFailedTests: failed } = report;
  if (typeof passed !== 'number' || typeof failed !== 'number') return null;
  return passed + failed;
}

/**
 * The `--outputFile` path in play for a group, or null.
 *
 * ⚠ Deliberately recognises ONLY the two bare forms `perGroupVitestArgs` rewrites
 * (`--outputFile=<p>` and `--outputFile <p>`) — NOT vitest's per-reporter
 * `--outputFile.json=<p>`. Widening this without also widening `perGroupVitestArgs` would be a
 * correctness bug, not extra coverage: a form that is not rewritten per group points every
 * group at ONE shared file, so each group would read whichever group wrote last and report
 * another group's count as its own. Keep the two functions recognising the same set.
 *
 * Last occurrence wins, matching how vitest itself treats a repeated flag.
 *
 * @param {string[]} vitestArgs args forwarded after the `--` separator
 * @returns {string | null}
 */
export function outputFilePathFrom(vitestArgs) {
  const args = vitestArgs ?? [];
  let found = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--outputFile=')) {
      found = arg.slice('--outputFile='.length);
    } else if (arg === '--outputFile' && i + 1 < args.length) {
      found = args[i + 1];
      i += 1;
    }
  }
  const trimmed = typeof found === 'string' ? found.trim() : '';
  return trimmed === '' ? null : trimmed;
}

export function aggregateGroupResults(groupResults) {
  const requested = groupResults.reduce((sum, g) => sum + g.requested, 0);
  const matched = groupResults.reduce((sum, g) => sum + g.matched, 0);
  const executed = groupResults.reduce((sum, g) => sum + g.executed, 0);
  const launchError = groupResults.some((g) => g.launchError);
  const anyUnmatched = groupResults.some((g) => g.unmatchedCount > 0);
  const anyFailed = groupResults.some((g) => g.failed);
  // Tests-executed is measured ONLY under a name filter, so three states are distinct and must
  // stay so: `undefined` = not applicable (no filter), `null` = filter present but the count was
  // unreadable, a number = measured. Collapsing unreadable into zero would fabricate reds.
  const measured = groupResults.filter((g) => typeof g.testsExecuted === 'number');
  const testsExecuted = measured.length > 0 ? measured.reduce((sum, g) => sum + g.testsExecuted, 0) : null;
  const testsUnmeasuredGroups = groupResults.filter((g) => g.testsExecuted === null).length;
  // Only a clean, fully-matched, fully-launchable run is `ok` — a launch error or ANY group's
  // partial/zero match still refuses the false-green, exactly as the single-group path always did.
  const ok = !launchError && !anyUnmatched;
  return {
    ok,
    requested,
    matched,
    executed,
    testsExecuted,
    testsUnmeasuredGroups,
    anyUnmatched,
    anyFailed,
    launchError,
  };
}

/**
 * EI-18681435059177620 — A TEST RESULT IS ONLY EVIDENCE WHEN IT NAMES THE FILE STATE IT DESCRIBED.
 *
 * This is a SHARED, concurrently-edited checkout by design (CLAUDE.md § branch discipline: no
 * branches, no worktrees, git-sync sweeps the whole tree on a schedule). A test result is therefore
 * a measurement of a MOVING TARGET, and nothing in the result used to record which target it
 * measured. The reported incident: three measurements of ONE file inside 25 minutes each described
 * a different state of it, and each was cited as though it described "the file" — producing a
 * fleet-critical false alarm ("DO NOT SHIP", hardened into a `facts:assert`) and then a false
 * all-clear ("the detach fixes it", already stale when posted). Every number was true. Only
 * mtime+git forensics by the original reporter caught either one.
 *
 * ⚠ THE DIRTY FLAG ALONE CANNOT CATCH THE MEASURED CASE, which is why these snapshots carry a
 * CONTENT FINGERPRINT and not just a clean/dirty bit. In the incident's second measurement the file
 * was dirty BEFORE the run and dirty AFTER it — what changed was its CONTENT (`runGatedDelivery`
 * was written 4 minutes after the run that "tested" it). A dirty→dirty transition is invisible to
 * `git status`, so a status-only stamp would have reported that run as correctly described and
 * reproduced the exact failure it was built to prevent.
 *
 * SCOPE, stated on the banner itself because overclaiming here is the same defect one level up:
 * this covers the paths the caller NAMED. An edit to any other module in their import graph
 * invalidates the result just as thoroughly and is NOT measured (finding that set would mean
 * resolving the graph — far past "two git calls" — and a stamp that silently implied whole-graph
 * coverage would be worse than none).
 *
 * Diagnostics MUST never affect the real run: every git call is guarded, and an unmeasurable state
 * is reported as `unknown`, NEVER as `clean`. Reporting an unmeasured path as clean would
 * manufacture exactly the false confidence this exists to remove.
 */
const PROVENANCE_UNKNOWN = 'unknown';

/**
 * Content fingerprint of one file — the drift primitive. `null` for missing/unreadable, which
 * `diffProvenanceSnapshots` treats as "cannot compare", never as "unchanged".
 */
export function fileFingerprint(absolute) {
  try {
    return createHash('sha1').update(readFileSync(absolute)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** Short HEAD sha, or null when git cannot answer (never a fabricated value). */
function gitHeadSha(root) {
  try {
    const res = run('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: root });
    if (!res || res.error || res.status !== 0) return null;
    const sha = (res.stdout ?? '').trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

/**
 * Per-path working-tree state for exactly the paths asked about.
 *
 * `-z` (NUL-separated) deliberately over plain `--porcelain`: porcelain QUOTES and escapes paths
 * containing spaces/unicode, so a text parse silently mis-keys those paths and reports them clean.
 * Rename records emit a second NUL-terminated field (the source path) which carries no `XY ` status
 * prefix — those are skipped rather than parsed as a path, so a rename can never be read as a
 * status line for some other file.
 *
 * TRACKED-NESS IS DECIDED BY `ls-files`, NOT BY THE ABSENCE OF A STATUS RECORD, and that is the
 * whole reason this takes two calls. `git status` reports an IGNORED file by collapsing it to its
 * ignored DIRECTORY (measured here: a file under the gitignored `.papercusp/scratch/` is reported
 * as the record `!! .papercusp/scratch/`, even with `--ignored=matching -uall`), so no exact-path
 * match ever fires for it. Inferring `clean` from "git named nothing for this path" therefore made
 * the most confident possible statement — reproducible by anyone — about the least reproducible
 * possible state: a file that is not in git AT ALL. `ls-files` answers tracked-ness directly and
 * is immune to that collapse.
 */
function gitPathStates(absolutePaths, root) {
  const states = new Map(absolutePaths.map((abs) => [abs, PROVENANCE_UNKNOWN]));
  if (absolutePaths.length === 0) return states;
  let tracked;
  let status;
  try {
    tracked = run('git', ['ls-files', '-z', '--', ...absolutePaths], { cwd: root });
    status = run('git', ['status', '--porcelain', '-z', '--', ...absolutePaths], { cwd: root });
  } catch {
    return states;
  }
  // Either call failing leaves every path `unknown` — never `clean`.
  if (!tracked || tracked.error || tracked.status !== 0) return states;
  if (!status || status.error || status.status !== 0) return states;

  const trackedSet = new Set(
    (tracked.stdout ?? '')
      .split('\0')
      .filter(Boolean)
      .map((p) => resolve(root, p)),
  );
  // A path git does not track is not reproducible by a peer, whether it is merely untracked or
  // ignored outright — both read `untracked` on the banner.
  for (const abs of absolutePaths) states.set(abs, trackedSet.has(abs) ? 'clean' : 'untracked');

  for (const record of (status.stdout ?? '').split('\0')) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const reported = record.slice(3);
    if (!/^[ MADRCU?!]{2}$/.test(code)) continue; // a rename's source field — not a status record
    const abs = resolve(root, reported);
    if (!states.has(abs)) continue;
    states.set(abs, code === '??' || code === '!!' ? 'untracked' : 'dirty');
  }
  return states;
}

/** Added/deleted line counts vs HEAD (staged + unstaged), for the paths git can diff. */
function gitLineDeltas(absolutePaths, root) {
  const deltas = new Map();
  if (absolutePaths.length === 0) return deltas;
  let res;
  try {
    res = run('git', ['diff', '--numstat', 'HEAD', '--', ...absolutePaths], { cwd: root });
  } catch {
    return deltas;
  }
  if (!res || res.error || res.status !== 0) return deltas;
  for (const line of (res.stdout ?? '').split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const abs = resolve(root, match[3]);
    deltas.set(abs, {
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return deltas;
}

/**
 * Snapshot the provenance of the NAMED paths. Deduped and order-stable so the pre-run and post-run
 * snapshots are directly comparable entry-for-entry.
 */
export function snapshotProvenance(absolutePaths, root = REPO_ROOT) {
  const unique = [...new Set(absolutePaths)];
  const states = gitPathStates(unique, root);
  const deltas = gitLineDeltas(unique, root);
  return {
    head: gitHeadSha(root),
    entries: unique.map((absolute) => ({
      absolute,
      path: relative(root, absolute) || absolute,
      state: states.get(absolute) ?? PROVENANCE_UNKNOWN,
      fingerprint: fileFingerprint(absolute),
      ...(deltas.get(absolute) ?? { added: null, deleted: null }),
    })),
  };
}

/** `[DIRTY +30/-0]` / `[clean]` / `[UNTRACKED]` / `[state UNKNOWN]` — the per-path suffix. */
function stateLabel(entry) {
  if (entry.state === 'clean') return '[clean]';
  if (entry.state === 'untracked') return '[UNTRACKED — exists only on this box]';
  if (entry.state === PROVENANCE_UNKNOWN) return '[state UNKNOWN — git could not be read]';
  const counts =
    typeof entry.added === 'number' && typeof entry.deleted === 'number'
      ? ` +${entry.added}/-${entry.deleted}`
      : '';
  return `[DIRTY${counts}]`;
}

/**
 * The banner, isolated from I/O so the part that can be WRONG IN A COSTLY WAY — what a pasted
 * result claims about itself — is unit testable (the tested-decision / untested-orchestration split
 * every other helper in this file follows).
 *
 * @param {{ head: string|null, entries: object[] }} snapshot
 * @param {string} phase `pre-run` or `post-run`
 */
export function formatProvenanceBanner(snapshot, phase) {
  const entries = snapshot.entries ?? [];
  const unreproducible = entries.filter((e) => e.state === 'dirty' || e.state === 'untracked');
  const unknown = entries.filter((e) => e.state === PROVENANCE_UNKNOWN);
  const head = snapshot.head ?? PROVENANCE_UNKNOWN;
  const lines = [
    `TEST_FILE_PROVENANCE head=${head} testedPaths=${entries.length} ` +
      `uncommitted=${unreproducible.length} unknown=${unknown.length} phase=${phase}`,
    `  HEAD         : ${head}`,
  ];
  entries.forEach((entry, index) => {
    lines.push(`  ${index === 0 ? 'tested files :' : '              '} ${entry.path}  ${stateLabel(entry)}`);
  });
  lines.push(
    '  scope        : the NAMED paths above only — an edit to any OTHER module in their import ' +
      'graph invalidates this result just as thoroughly and is NOT measured here',
  );
  if (unreproducible.length > 0) {
    lines.push(
      `  ⚠ ${unreproducible.length} of ${entries.length} tested path(s) carry uncommitted changes — this result ` +
        'describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.',
    );
  }
  if (unknown.length > 0) {
    lines.push(
      `  ⚠ ${unknown.length} path(s) could not be measured — treat their state as UNKNOWN, not as clean.`,
    );
  }
  return lines.join('\n');
}

/**
 * Did the ground move under the run? Compares the pre-run and post-run snapshots.
 *
 * A `null` fingerprint on EITHER side is "cannot compare", never "unchanged" — a file that became
 * unreadable mid-run is precisely the case where a silent `unchanged` would be a lie.
 */
export function diffProvenanceSnapshots(before, after) {
  const afterByPath = new Map((after?.entries ?? []).map((e) => [e.absolute, e]));
  const changed = [];
  const uncomparable = [];
  for (const prior of before?.entries ?? []) {
    const now = afterByPath.get(prior.absolute);
    if (!now) continue;
    if (prior.fingerprint === null || now.fingerprint === null) {
      uncomparable.push({ path: prior.path, reason: now.fingerprint === null ? 'unreadable after the run' : 'unreadable before the run' });
      continue;
    }
    if (prior.fingerprint !== now.fingerprint) changed.push({ path: prior.path });
  }
  const headMoved =
    before?.head != null && after?.head != null && before.head !== after.head
      ? { from: before.head, to: after.head }
      : null;
  return { changed, uncomparable, headMoved, drifted: changed.length > 0 };
}

/**
 * The drift warning, or null when nothing moved.
 *
 * ⚠ DELIBERATELY DOES NOT CHANGE THE EXIT CODE, and that is a judgment call worth stating. A tested
 * file changing mid-run genuinely means the verdict describes neither the before nor the after
 * state — but this exit code is consumed by gates, and turning a correct green into a red on a
 * DIAGNOSTIC signal would make this a new false-RED generator. False reds are expensive here too:
 * on 2026-08-12 six consecutive gate reds were all stale tree churn and zero were standing defects.
 * So the drift rides on the RESULT line instead (`provenance=drifted`), which makes it impossible
 * to paste the verdict WITHOUT its caveat — the item's actual goal — while leaving the pass/fail
 * bit meaning exactly what it always meant.
 */
export function formatProvenanceDrift(diff) {
  if (!diff || (diff.changed.length === 0 && diff.uncomparable.length === 0 && !diff.headMoved)) return null;
  const lines = [];
  if (diff.changed.length > 0 || diff.uncomparable.length > 0) {
    lines.push(
      `TEST_FILE_PROVENANCE_DRIFT changed=${diff.changed.length} uncomparable=${diff.uncomparable.length} ` +
        `headMoved=${diff.headMoved ? `${diff.headMoved.from}->${diff.headMoved.to}` : 'no'}; ` +
        'a tested path CHANGED WHILE THIS RUN WAS EXECUTING — the result below describes NEITHER the ' +
        'state it started on nor the state on disk now. Re-run before citing it as evidence.',
    );
    for (const c of diff.changed) lines.push(`  ~ ${c.path} — content changed mid-run`);
    for (const u of diff.uncomparable) lines.push(`  ? ${u.path} — ${u.reason}; drift UNKNOWN`);
  } else {
    // HEAD moved but no tested path changed: git-sync sweeps this tree on a schedule, so this is
    // routine and must NOT be dressed up as drift — say plainly that the measurement still stands.
    lines.push(
      `TEST_FILE_PROVENANCE_HEAD_MOVED from=${diff.headMoved.from} to=${diff.headMoved.to}; ` +
        'no tested path changed content, so this result still describes the files it measured ' +
        '(git-sync commits this shared tree on a schedule — a moving HEAD alone is routine).',
    );
  }
  return lines.join('\n');
}

/**
 * The fields appended to the terminal `TEST_FILE_RESULT` / `TEST_FILE_DRYRUN` line.
 *
 * This placement is the load-bearing half of the fix, for the reason already learned twice in this
 * file (EI-19462803905923939 / EI-19467022057492490): the terminal marker line is the LAST thing a
 * `| tail -N` reads — the idiom CLAUDE.md prescribes throughout — and it is the one line agents
 * actually paste into a work-item or a coord message. A banner printed only at the top scrolls out
 * of exactly the excerpt that gets quoted as evidence.
 *
 * `provenance` is three-state on purpose, mirroring this file's other three-state guards: `stamped`
 * (measured, nothing moved), `drifted` (a tested path changed mid-run), `unknown` (git unreadable —
 * NOT a clean bill).
 */
export function provenanceResultFields(snapshot, diff) {
  const entries = snapshot?.entries ?? [];
  const unknown = entries.filter((e) => e.state === PROVENANCE_UNKNOWN).length;
  const uncommitted = entries.filter((e) => e.state === 'dirty' || e.state === 'untracked').length;
  const verdict =
    diff?.drifted || (diff?.uncomparable?.length ?? 0) > 0
      ? 'drifted'
      : snapshot?.head == null || unknown > 0
        ? PROVENANCE_UNKNOWN
        : 'stamped';
  return (
    `head=${snapshot?.head ?? PROVENANCE_UNKNOWN} ` +
    `uncommittedPaths=${uncommitted}/${entries.length} provenance=${verdict}`
  );
}

function parseCli(argv) {
  const separator = argv.indexOf('--');
  // Keep the explicit separator form, but also accept the way npm users naturally forward
  // options (`test:file -- file -t pattern`). Once the first option appears, the remainder is
  // Vitest's argv; `--dry` is this router's own option and may still appear before it.
  const firstVitestArg = separator < 0
    ? argv.findIndex((arg) => arg !== '--dry' && arg.startsWith('-'))
    : -1;
  const own = separator >= 0
    ? argv.slice(0, separator)
    : firstVitestArg >= 0
      ? argv.slice(0, firstVitestArg)
      : argv;
  const vitestArgs = separator >= 0
    ? argv.slice(separator + 1)
    : firstVitestArg >= 0
      ? argv.slice(firstVitestArg)
      : [];
  const dry = own.includes('--dry');
  const files = own.filter((arg) => arg !== '--dry');
  // WI-39830: normalize the name filter to the joined form ONCE, here, so every downstream
  // consumer of `vitestArgs` gets it — the main `vitest run` spawn, the per-file fallback
  // re-run, and `nameFilterFrom` (which already accepts both forms) alike.
  return { dry, files, vitestArgs: joinNameFilterArgs(vitestArgs) };
}

function run(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function main(argv = process.argv.slice(2)) {
  const { dry, files, vitestArgs } = parseCli(argv);
  if (files.length === 0) {
    console.error('usage: npm run test:file -- <test-file> [test-file…] [-- <vitest args>]');
    return 2;
  }

  let routes;
  try {
    routes = files.map((file) => discoverVitestRoute(isAbsolute(file) ? relative(REPO_ROOT, file) : file));
  } catch (error) {
    console.error(`TEST_FILE_ROUTE_ERROR ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const groups = groupRoutes(routes);
  const nameFilter = nameFilterFrom(vitestArgs);
  console.log(`TEST_FILE_ROUTE requested=${routes.length} groups=${groups.length}`);
  // EI-18681435059177620: stamp WHAT IS ABOUT TO BE MEASURED before measuring it. Printed up front
  // as well as at the end because a run that is killed, hung, or timed out by its caller still has
  // to say which state it was describing — that partial log is exactly the one that gets pasted.
  const provenanceBefore = snapshotProvenance(routes.map((route) => route.absolute));
  console.log(formatProvenanceBanner(provenanceBefore, 'pre-run'));
  // EI-13535: every group runs UNCONDITIONALLY — a mismatch or failure in one workspace's group
  // must never abandon the OTHER groups a multi-workspace request spans (see aggregateGroupResults
  // doc for the full incident). Each iteration always records its outcome and moves on; the final
  // verdict is decided only after every group has had its chance to run.
  const groupResults = [];
  // EI-19462803905923939 / EI-19467022057492490: collected per-group so the attribution can be
  // RESTATED after the aggregate refusal below — see the comment there for why the group-level
  // print is not enough. Holds BOTH attribution shapes (esbuild transform failures and runtime
  // collection crashes) — they are mutually exclusive per group, so a flat list is fine.
  const attributionMarkers = [];
  // EI-19467022057492490: cap the per-file re-list fallback so a pathologically large batch (a
  // huge GATE_HELD_BY set) cannot turn one route error into dozens of extra `vitest list` spawns.
  // Above this, the caller gets today's plain (undifferentiated) route error and re-runs files
  // individually by hand — exactly the documented fallback, just not auto-attributed.
  const MULTI_FILE_ATTRIBUTION_CAP = 25;
  for (const [groupIndex, group] of groups.entries()) {
    const cwdLabel = relative(REPO_ROOT, group.cwd) || '.';
    // EI-18822211427354845: each group writes its OWN report file when the run spans
    // several groups, so one group's report can never overwrite another's.
    const groupVitestArgs = perGroupVitestArgs(vitestArgs, groupIndex, groups.length);
    const requested = group.routes.map((route) => route.requested);
    // A null config is a config-less Vitest package (libs/generic/* shape): omit `--config`
    // entirely so Vitest auto-discovers its defaults from the package cwd, exactly as its own
    // documented `npm test` (`vitest run`) does.
    const configArgs = group.config ? ['--config', group.config] : [];
    console.log(`ROUTE cwd=${cwdLabel} config=${group.config ?? '(package default)'}`);
    for (const file of requested) console.log(`  requested ${file}`);

    warnIfInstallInFlight(`\`vitest list\` (group cwd=${cwdLabel})`);
    const listed = run('npx', ['vitest', 'list', ...configArgs, ...requested], {
      cwd: group.cwd,
      env: process.env,
    });
    const listedOutput = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}${listed.error ? listed.error.message : ''}`;
    if (listed.error) {
      console.error(`TEST_FILE_ROUTE_ERROR (group cwd=${cwdLabel}) could not launch Vitest: ${listed.error.message}`);
      if (looksLikeMidInstallCorruption(listedOutput)) {
        console.error(MID_INSTALL_HINT);
      }
      groupResults.push({
        requested: group.routes.length,
        matched: 0,
        executed: 0,
        unmatchedCount: group.routes.length,
        failed: false,
        launchError: true,
      });
      continue;
    }
    const matched = listedFiles(`${listed.stdout ?? ''}\n${listed.stderr ?? ''}`, group.cwd);
    const verdict = evaluateMatch({ routes: group.routes, matched, listStatus: listed.status });
    if (!verdict.ok) {
      if (listed.stdout) process.stdout.write(listed.stdout);
      if (listed.stderr) process.stderr.write(listed.stderr);
      for (const route of verdict.unmatched) console.error(`  unmatched ${route.requested}`);
      console.error(
        `TEST_FILE_ROUTE_ERROR (group cwd=${cwdLabel}) requested=${verdict.requested} matched=${verdict.matched}; refusing a false-green zero/partial-match run for this group`,
      );
      if (looksLikeMidInstallCorruption(listedOutput)) {
        console.error(MID_INSTALL_HINT);
      }
      // EI-19462803905923939: a transform failure anywhere in the import graph produces exactly
      // this zero match, so name the real culprit instead of leaving `matched=0` to be read as a
      // routing fault or as a defect in the file the caller named.
      const transformMarker = transformFailureMarker({
        locations: parseTransformFailure(listedOutput),
        routes: group.routes,
        cwd: group.cwd,
        requested: verdict.requested,
        matched: verdict.matched,
      });
      if (transformMarker) {
        console.error(transformMarker);
        attributionMarkers.push(transformMarker);
      } else if (group.routes.length > 1 && group.routes.length <= MULTI_FILE_ATTRIBUTION_CAP) {
        // EI-19467022057492490: no esbuild culprit found, but a multi-file group's whole `vitest
        // list` still failed — re-list each requested file ALONE so a lone runtime collection
        // crash (e.g. a vi.mock factory throw) doesn't misattribute every OTHER healthy file in
        // the batch as broken. Deliberately only for multi-file groups: a single-file group's
        // error already IS about the one file the caller named — no ambiguity to resolve.
        const perFile = group.routes.map((route) => {
          const singleListed = run('npx', ['vitest', 'list', ...configArgs, route.requested], {
            cwd: group.cwd,
            env: process.env,
          });
          const singleOutput = `${singleListed.stdout ?? ''}\n${singleListed.stderr ?? ''}`;
          const singleMatched = listedFiles(singleOutput, group.cwd);
          return { requested: route.requested, ok: singleListed.status === 0 && singleMatched.includes(route.absolute) };
        });
        const attributionMarker = collectionAttributionMarker({
          perFile,
          cwd: group.cwd,
          groupRequested: verdict.requested,
          groupMatched: verdict.matched,
        });
        if (attributionMarker) {
          console.error(attributionMarker);
          attributionMarkers.push(attributionMarker);
        }
      }
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: verdict.unmatched.length,
        failed: false,
        launchError: false,
      });
      continue;
    }
    for (const file of matched) console.log(`  matched ${relative(group.cwd, file)}`);
    if (dry) {
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: 0,
        failed: false,
        launchError: false,
      });
      continue;
    }

    const exact = matched.map((file) => relative(group.cwd, file));
    // Captured (not `stdio:'inherit'`) so the EI-18099113673609528 silent-collection-failure
    // signature can be detected below; forwarded verbatim so nothing is lost for a live TTY.
    // 256MB matches scripts/affected-tests.mjs's captured-output maxBuffer — spawnSync's 1MB
    // default would read a large suite's output as an ENOBUFS-killed-child failure.
    warnIfInstallInFlight(`\`vitest run\` (group cwd=${cwdLabel})`);
    const result = spawnSync(
      'npx',
      ['vitest', 'run', ...configArgs, ...exact, ...groupVitestArgs],
      { cwd: group.cwd, env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      console.error(`TEST_FILE_ROUTE_ERROR (group cwd=${cwdLabel}) could not launch Vitest: ${result.error.message}`);
      if (looksLikeMidInstallCorruption(result.error.message)) {
        console.error(MID_INSTALL_HINT);
      }
      groupResults.push({
        requested: verdict.requested,
        matched: verdict.matched,
        executed: 0,
        unmatchedCount: 0,
        failed: false,
        launchError: true,
      });
      continue;
    }
    const groupFailed = result.status !== 0;
    if (groupFailed) {
      console.error(`TEST_FILE_GROUP_RESULT cwd=${cwdLabel} executed=${exact.length} status=failed`);
      if (looksLikeMidInstallCorruption(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
        console.error(MID_INSTALL_HINT);
      }
      // EI-18099113673609528: >=2 files + zero per-suite detail is Vitest 4's silent
      // simultaneous-collection-failure reporter gap — re-run each file alone (where the same
      // failure DOES print in full) so the caller isn't left with an undiagnosable "N failed / no
      // tests" and nothing else.
      if (exact.length > 1 && looksLikeSilentCollectionFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
        console.error(
          `TEST_FILE_DETAIL_RECOVERY cwd=${cwdLabel} Vitest printed zero per-suite error detail for ${exact.length} failed files (known Vitest 4 reporter gap when >=2 files fail collection at once) — re-running each file individually to surface the actual error:`,
        );
        for (const file of exact) {
          console.error(`\n>>> re-running ${file} alone for detail`);
          spawnSync('npx', ['vitest', 'run', ...configArgs, file, ...withoutOutputFileArg(vitestArgs)], {
            cwd: group.cwd,
            env: process.env,
            stdio: 'inherit',
          });
        }
      }
    }
    groupResults.push({
      requested: verdict.requested,
      matched: verdict.matched,
      executed: exact.length,
      // EI-19425177453558152: `executed` counts FILES. Under a name filter that is not enough to
      // know anything ran, so measure TESTS too — `undefined` when no filter is in play keeps the
      // three states (n/a · unreadable · measured) distinct in aggregateGroupResults.
      //
      // EI-19451028801041450: prefer the JSON report's exact counts, and fall back to the stdout
      // summary row only when there is no report. Reading stdout FIRST would be inert for every
      // caller that passes `--reporter=json` (which `testing:run` always does) — under a machine
      // reporter no `Tests` row is printed at all, so the guard would fail open every time.
      // `??` and not `||`: a measured 0 is the whole point of this check and must NOT be
      // retried as if it were unreadable.
      testsExecuted: nameFilter
        ? testsExecutedFromReport(outputFilePathFrom(groupVitestArgs), group.cwd) ??
          testsExecutedFrom(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
        : undefined,
      unmatchedCount: 0,
      failed: groupFailed,
      launchError: false,
    });
  }

  const summary = aggregateGroupResults(groupResults);
  if (summary.launchError) return 2;
  if (summary.anyUnmatched) {
    console.error(
      `TEST_FILE_ROUTE_ERROR requested=${summary.requested} matched=${summary.matched}; refusing a false-green zero/partial-match run`,
    );
    // EI-19462803905923939 / EI-19467022057492490: this aggregate line is the LAST thing a
    // `| tail -N` reads — the very idiom CLAUDE.md prescribes throughout — so the attribution has
    // to be restated HERE. Printing it only at the group level (where it also belongs, next to the
    // evidence) still leaves the misleading routing claim as the terminal line, which is the
    // entire defect.
    for (const marker of attributionMarkers) console.error(marker);
    return 1;
  }

  // EI-19376339983058011 — THE MARKER'S PRESENCE MUST IMPLY THAT TESTS RAN.
  // A dry run executes nothing, yet used to print the same `TEST_FILE_RESULT` line callers read
  // as a verdict. The reported measurement harness guarded exactly this way —
  // `if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi` — so a dry run satisfied the guard
  // with executed=0 and exit 0, and its zero parsed FAIL lines were recorded as "this candidate
  // passes". Four corpus rows were written that way, each in ~37s, far too fast to have run a
  // suite. Emitting a DISTINCT marker makes the presence test the caller already writes correct
  // by construction, instead of requiring every caller to also parse `status=`.
  if (dry) {
    console.log(
      `TEST_FILE_DRYRUN requested=${summary.requested} executed=0 matched=${summary.matched} status=dry-run ` +
        `${provenanceResultFields(provenanceBefore, null)}`,
    );
    return 0;
  }

  // EI-18681435059177620: re-measure AFTER the run. This is the half that would have caught the
  // reported incident automatically — a tested file edited while the suite was executing leaves a
  // verdict that describes neither state, and until now nothing said so.
  const provenanceAfter = snapshotProvenance(routes.map((route) => route.absolute));
  const provenanceDiff = diffProvenanceSnapshots(provenanceBefore, provenanceAfter);
  const driftMarker = formatProvenanceDrift(provenanceDiff);
  if (driftMarker) console.error(driftMarker);
  console.log(formatProvenanceBanner(provenanceAfter, 'post-run'));

  // The invariant the line below now carries. Unreachable today — a zero/partial match is refused
  // per-group above, and `executed` is derived from that matched set — which is precisely why it
  // is ASSERTED rather than assumed: if a future edit ever makes executed=0 reachable here, this
  // refuses loudly instead of printing a verdict for a run that tested nothing.
  if (summary.executed < 1) {
    console.error(
      `TEST_FILE_ROUTE_ERROR requested=${summary.requested} matched=${summary.matched} executed=0; ` +
        `refusing to report a verdict for a run that executed no tests`,
    );
    return 1;
  }

  // EI-19425177453558152 — a name filter that matched ZERO tests measured NOTHING.
  //
  // This deliberately does NOT print `TEST_FILE_RESULT ... status=failed`, which is what the
  // filing suggested: EI-19376339983058011 (directly above) established that the marker's
  // PRESENCE is the verdict callers grep for (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED`).
  // Zero tests ran, so the honest report is UNMEASURED — the marker must be absent, and the
  // failure carried by the exit code plus its own distinct marker.
  if (nameFilter) {
    const receivedAs = [nameFilter.flag, nameFilter.pattern, ...nameFilter.strays].join(' ');
    const strayNote =
      nameFilter.strays.length > 0
        ? ` — vitest received \`${receivedAs}\`, i.e. the pattern "${nameFilter.pattern}" PLUS ` +
          `${nameFilter.strays.length} stray positional(s) [${nameFilter.strays.join(', ')}] it reads as extra FILE ` +
          'filters. That is the signature of a quoted pattern being eaten by the shell/npm arg chain: quote it ' +
          'for the inner command (npm eats one level) or use a space-free pattern.'
        : '';
    if (summary.testsExecuted === 0 && summary.testsUnmeasuredGroups === 0) {
      console.error(
        `TEST_FILE_NAME_FILTER_NO_MATCH requested=${summary.requested} matched=${summary.matched} ` +
          `executedFiles=${summary.executed} testsExecuted=0 status=failed reason=name-filter-matched-no-tests ` +
          `pattern=${JSON.stringify(nameFilter.pattern)}; refusing to report a verdict for a run that ` +
          `executed no tests${strayNote}`,
      );
      return 1;
    }
    if (summary.testsExecuted === null || summary.testsUnmeasuredGroups > 0) {
      // Fail OPEN — never fabricate a red from an unreadable count (a JSON reporter writes no
      // summary row). Say so out loud so the hole cannot silently reopen.
      console.error(
        `TEST_FILE_NAME_FILTER_UNVERIFIED pattern=${JSON.stringify(nameFilter.pattern)}; could not read vitest's ` +
          "`Tests` summary row, so whether the name filter executed any tests is UNVERIFIED — the status below " +
          `does not rule out a zero-match run${strayNote}`,
      );
    }
  }

  const status = summary.anyFailed ? 'failed' : 'passed';
  // The provenance fields describe the state this result MEASURED (the pre-run snapshot), not
  // whatever is on disk now; `provenance=drifted` is what says those two differ. Appended AFTER
  // `status=` so every existing consumer keeps parsing unchanged — the doc-claims anchor registry
  // pins `TEST_FILE_RESULT requested=` as the first field, and every reader tokenises `status=`.
  console.log(
    `TEST_FILE_RESULT requested=${summary.requested} executed=${summary.executed} matched=${summary.matched} ` +
      `status=${status} ${provenanceResultFields(provenanceBefore, provenanceDiff)}`,
  );
  return summary.anyFailed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
