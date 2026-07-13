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
    if (!node) return;

    // import ... from '...'
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    }
    // export ... from '...'
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    }
    // require('...') or import('...')
    else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (!expr) return;

      // require('...')
      if (
        ts.isIdentifier(expr) &&
        expr.text === 'require' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specs.push(node.arguments[0].text);
      }
      // import('...')
      else if (
        expr.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specs.push(node.arguments[0].text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return specs;
}

/**
 * Walk the import graph from an entry file, tracking violations.
 * @param {string} entryFile - Absolute path to entry
 * @returns {{ files: Set<string>, violations: Map<string, string[][]> }}
 */
function walkGraph(entryFile) {
  const visited = new Set(); // Visited file paths
  const violations = new Map(); // forbidden module -> array of import chains

  function visit(filePath, chain = []) {
    // Prevent cycles and stack overflow
    if (visited.has(filePath) || chain.length > 100) return;
    visited.add(filePath);

    const source = loadSourceFile(filePath);
    if (!source) return;

    const specs = extractImports(source);
    const currentChain = [...chain, filePath];

    for (const spec of specs) {
      // Check if this direct import is forbidden
      if (isForbidden(spec)) {
        if (!violations.has(spec)) {
          violations.set(spec, []);
        }
        // Record the chain that leads to this forbidden import
        violations.get(spec).push(currentChain);
      } else {
        // Not forbidden, recurse into it
        const resolved = resolveModulePath(spec, filePath);
        if (resolved) {
          visit(resolved, currentChain);
        }
      }
    }
  }

  visit(entryFile);
  return { files: visited, violations };
}

/**
 * Format an import chain for display (entry → ... → forbidden).
 * @param {string[]} chain - Chain of files ending at the file importing the forbidden module
 * @param {string} forbidden - The forbidden module name
 * @returns {string}
 */
function formatChain(chain, forbidden) {
  const formatted = chain.map((item) => {
    const rel = relative(ROOT, item);
    return rel.startsWith('..') ? item : rel;
  });
  return [
    '        ' + formatted.join('\n        ↓\n        '),
    '        → ' + forbidden,
  ].join('\n');
}

/**
 * Main entrypoint
 */
function main() {
  const verbose = process.argv.includes('--verbose');

  // Allow custom entry point (for testing)
  let entryFile;
  const customEntry = process.argv.find((arg) => !arg.startsWith('-'));
  if (customEntry && customEntry !== process.argv[1]) {
    entryFile = findFile(resolve(customEntry));
  } else {
    // Default to operator-vite
    entryFile = findFile(resolve(APP_DIR, 'src/main'));
  }

  if (!entryFile) {
    console.error(
      `❌ Entry point not found (tried ${customEntry || resolve(APP_DIR, 'src/main')}.*)`
    );
    process.exit(1);
  }

  console.log(`Scanning import graph from ${relative(ROOT, entryFile)}...\n`);

  const { files, violations } = walkGraph(entryFile);

  if (violations.size === 0) {
    console.log(`✓ No forbidden imports detected in the client graph.`);
    console.log(`  Scanned: ${files.size} files`);
    process.exit(0);
  }

  // Sort and format violations
  const sorted = Array.from(violations.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.error(`❌ Found ${violations.size} forbidden import(s):\n`);

  let totalChains = 0;
  for (const [module, chains] of sorted) {
    totalChains += chains.length;
    console.error(`  ⚠  ${module}`);
    if (verbose && chains.length > 0) {
      // Show up to 3 example chains
      const example = chains.slice(0, 3);
      for (let i = 0; i < example.length; i++) {
        const chain = example[i];
        if (chain.length <= 1) continue; // Skip if just the direct import
        console.error(`\n${formatChain(chain.slice(0, 15), module)}`);
      }
      if (chains.length > 3) {
        console.error(`\n      (+ ${chains.length - 3} more import path${chains.length > 4 ? 's' : ''})`);
      }
    }
  }

  console.error(`
Total: ${totalChains} import chain(s) to forbidden module(s)

Fix options:
  1. Lazy-load: \`const x = await import('...')\` in functions that need it
  2. Type-only: \`import type { X } from '...'\` if only types are needed
  3. Add shim: Add entry to apps/operator-vite/vite.config.ts resolve.alias
  4. Re-export: Deep-import from origin instead of importing barrel

Run with --verbose to see full import chains.
Read more: /internal/docs/agent-insights/fcp-server-libs-leak-into-eager-client-bundle
`);

  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
