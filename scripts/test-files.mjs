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
 * Usage: npm run test:file -- path/to/a.test.ts [path/to/b.test.ts] [-- <vitest args>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg, availableParallelism } from 'node:os';
import { applyWorkerCapEnv } from './lib/worker-cap.mjs';
import { stripVitestAnsi } from './lib/vitest-summary.mjs';
import { peekFsMutexSync } from './lib/fs-mutex.mjs';
import { repoLockName } from './npm-install-safe.mjs';

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
  const absolute = resolve(root, file);
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

export function aggregateGroupResults(groupResults) {
  const requested = groupResults.reduce((sum, g) => sum + g.requested, 0);
  const matched = groupResults.reduce((sum, g) => sum + g.matched, 0);
  const executed = groupResults.reduce((sum, g) => sum + g.executed, 0);
  const launchError = groupResults.some((g) => g.launchError);
  const anyUnmatched = groupResults.some((g) => g.unmatchedCount > 0);
  const anyFailed = groupResults.some((g) => g.failed);
  // Only a clean, fully-matched, fully-launchable run is `ok` — a launch error or ANY group's
  // partial/zero match still refuses the false-green, exactly as the single-group path always did.
  const ok = !launchError && !anyUnmatched;
  return { ok, requested, matched, executed, anyUnmatched, anyFailed, launchError };
}

function parseCli(argv) {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const vitestArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const dry = own.includes('--dry');
  const files = own.filter((arg) => arg !== '--dry');
  return { dry, files, vitestArgs };
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
  console.log(`TEST_FILE_ROUTE requested=${routes.length} groups=${groups.length}`);
  // EI-13535: every group runs UNCONDITIONALLY — a mismatch or failure in one workspace's group
  // must never abandon the OTHER groups a multi-workspace request spans (see aggregateGroupResults
  // doc for the full incident). Each iteration always records its outcome and moves on; the final
  // verdict is decided only after every group has had its chance to run.
  const groupResults = [];
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
      `TEST_FILE_DRYRUN requested=${summary.requested} executed=0 matched=${summary.matched} status=dry-run`,
    );
    return 0;
  }

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

  const status = summary.anyFailed ? 'failed' : 'passed';
  console.log(
    `TEST_FILE_RESULT requested=${summary.requested} executed=${summary.executed} matched=${summary.matched} status=${status}`,
  );
  return summary.anyFailed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
