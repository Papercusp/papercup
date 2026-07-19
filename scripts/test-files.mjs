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

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  for (const group of groups) {
    const cwdLabel = relative(REPO_ROOT, group.cwd) || '.';
    const requested = group.routes.map((route) => route.requested);
    // A null config is a config-less Vitest package (libs/generic/* shape): omit `--config`
    // entirely so Vitest auto-discovers its defaults from the package cwd, exactly as its own
    // documented `npm test` (`vitest run`) does.
    const configArgs = group.config ? ['--config', group.config] : [];
    console.log(`ROUTE cwd=${cwdLabel} config=${group.config ?? '(package default)'}`);
    for (const file of requested) console.log(`  requested ${file}`);

    const listed = run('npx', ['vitest', 'list', ...configArgs, ...requested], {
      cwd: group.cwd,
      env: process.env,
    });
    if (listed.error) {
      console.error(`TEST_FILE_ROUTE_ERROR (group cwd=${cwdLabel}) could not launch Vitest: ${listed.error.message}`);
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
    const result = spawnSync(
      'npx',
      ['vitest', 'run', ...configArgs, ...exact, ...vitestArgs],
      { cwd: group.cwd, env: process.env, stdio: 'inherit' },
    );
    if (result.error) {
      console.error(`TEST_FILE_ROUTE_ERROR (group cwd=${cwdLabel}) could not launch Vitest: ${result.error.message}`);
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

  const status = dry ? 'dry-run' : summary.anyFailed ? 'failed' : 'passed';
  console.log(
    `TEST_FILE_RESULT requested=${summary.requested} executed=${dry ? 0 : summary.executed} matched=${summary.matched} status=${status}`,
  );
  return dry ? 0 : summary.anyFailed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
