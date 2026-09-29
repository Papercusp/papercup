#!/usr/bin/env node
/**
 * Ensure every declared workspace Vitest config takes part in the green-checkpoint gate.
 *
 * Gate participation means the admin test-runs reporter (the /admin/testing ledger), the
 * per-file pass-proof recorder + executed-inputs capture when the runner arms them, and the
 * per-file pass-reuse skip list. `defineVitestConfig` wires all of it, and a hand-rolled
 * `defineConfig` gets it by spreading `gateParticipationConfig()`; both read one shared
 * fragment in libs/test-config/src/vitest-config.ts.
 *
 * WI-10003716: this guard used to accept a bare `ADMIN_TEST_RUNS_REPORTER_PATH` mention. Twelve
 * configs passed that way while recording zero pass proofs and never reusing one, because the
 * reporter alone is not participation. It now accepts only the two helpers. The allowlist is
 * deliberately exact: these packages use a different runner/config contract and are the only
 * accepted plain configurations.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

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

/** True when `code` both imports `name` in a named import and calls it. */
function importsAndCalls(code, name) {
  const imported = new RegExp(String.raw`import\s*\{[\s\S]*?\b${name}\b[\s\S]*?\}\s*from\s*['"][^'"]*['"]`).test(code);
  return imported && new RegExp(String.raw`\b${name}\s*\(`).test(code);
}

/**
 * Return true when a config takes part in the gate: it calls the shared base
 * (`defineVitestConfig`) or spreads the gate fragment (`gateParticipationConfig`).
 * Wiring the admin reporter path by hand is NOT enough (WI-10003716).
 */
export function isGateEnrolled(source, fileName) {
  const code = stripCommentsAndStrings(source, fileName);
  return importsAndCalls(code, 'defineVitestConfig') || importsAndCalls(code, 'gateParticipationConfig');
}

/**
 * Find unenrolled configs from an explicit, already-read file list. This pure
 * seam keeps the recurrence rule hermetic and makes the exact exemption logic
 * independently testable.
 */
export function findUnenrolledConfigs(configs) {
  return configs
    .filter(({ path, content }) => !PLAIN_CONFIG_EXEMPTIONS.has(normalizePath(path)) && !isGateEnrolled(content, path))
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
        'Vitest configs that do not take part in the green-checkpoint gate:',
        ...findings.map((filePath) => `  ${filePath}`),
        '',
        'Use defineVitestConfig from @papercusp/test-config/vitest-config, or spread',
        'gateParticipationConfig() into a hand-rolled config\'s `test` block. Wiring',
        'ADMIN_TEST_RUNS_REPORTER_PATH by hand records no pass proofs and reuses none.',
      ].join('\n'),
    );
    return 1;
  }
  console.log('Vitest config enrollment: all declared workspace configs take part in the gate or are explicitly exempt.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
