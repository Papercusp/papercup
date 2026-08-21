#!/usr/bin/env node
/**
 * check-docs-mirror.mjs — source-to-served docs completeness guard
 * (EI-20041752458165941).
 *
 * The docs site has two independently useful representations of every source
 * page: Astro's served HTML page and emit-md-twins.ts's per-page Markdown twin.
 * A source .mdx/.md file that is committed without rebuilding the docs leaves
 * both HTTP surfaces stale while looking complete in the source tree. Keep the
 * detector path-based and pure so its mapping rules can be tested without
 * building Astro or reading the real (large) mirror.
 *
 * The HTML mapping follows Astro's `build.format: 'file'` behavior: a nested
 * `section/index.mdx` page is served as `section.html`. Markdown twins retain
 * the source's nested path (`section/index.md`). Hidden path segments are
 * Starlight/content-tooling support files, not published pages, and are
 * deliberately excluded from both sides of the comparison.
 *
 * Usage:
 *   node scripts/check-docs-mirror.mjs
 *   node scripts/check-docs-mirror.mjs --source-root=/path/to/content/docs \
 *     --mirror-root=/path/to/operator/public/internal/docs
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SOURCE_ROOT = join(REPO_ROOT, 'apps/operator-docs/src/content/docs');
export const DEFAULT_MIRROR_ROOT = join(REPO_ROOT, 'apps/operator/public/internal/docs');

const SOURCE_EXTENSIONS = new Set(['.md', '.mdx']);

/** Normalize a repository-relative path for deterministic, platform-neutral comparisons. */
export function normalizeRelativePath(value) {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** Hidden support files (including `.`, `..`, and dot-prefixed directories) are not pages. */
export function isVisibleDocPath(value) {
  const path = normalizeRelativePath(value);
  return path.length > 0 && !path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Map one source page to the two generated mirror paths it must have.
 * Returns null for non-doc or hidden paths.
 */
export function sourceToMirrorPaths(sourcePath) {
  const normalized = normalizeRelativePath(sourcePath);
  if (!isVisibleDocPath(normalized)) return null;

  const extension = extname(normalized).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) return null;

  const stem = normalized.slice(0, -extension.length);
  const htmlStem = stem === 'index'
    ? 'index'
    : stem.endsWith('/index')
      ? stem.slice(0, -'/index'.length)
      : stem;

  return {
    source: normalized,
    html: `${htmlStem || 'index'}.html`,
    markdown: `${stem}.md`,
  };
}

function visibleSet(paths) {
  return new Set(
    paths
      .map(normalizeRelativePath)
      .filter(isVisibleDocPath),
  );
}

/**
 * Pure detector: return every visible source page missing either generated twin.
 * `sourceFiles`, `htmlFiles`, and `markdownFiles` are relative paths.
 */
export function findMissingDocMirrors({ sourceFiles, htmlFiles, markdownFiles }) {
  const html = visibleSet(htmlFiles);
  const markdown = visibleSet(markdownFiles);
  const missing = [];

  for (const sourcePath of sourceFiles.map(normalizeRelativePath).sort()) {
    const expected = sourceToMirrorPaths(sourcePath);
    if (!expected) continue;

    const missingKinds = [];
    if (!html.has(expected.html)) missingKinds.push('html');
    if (!markdown.has(expected.markdown)) missingKinds.push('markdown');
    if (missingKinds.length > 0) {
      missing.push({
        source: expected.source,
        expected: { html: expected.html, markdown: expected.markdown },
        missing: missingKinds,
      });
    }
  }

  return missing;
}

/** Walk a docs root and return visible paths with one of the requested extensions. */
export function listVisibleFiles(root, extensions) {
  const wanted = new Set(extensions.map((extension) => extension.toLowerCase()));
  const out = [];

  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile() && wanted.has(extname(entry.name).toLowerCase())) {
        out.push(relativePath);
      }
    }
  }

  walk(root);
  return out.sort();
}

/** Read both trees and run the pure detector over their relative path sets. */
export function scanDocsMirror({ sourceRoot = DEFAULT_SOURCE_ROOT, mirrorRoot = DEFAULT_MIRROR_ROOT } = {}) {
  if (!existsSync(sourceRoot)) throw new Error(`docs source root does not exist: ${sourceRoot}`);
  if (!existsSync(mirrorRoot)) throw new Error(`docs mirror root does not exist: ${mirrorRoot}`);

  const sourceFiles = listVisibleFiles(sourceRoot, [...SOURCE_EXTENSIONS]);
  const htmlFiles = listVisibleFiles(mirrorRoot, ['.html']);
  const markdownFiles = listVisibleFiles(mirrorRoot, ['.md']);
  return {
    sourceFiles,
    htmlFiles,
    markdownFiles,
    missing: findMissingDocMirrors({ sourceFiles, htmlFiles, markdownFiles }),
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--source-root=')) options.sourceRoot = resolve(arg.slice('--source-root='.length));
    else if (arg.startsWith('--mirror-root=')) options.mirrorRoot = resolve(arg.slice('--mirror-root='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function formatMissingDocMirrors(missing) {
  const lines = [`DOCS_MIRROR_MISSING: ${missing.length} source page(s) lack a served twin.`];
  for (const hit of missing) {
    lines.push(`  - ${hit.source}: missing ${hit.missing.join(' + ')}`);
    if (hit.missing.includes('html')) lines.push(`      expected HTML: ${hit.expected.html}`);
    if (hit.missing.includes('markdown')) lines.push(`      expected Markdown: ${hit.expected.markdown}`);
  }
  lines.push('', 'FIX: run `npm run docs:rebuild` after changing a docs source page.');
  return lines.join('\n');
}

export function printUsage() {
  console.log('Usage: node scripts/check-docs-mirror.mjs [--source-root=DIR] [--mirror-root=DIR]');
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const result = scanDocsMirror(options);
  if (result.missing.length > 0) {
    console.error(formatMissingDocMirrors(result.missing));
    return 1;
  }

  console.log(
    `DOCS_MIRROR_OK: ${result.sourceFiles.length} source page(s) have HTML + Markdown twins ` +
      `(${result.htmlFiles.length} HTML, ${result.markdownFiles.length} Markdown mirror files scanned).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`DOCS_MIRROR_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
