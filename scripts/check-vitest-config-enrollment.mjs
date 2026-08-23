#!/usr/bin/env node
/**
 * Ensure every declared workspace Vitest config records the admin test-run ledger.
 *
 * `defineVitestConfig` is the shared source of the admin-test-runs reporter. A
 * plain `defineConfig` silently bypasses that reporter, so `testing:runs` cannot
 * distinguish an unmeasured workspace from a measured clean one. The allowlist is
 * deliberately exact: these packages use a different runner/config contract and
 * are the only accepted plain configurations.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_CONFIG_NAME = /^vitest\.config\.[^/]+$/;
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.papercusp',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

/**
 * These configs intentionally do not use the shared Vitest base. Keep this set
 * path-specific so adding a new plain config cannot silently become an exemption.
 */
export const PLAIN_CONFIG_EXEMPTIONS = new Set([
  'libs/generic/card-stack/vitest.config.ts',
  'libs/generic/dock-workbench/vitest.config.ts',
  'libs/generic/ipc-endpoint-server/vitest.config.ts',
  'libs/generic/papergrid/bloom-grid/vitest.config.ts',
  'libs/generic/papergrid/kv-persist-indexeddb/vitest.config.ts',
  'libs/generic/papergrid/kv-persist/vitest.config.ts',
  'libs/generic/search/vitest.config.ts',
  'libs/agent-chat/vitest.config.ts',
  'libs/generic/git-graph/vitest.config.ts',
  'libs/generic/ui-primitives/vitest.config.ts',
  'libs/papercusp/packages/cli/vitest.config.ts',
]);

function normalizePath(filePath) {
  return filePath.split(sep).join('/');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Return true when a config wires the shared reporter, either through the base
 * helper or by explicitly importing the reporter path (the established app
 * config pattern).
 */
export function isReporterEnrolled(source) {
  const code = stripComments(source);
  const hasBaseImport = /import\s*\{[\s\S]*?\bdefineVitestConfig\b[\s\S]*?\}\s*from\s*['"][^'"]+['"]/.test(code) &&
    /\bdefineVitestConfig\s*\(/.test(code);
  const hasExplicitReporter = /\bADMIN_TEST_RUNS_REPORTER_PATH\b/.test(code);
  return hasBaseImport || hasExplicitReporter;
}

/**
 * Find unenrolled configs from an explicit, already-read file list. This pure
 * seam keeps the recurrence rule hermetic and makes the exact exemption logic
 * independently testable.
 */
export function findUnenrolledConfigs(configs) {
  return configs
    .filter(({ path, content }) => !PLAIN_CONFIG_EXEMPTIONS.has(normalizePath(path)) && !isReporterEnrolled(content))
    .map(({ path }) => normalizePath(path))
    .sort();
}

function workspacePatterns(rootPackage) {
  const workspaces = rootPackage.workspaces;
  return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];
}

function declaredWorkspaceDirs(root = ROOT) {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = new Set();
  for (const pattern of workspacePatterns(rootPackage)) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const absoluteBase = join(root, base);
      if (!existsSync(absoluteBase)) continue;
      for (const entry of readdirSync(absoluteBase, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(absoluteBase, entry.name, 'package.json'))) {
          dirs.add(join(base, entry.name));
        }
      }
      continue;
    }
    if (existsSync(join(root, pattern, 'package.json'))) dirs.add(pattern);
  }
  return [...dirs].sort();
}

function collectWorkspaceConfigs(workspaceDir, root, out) {
  const absoluteDir = join(root, workspaceDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        collectWorkspaceConfigs(join(workspaceDir, entry.name), root, out);
      }
      continue;
    }
    if (!entry.isFile() || !VITEST_CONFIG_NAME.test(entry.name)) continue;
    const absolutePath = join(absoluteDir, entry.name);
    out.push({
      path: normalizePath(relative(root, absolutePath)),
      content: readFileSync(absolutePath, 'utf8'),
    });
  }
}

export function collectVitestConfigs(root = ROOT) {
  const configs = [];
  for (const workspaceDir of declaredWorkspaceDirs(root)) {
    collectWorkspaceConfigs(workspaceDir, root, configs);
  }
  return configs.sort((a, b) => a.path.localeCompare(b.path));
}

export function main(root = ROOT) {
  const findings = findUnenrolledConfigs(collectVitestConfigs(root));
  if (findings.length > 0) {
    console.error(
      [
        'Vitest configs without the admin test-runs reporter:',
        ...findings.map((filePath) => `  ${filePath}`),
        '',
        'Use @papercusp/test-config/vitest-config or add an explicit reporter wiring.',
      ].join('\n'),
    );
    return 1;
  }
  console.log('Vitest config enrollment: all declared workspace configs are reporter-wired or explicitly exempt.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
