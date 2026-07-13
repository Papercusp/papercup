#!/usr/bin/env node
/**
 * check-transitive-boundary.mjs — transitive client/server boundary preflight.
 *
 * Walks the import graph from apps/operator-vite (the browser SPA entry) and
 * identifies every forbidden server-only import, aggregating the full import
 * chain for each violation in a single run. Catches boundary leaks before
 * Vite's runtime externalization warnings.
 *
 * Source list of forbidden imports from:
 *   - apps/operator-vite/vite.config.ts (resolve.alias shims)
 *   - Node.js built-ins (node:*)
 *   - Known server-only packages (database, P2P, test infra, eval)
 *
 *   npm run lint:boundary-check             # Check operator-vite boundary
 *   npm run lint:boundary-check --verbose   # Print import chains
 *   npm run lint:boundary-check --update    # Update baseline (future feature)
 *
 * Exit codes:
 *   0 — OK (no forbidden imports in the client graph)
 *   1 — Forbidden imports found (prints full import chains)
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'apps/operator-vite');
const OPERATOR_DIR = resolve(ROOT, 'apps/operator');
const PACKAGES_DIR = resolve(ROOT, 'packages');

/** Modules forbidden in the client graph (defined by vite.config.ts shims and safety rules) */
const FORBIDDEN_PATTERNS = [
  // Node.js built-ins — NEVER in browser
  /^node:/,
  // Database clients and ORM — server-only
  /^postgres($|\/)/,
  /^pg($|\/)/,
  /^drizzle-orm($|\/)/,
  /^@electric-sql\/pglite($|\/)/,
  // Server-only coordination/event-log backends
  /^@papercusp\/coordination\/event-log($|\/)/,
  // Code execution and compile-time tools
  /^typescript($|\/)/,
  /^@typescript-eslint($|\/)/,
  // Feature flags (PostHog server backend)
  /^posthog-node($|\/)/,
  // Server runtime (DBOS)
  /^@dbos-inc\/dbos-sdk($|\/)/,
  // P2P networking (server-only substrate)
  /^(corestore|hyperswarm|hyperdht|hyperbee|hypercore|hypercore-crypto|sodium-universal|sodium-native|sodium-secretstream|udx-native|dht-rpc|blind-relay)($|\/)/,
  // Test infrastructure (server-only)
  /^(ssh2|cpu-features)($|\/)/,
  // Build tools (dev-only)
  /^(tsx|vite|rollup|esbuild|webpack|vitest|jest)($|\/)/,
];

/**
 * Extract the package name from an import specifier.
 * @param {string} spec - Specifier like "postgres/lib/connection.js"
 * @returns {string} Package name like "postgres"
 */
function getPackageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

/**
 * Check if a package name is forbidden in the client.
 * @param {string} specifier - Specifier or package name
 * @returns {boolean}
 */
function isForbidden(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  const pkg = getPackageName(specifier);
  return FORBIDDEN_PATTERNS.some((p) => p.test(pkg));
}

/**
 * Attempt to load a source file. Returns null if not found/unreadable.
 * @param {string} path - File path
 * @returns {ts.SourceFile | null}
 */
function loadSourceFile(path) {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats || !stats.isFile()) return null;
    const text = readFileSync(path, 'utf-8');
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  } catch {
    return null;
  }
}

/**
 * Try to resolve a module. Handles:
 *   - Relative paths (./foo, ../foo)
 *   - Path aliases (@/, ~/)
 *   - Bare exports (node_modules packages)
 * @param {string} spec - Specifier to resolve
 * @param {string} fromFile - Resolving file's absolute path
 * @returns {string | null} Resolved path, or null if not found
 */
function resolveModulePath(spec, fromFile) {
  if (spec.startsWith('@/')) {
    // @/ alias → apps/operator
    const path = resolve(OPERATOR_DIR, spec.slice(2));
    return findFile(path);
  }

  if (spec.startsWith('~/')) {
    // ~/ alias → root
    const path = resolve(ROOT, spec.slice(2));
    return findFile(path);
  }

  if (spec.startsWith('.')) {
    // Relative import
    const fromDir = dirname(fromFile);
    const path = resolve(fromDir, spec);
    return findFile(path);
  }

  // Bare package import (handled by caller, not resolved here)
  return null;
}

/**
 * Find a file by trying extensions: .ts, .tsx, .js, /index.ts, /index.tsx, /index.js
 * @param {string} base - Base path without extension
 * @returns {string | null} Resolved path or null
 */
function findFile(base) {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs']) {
    const withExt = base + ext;
    if (statSync(withExt, { throwIfNoEntry: false })?.isFile()) {
      return withExt;
    }
  }
  const indexBase = base + '/index';
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']) {
    const withExt = indexBase + ext;
    if (statSync(withExt, { throwIfNoEntry: false })?.isFile()) {
      return withExt;
    }
  }
  return null;
}

/**
 * Extract import/export specifiers from TypeScript AST.
 * @param {ts.SourceFile} source - Source file
 * @returns {string[]} Array of module specifiers
 */
function extractImports(source) {
  const specs = [];

  function visit(node) {
    // import ... from '...'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    }
    // export ... from '...'
    if (ts.isExportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    }
    // require('...')
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    // dynamic import('...')
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return specs;
}

/**
 * Main entrypoint
 */
function main() {
  const verbose = process.argv.includes('--verbose');

  // Find the main entry file
  const packageJson = JSON.parse(
    readFileSync(resolve(APP_DIR, 'package.json'), 'utf8')
  );
  const mainEntry = packageJson.module || packageJson.main || 'src/index.tsx';
  const entryFile = resolve(APP_DIR, mainEntry);

  if (!statSync(entryFile, { throwIfNoEntry: false })?.isFile()) {
    console.error(`❌ Entry file not found: ${entryFile}`);
    process.exit(1);
  }

  // Walk the import graph
  const importMap = new Map();
  const importedFrom = new Map();
  const visited = new Set();
  const host = createCompilerHost();

  console.log(`Scanning import graph from ${relative(ROOT, entryFile)}...`);
  walkImports(entryFile, importMap, visited, host, importedFrom);

  // Collect violations
  const violations = new Map(); // module -> chains
  const allModules = new Set(importedFrom.keys());

  for (const module of allModules) {
    if (isForbidden(module)) {
      const chains = traceImportChains(module, importedFrom, importMap, entryFile);
      violations.set(module, chains);
    }
  }

  // Report findings
  if (violations.size === 0) {
    console.log(`✓ No forbidden imports detected. Scanned ${visited.size} files, ${allModules.size} unique imports.`);
    process.exit(0);
  }

  console.error(`\n❌ Found ${violations.size} forbidden import(s) in the client graph:\n`);

  const sortedViolations = Array.from(violations.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [module, chains] of sortedViolations) {
    console.error(`  ⚠ ${module}`);
    if (verbose && chains.length > 0) {
      // Show the first chain as an example
      const chain = chains[0];
      for (let i = 0; i < chain.length; i++) {
        const item = chain[i];
        const isFile = item.startsWith('/');
        const label = isFile ? relative(ROOT, item) : item;
        const indent = '    ' + '→ '.repeat(i);
        console.error(`${indent}${label}`);
      }
      if (chains.length > 1) {
        console.error(`    ... and ${chains.length - 1} more import path(s)`);
      }
    }
  }

  console.error(`\nRemedy:`);
  console.error(`  - Load forbidden modules lazily: \`const x = await import('...')\``);
  console.error(`  - Use \`import type\` for type-only imports`);
  console.error(`  - Add a browser shim in apps/operator-vite/vite.config.ts`);
  console.error(`  - See /internal/docs/agent-insights/fcp-server-libs-leak-into-eager-client-bundle\n`);

  process.exit(1);
}

main();
