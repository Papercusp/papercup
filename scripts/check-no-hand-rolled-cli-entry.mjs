#!/usr/bin/env node
/**
 * lint:no-hand-rolled-cli-entry — keep ESM CLI self-exec guards on the one
 * bundle-safe primitive, `isCliEntry(import.meta.url)`.
 *
 * The familiar `import.meta.url === pathToFileURL(process.argv[1]).href` check
 * is correct in an unbundled file and wrong in an esbuild single-file bundle:
 * every inlined module inherits the bundle entry's `import.meta.url`, so every
 * imported CLI can run its `main()` during host boot and call `process.exit()`.
 * The same applies to the template-literal and fileURLToPath spellings.
 *
 * Existing debt is measured once and kept in a SHRINK-ONLY count baseline. A
 * new occurrence in an already-baselined file still fails: counts are keyed by
 * path and spelling rather than allowing a whole file to hide future debt.
 * Migrate a site to `isCliEntry` and remove its count from the baseline.
 *
 * `--list` is the only supported way to seed or audit the measured population;
 * it scans source files with comments, strings, and regex bodies masked by the
 * shared parser-backed stripper, so quoted guidance cannot become a phantom.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['scripts', 'packages', 'libs', 'apps'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/i;
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '_retired',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'dist-sidecar',
  'node_modules',
  'out',
  'public',
  'target',
]);

/**
 * Measured pre-existing population. This is deliberately empty until the
 * first `node scripts/check-no-hand-rolled-cli-entry.mjs --list` run seeds it.
 * Entries are `${repo-relative-path}|${guard-kind}` -> count.
 */
const ALLOW_COUNTS = new Map([
  // Seeded from --list after the detector itself is in place.
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (
      SOURCE_EXT.test(name) &&
      !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

/** Return a stable line number for a source offset. */
function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Find the three equivalent ESM self-exec idioms that collapse inside a bundle.
 * The input is masked first, so the expressions below only see executable code.
 */
export function findGuards(source, fileName = 'cli-entry.mjs') {
  const masked = stripCommentsAndStrings(source, fileName);
  const patterns = [
    {
      kind: 'path-to-file-url',
      // Allow argv aliases, resolve(), realpathSync(), and multiline calls.
      re: /import\.meta\.url\s*===\s*pathToFileURL[\s\S]{0,320}?\.href\b/g,
    },
    {
      kind: 'file-template',
      re: /import\.meta\.url\s*===\s*`[^`]*\$\{\s*process\.argv\s*\[\s*1\s*\]\s*\}[^`]*`/g,
    },
    {
      kind: 'file-url-to-path',
      re: /(?:fileURLToPath\w*\s*\(\s*import\.meta\.url\s*\)\s*===\s*process\.argv\s*\[\s*1\s*\]|process\.argv\s*\[\s*1\s*\]\s*===\s*fileURLToPath\w*\s*\(\s*import\.meta\.url\s*\))/g,
    },
  ];
  const hits = [];
  for (const { kind, re } of patterns) {
    for (const match of masked.matchAll(re)) {
      hits.push({ kind, offset: match.index, line: lineAt(source, match.index), text: source.slice(match.index, match.index + match[0].length) });
    }
  }
  // A future spelling may satisfy two broad patterns. Report one occurrence,
  // while retaining the first (most specific) classification for the baseline.
  const unique = new Map();
  for (const hit of hits) unique.set(`${hit.offset}:${hit.kind}`, hit);
  return [...unique.values()].sort((a, b) => a.offset - b.offset || a.kind.localeCompare(b.kind));
}

function keyFor(rel, kind) {
  return `${rel}|${kind}`;
}

function currentSourceFiles() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(ROOT, root))) files.push(file);
  }
  return files.sort();
}

/** Scan the complete source population, ignoring the shrink-only baseline. */
export function scanTree() {
  const everyGuard = [];
  for (const file of currentSourceFiles()) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    for (const hit of findGuards(source, rel)) everyGuard.push({ rel, ...hit });
  }

  const counts = new Map();
  for (const hit of everyGuard) {
    const key = keyFor(hit.rel, hit.kind);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const violations = [];
  for (const hit of everyGuard) {
    const key = keyFor(hit.rel, hit.kind);
    const allowed = ALLOW_COUNTS.get(key) ?? 0;
    const prior = everyGuard
      .filter((candidate) => keyFor(candidate.rel, candidate.kind) === key && candidate.offset < hit.offset)
      .length;
    if (prior >= allowed) violations.push(hit);
  }

  const stale = [...ALLOW_COUNTS.entries()]
    .filter(([key, allowed]) => (counts.get(key) ?? 0) < allowed)
    .map(([key, allowed]) => ({ key, allowed, current: counts.get(key) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { everyGuard, counts, violations, stale };
}

const LIST_ONLY = process.argv.includes('--list');

export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  typeof entryPath === 'string' && /(?:^|[\\/])check-no-hand-rolled-cli-entry\.mjs$/.test(entryPath);

function printSeed(everyGuard, counts) {
  console.log(`${everyGuard.length} hand-rolled ESM CLI-entry guard(s) across ${new Set(everyGuard.map((x) => x.rel)).size} file(s):\n`);
  for (const hit of everyGuard) console.log(`  ${hit.rel}:${hit.line}  ${hit.kind}`);
  console.log('\nALLOW_COUNTS seed (paste into this script):\n');
  for (const [key, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ['${key.replaceAll("'", "\\'")}', ${count}],`);
  }
}

function main() {
  const { everyGuard, counts, violations, stale } = scanTree();
  if (LIST_ONLY) {
    printSeed(everyGuard, counts);
    return;
  }
  if (violations.length > 0) {
    console.error(`\n✖ lint:no-hand-rolled-cli-entry — ${violations.length} new hand-rolled ESM CLI-entry guard(s):\n`);
    for (const hit of violations) console.error(`  ${hit.rel}:${hit.line}  ${hit.kind}`);
    console.error(
      '\nUse the bundle-safe helper instead:\n' +
        "  import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';\n" +
        '  if (isCliEntry(import.meta.url)) main();\n',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✔ lint:no-hand-rolled-cli-entry — no new hand-rolled guards (${everyGuard.length} measured occurrence(s)).`);
  if (stale.length > 0) {
    console.log('\nStale baseline entries (migrated or removed; delete them from ALLOW_COUNTS):');
    for (const item of stale) console.log(`  ${item.key}: allowed ${item.allowed}, current ${item.current}`);
  }
}

if (isDirectCliInvocation()) main();
