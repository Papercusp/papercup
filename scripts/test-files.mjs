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
import { existsSync, readdirSync } from 'node:fs';
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
  while (dir === root || dir.startsWith(`${root}${sep}`)) {
    const configs = configsIn(dir);
    const integration = configs.find((name) => INTEGRATION_CONFIG_RE.test(name));
    const unit = configs.find((name) => UNIT_CONFIG_RE.test(name));
    if (wantsIntegration && integration) return { cwd: dir, config: integration, absolute, requested: relative(dir, absolute) };
    if (!wantsIntegration && unit) return { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    if (unit && !unitFallback) unitFallback = { cwd: dir, config: unit, absolute, requested: relative(dir, absolute) };
    if (dir === root) break;
    dir = dirname(dir);
  }
  if (unitFallback) return unitFallback;
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
  let executedCount = 0;
  for (const group of groups) {
    const cwdLabel = relative(REPO_ROOT, group.cwd) || '.';
    const requested = group.routes.map((route) => route.requested);
    console.log(`ROUTE cwd=${cwdLabel} config=${group.config}`);
    for (const file of requested) console.log(`  requested ${file}`);

    const listed = run('npx', ['vitest', 'list', '--config', group.config, ...requested], {
      cwd: group.cwd,
      env: process.env,
    });
    if (listed.error) {
      console.error(`TEST_FILE_ROUTE_ERROR could not launch Vitest: ${listed.error.message}`);
      return 2;
    }
    const matched = listedFiles(`${listed.stdout ?? ''}\n${listed.stderr ?? ''}`, group.cwd);
    const unmatched = group.routes.filter((route) => !matched.includes(route.absolute));
    if (listed.status !== 0 || unmatched.length > 0 || matched.length === 0) {
      if (listed.stdout) process.stdout.write(listed.stdout);
      if (listed.stderr) process.stderr.write(listed.stderr);
      for (const route of unmatched) console.error(`  unmatched ${route.requested}`);
      console.error(
        `TEST_FILE_ROUTE_ERROR requested=${group.routes.length} matched=${matched.length}; refusing a false-green zero/partial-match run`,
      );
      return 1;
    }
    for (const file of matched) console.log(`  matched ${relative(group.cwd, file)}`);
    if (dry) continue;

    const exact = matched.map((file) => relative(group.cwd, file));
    const result = spawnSync(
      'npx',
      ['vitest', 'run', '--config', group.config, ...exact, ...vitestArgs],
      { cwd: group.cwd, env: process.env, stdio: 'inherit' },
    );
    if (result.error) {
      console.error(`TEST_FILE_ROUTE_ERROR could not launch Vitest: ${result.error.message}`);
      return 2;
    }
    executedCount += exact.length;
    if (result.status !== 0) {
      console.error(`TEST_FILE_RESULT requested=${routes.length} executed=${executedCount} status=failed`);
      return result.status ?? 1;
    }
  }

  console.log(`TEST_FILE_RESULT requested=${routes.length} executed=${dry ? 0 : executedCount} matched=${routes.length} status=${dry ? 'dry-run' : 'passed'}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
