/**
 * Prove that a registry-visible JavaScript/TypeScript test is owned by a real
 * executor without collecting or running the suite.
 *
 * `scripts/test-files.mjs` remains the one route-discovery authority. A route
 * alone is not enough, though: a nearby Vitest config can own a path while its
 * resolved include/exclude contract still filters that path out. This module
 * resolves each distinct config once and checks the exact file against that
 * contract. Playwright and WebdriverIO live outside the Vitest router, so their
 * two supported repository paths are checked explicitly against their config
 * and package-script entrypoints.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
// eslint-disable-next-line import/no-relative-packages
// @ts-expect-error — plain-Node .mjs router has no declaration file by design.
import { discoverTestRoute } from '../../../scripts/test-files.mjs';

export type TestExecutorKind = 'vitest' | 'node' | 'playwright' | 'webdriverio';

export interface TestRunnabilityResult {
  file: string;
  runnable: boolean;
  executor?: TestExecutorKind;
  reason?: string;
}

interface TestRoute {
  runner?: string;
  cwd: string;
  config: string | null;
  absolute: string;
  requested: string;
}

interface ResolvedVitestContract {
  root: string;
  dir?: string;
  include: string[];
  exclude: string[];
}

export interface TestRunnabilityDependencies {
  discoverRoute(file: string, root: string): TestRoute;
  resolveVitest(options: { root: string; config: string | false }): Promise<ResolvedVitestContract>;
  exists(path: string): boolean;
  readPackageScript(packageJsonPath: string, script: string): string | undefined;
}

interface ResolverResult {
  ok: boolean;
  config?: ResolvedVitestContract;
  error?: string;
}

const RESOLVER_MARKER = 'PC_VITEST_CONFIG_CONTRACTS=';

/**
 * `lint:tests` runs under tsx. Importing vitest/node into that process makes
 * tsx's CJS compatibility hook resolve Vitest's ESM-only nested
 * `estree-walker` through `require`, which fails before the lint starts. The
 * native-Node bridge keeps Vitest's own resolver authoritative and batches
 * every distinct config into one process rather than paying one process per
 * workspace.
 */
function resolveVitestBatch(
  repoRoot: string,
  requests: Array<{ root: string; config: string | false }>,
): ResolvedVitestContract[] {
  const resolver = resolve(repoRoot, 'scripts/resolve-vitest-config-contracts.mjs');
  const child = spawnSync(process.execPath, [resolver], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify({ requests }),
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1',
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `Vitest config resolver exited ${child.status}: ${(child.stderr || child.stdout).trim()}`,
    );
  }
  const markerLine = child.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(RESOLVER_MARKER));
  if (!markerLine) {
    throw new Error('Vitest config resolver returned no machine-readable contract marker');
  }
  const parsed = JSON.parse(markerLine.slice(RESOLVER_MARKER.length)) as {
    results?: ResolverResult[];
  };
  if (!Array.isArray(parsed.results) || parsed.results.length !== requests.length) {
    throw new Error('Vitest config resolver returned a result-count mismatch');
  }
  return parsed.results.map((result, index) => {
    if (!result.ok || !result.config) {
      throw new Error(
        `could not resolve Vitest config ${requests[index]?.root}/${requests[index]?.config || '<defaults>'}: ${result.error ?? 'unknown error'}`,
      );
    }
    return result.config;
  });
}

function createBatchedVitestResolver(
  repoRoot: string,
): TestRunnabilityDependencies['resolveVitest'] {
  type Pending = {
    options: { root: string; config: string | false };
    resolve: (config: ResolvedVitestContract) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending[] = [];
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    try {
      const configs = resolveVitestBatch(repoRoot, batch.map((entry) => entry.options));
      batch.forEach((entry, index) => entry.resolve(configs[index]!));
    } catch (error) {
      batch.forEach((entry) => entry.reject(error));
    }
  };

  return (options) => new Promise((resolveConfigPromise, reject) => {
    pending.push({ options, resolve: resolveConfigPromise, reject });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}

function defaultDependencies(repoRoot: string): TestRunnabilityDependencies {
  return {
    discoverRoute: (file, root) => discoverTestRoute(file, root) as TestRoute,
    resolveVitest: createBatchedVitestResolver(repoRoot),
    exists: existsSync,
    readPackageScript: (packageJsonPath, script) => {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const value = parsed.scripts?.[script];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function relativeInside(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return toPosix(rel);
}

function matchesResolvedGlob(pattern: string, relativePath: string, absolutePath: string): boolean {
  const candidate = isAbsolute(pattern) ? toPosix(absolutePath) : relativePath;
  return minimatch(candidate, toPosix(pattern), { dot: true });
}

export function matchesResolvedVitestContract(
  absoluteFile: string,
  config: ResolvedVitestContract,
): boolean {
  const base = resolve(config.dir ?? config.root);
  const relativeFile = relativeInside(base, absoluteFile);
  if (relativeFile === null) return false;
  const included = config.include.some((pattern) =>
    matchesResolvedGlob(pattern, relativeFile, absoluteFile),
  );
  if (!included) return false;
  return !config.exclude.some((pattern) =>
    matchesResolvedGlob(pattern, relativeFile, absoluteFile),
  );
}

function explicitExecutor(
  repoRoot: string,
  relativeFile: string,
  deps: TestRunnabilityDependencies,
): TestRunnabilityResult | null {
  if (/^apps\/operator\/e2e\/.*\.spec\.ts$/.test(relativeFile)) {
    const config = resolve(repoRoot, 'apps/operator/playwright.config.ts');
    const packageJson = resolve(repoRoot, 'apps/operator/package.json');
    const script = deps.readPackageScript(packageJson, 'test:e2e');
    if (deps.exists(config) && script !== undefined && /\bplaywright\s+test\b/.test(script)) {
      return { file: relativeFile, runnable: true, executor: 'playwright' };
    }
    return {
      file: relativeFile,
      runnable: false,
      reason: 'Playwright path has no apps/operator/playwright.config.ts + test:e2e executor',
    };
  }

  if (/^tools\/perf-test\/wdio\/specs\/.*\.spec\.ts$/.test(relativeFile)) {
    const config = resolve(repoRoot, 'tools/perf-test/wdio/wdio.conf.ts');
    const packageJson = resolve(repoRoot, 'tools/perf-test/wdio/package.json');
    const script = deps.readPackageScript(packageJson, 'test');
    if (deps.exists(config) && script !== undefined && /\bwdio\s+run\s+wdio\.conf\.ts\b/.test(script)) {
      return { file: relativeFile, runnable: true, executor: 'webdriverio' };
    }
    return {
      file: relativeFile,
      runnable: false,
      reason: 'WebdriverIO path has no wdio.conf.ts + package test executor',
    };
  }

  return null;
}

/**
 * Build one audit instance. Its resolved-config cache is intentionally scoped
 * to one lint run: config modules may read environment variables, so carrying
 * resolved state across invocations would make a later run stale.
 */
export function createTestRunnabilityAuditor(
  repoRoot: string,
  overrides: Partial<TestRunnabilityDependencies> = {},
): (file: string) => Promise<TestRunnabilityResult> {
  const root = resolve(repoRoot);
  const deps = { ...defaultDependencies(root), ...overrides };
  const configCache = new Map<string, Promise<ResolvedVitestContract>>();

  return async (file: string): Promise<TestRunnabilityResult> => {
    const absoluteFile = resolve(root, file);
    const relativeFile = relativeInside(root, absoluteFile);
    if (relativeFile === null) {
      return { file, runnable: false, reason: 'test path is outside the repository' };
    }

    try {
      const explicit = explicitExecutor(root, relativeFile, deps);
      if (explicit) return explicit;

      const route = deps.discoverRoute(relativeFile, root);
      if (route.runner === 'node') {
        return { file: relativeFile, runnable: true, executor: 'node' };
      }
      if (route.runner !== undefined && route.runner !== 'vitest') {
        return {
          file: relativeFile,
          runnable: false,
          reason: `unsupported discovered runner: ${route.runner}`,
        };
      }

      const configKey = `${resolve(route.cwd)}\0${route.config ?? ''}`;
      let pendingConfig = configCache.get(configKey);
      if (!pendingConfig) {
        pendingConfig = deps.resolveVitest({
          root: resolve(route.cwd),
          // A config-less package deliberately runs Vitest's defaults from
          // its own cwd. `false` prevents an unrelated ancestor config from
          // being mistaken for that contract.
          config: route.config ?? false,
        });
        configCache.set(configKey, pendingConfig);
      }
      const config = await pendingConfig;
      if (!matchesResolvedVitestContract(route.absolute, config)) {
        return {
          file: relativeFile,
          runnable: false,
          reason: `owning Vitest config excludes the path (${toPosix(relative(root, route.cwd))}/${route.config ?? '<defaults>'})`,
        };
      }
      return { file: relativeFile, runnable: true, executor: 'vitest' };
    } catch (error) {
      return {
        file: relativeFile,
        runnable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export async function findUnrunnableTests(
  files: readonly string[],
  repoRoot: string,
  overrides: Partial<TestRunnabilityDependencies> = {},
): Promise<TestRunnabilityResult[]> {
  const audit = createTestRunnabilityAuditor(repoRoot, overrides);
  const results = await Promise.all(files.map((file) => audit(file)));
  return results.filter((result) => !result.runnable).sort((a, b) => a.file.localeCompare(b.file));
}
