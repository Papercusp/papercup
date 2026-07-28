#!/usr/bin/env node
/**
 * check-no-control-bytes.mjs — fail-loud guard for raw control bytes in source.
 *
 * EI-7432: a raw NUL byte in a TypeScript source file made ripgrep classify it
 * as binary and silently skip it, so repo-wide searches "proved" code absent
 * while the file still contained it. This guard scans tracked text-source files
 * as Buffers and rejects invisible control bytes before search tooling goes
 * blind.
 *
 *   node scripts/check-no-control-bytes.mjs
 *   node scripts/check-no-control-bytes.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
  '.rs',
  '.md',
  '.mdx',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
  '.sh',
  '.toml',
]);

// Prefixes for genuinely binary-ish fixtures that are intentionally tracked as
// source-like paths.
export const ALLOW_PREFIXES = [
  // WI-5450: minified, machine-generated pagefind search-index bundle, mirrored into
  // apps/operator/public by apps/operator-docs's postbuild-copy.sh on every docs build
  // (not hand-authored source — regenerated wholesale from the upstream `pagefind` npm
  // package's own output, which uses raw \x01/\x02 sentinel bytes internally for its
  // highlight-matching algorithm). Hand-editing it is pointless (the next docs build
  // overwrites it) and it isn't "our" source to rewrite.
  'apps/operator/public/internal/docs/pagefind/',
  // EI-18896048946123172: the packaged desktop sidecar — a wholesale build artifact
  // (a 42MB bundled `serve.mjs` plus hash-named Vite chunks under spa/assets/) that
  // only became visible once this guard started recursing into submodules. Bundlers
  // legitimately emit raw \x01-\x1f inside minified string tables (xterm's parser
  // tables are the bulk of it). It is regenerated wholesale by the desktop build, so
  // editing it is pointless and it is not hand-authored source.
  'papercusp-desktop/src-tauri/env-sidecars/',
];

export function isForbiddenControlByte(byte) {
  return byte === 0 || (byte >= 1 && byte <= 8) || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f);
}

export function findControlBytes(path, buffer) {
  const hits = [];
  for (let offset = 0; offset < buffer.length; offset++) {
    const byte = buffer[offset];
    if (!isForbiddenControlByte(byte)) continue;
    const start = Math.max(0, offset - 16);
    const end = Math.min(buffer.length, offset + 17);
    hits.push({
      path,
      offset,
      byte,
      contextHex: buffer.subarray(start, end).toString('hex').match(/.{1,2}/g)?.join(' ') ?? '',
    });
  }
  return hits;
}

function extensionOf(file) {
  const slash = file.lastIndexOf('/');
  const dot = file.lastIndexOf('.');
  if (dot <= slash) return '';
  return file.slice(dot);
}

function isScannedPath(file) {
  return SOURCE_EXTENSIONS.has(extensionOf(file)) && !ALLOW_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function gitLines(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function trackedSourceFiles() {
  // EI-18896048946123172: `git ls-files` STOPS AT THE SUPERPROJECT BOUNDARY. A submodule
  // is listed as a single gitlink entry with no file extension, so `isScannedPath` dropped
  // it and everything inside it was never opened. That silently exempted 4,531 tracked
  // source files (~24% of the tree) — all of libs/generic/**, libs/papercusp/** and
  // papercusp-desktop/** — which is why this guard printed "clean" for three days while a
  // raw NUL byte sat in libs/generic/sync/src/persisted-cache.ts and turned that file
  // binary to git diff and to ugrep.
  return gitLines(['ls-files', '-z', '--recurse-submodules']).filter(isScannedPath);
}

/**
 * Submodule prefixes, from gitlink index entries (mode 160000).
 *
 * Deliberately read from an oracle INDEPENDENT of the recursing listing above: if
 * `--recurse-submodules` ever stops recursing, this still enumerates the submodules, so
 * the coverage check below can falsify the scan instead of trusting it.
 */
export function submodulePrefixes() {
  return gitLines(['ls-files', '-s', '-z'])
    .filter((line) => line.startsWith('160000 '))
    .map((line) => `${line.slice(line.indexOf('\t') + 1)}/`);
}

/**
 * Submodules that hold scannable source but contributed ZERO files to the scan — i.e. the
 * selection silently skipped them. Returns [] when coverage is sound.
 */
export function uncoveredSubmodules(scanned, prefixes = submodulePrefixes()) {
  const missing = [];
  for (const prefix of prefixes) {
    if (scanned.some((file) => file.startsWith(prefix))) continue;
    if (!existsSync(join(ROOT, prefix))) continue; // submodule not checked out here
    let own;
    try {
      own = gitLines(['ls-files', '-z'], join(ROOT, prefix));
    } catch {
      continue; // not a usable git dir — nothing to assert
    }
    // Only a submodule that genuinely holds files this guard WOULD scan is a coverage gap.
    if (own.some((file) => isScannedPath(prefix + file))) missing.push(prefix);
  }
  return missing;
}

function scanTree() {
  const offenders = [];
  for (const file of trackedSourceFiles()) {
    let buf;
    try {
      buf = readFileSync(join(ROOT, file));
    } catch {
      continue; // File vanished between git ls-files and read.
    }
    offenders.push(...findControlBytes(file, buf));
  }
  return offenders;
}

function runSelfTest() {
  const cases = [
    { name: 'clean source', buffer: Buffer.from('const x = "ok";\n'), count: 0 },
    { name: 'allows tab newline carriage return', buffer: Buffer.from('a\tb\nc\rd'), count: 0 },
    { name: 'flags NUL', buffer: Buffer.from([0x63, 0x00, 0x64]), count: 1, byte: 0x00 },
    { name: 'flags vertical tab', buffer: Buffer.from([0x61, 0x0b, 0x62]), count: 1, byte: 0x0b },
    { name: 'flags unit separator', buffer: Buffer.from([0x61, 0x1f, 0x62]), count: 1, byte: 0x1f },
  ];
  let failed = 0;
  for (const c of cases) {
    const hits = findControlBytes('fixture.ts', c.buffer);
    const ok = hits.length === c.count && (c.byte === undefined || hits[0]?.byte === c.byte);
    if (!ok) {
      failed++;
      console.error(`  x ${c.name} — got ${JSON.stringify(hits)}`);
    }
  }
  if (failed) {
    console.error(`\ncheck-no-control-bytes --self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`check-no-control-bytes --self-test: all ${cases.length} cases passed`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const offenders = scanTree();
  if (offenders.length === 0) {
    console.log('check-no-control-bytes: clean — no forbidden raw control bytes in tracked source files');
    return;
  }
  console.error(
    `\ncheck-no-control-bytes: ${offenders.length} forbidden raw control byte(s) found.\n` +
      'These bytes make tools like ripgrep treat source as binary and silently skip it (EI-7432).\n' +
      'Remove the byte or, for an intentional binary-ish fixture, add a narrow prefix to ALLOW_PREFIXES.\n',
  );
  for (const o of offenders) {
    console.error(
      `  ${o.path}:${o.offset} byte=0x${o.byte.toString(16).padStart(2, '0')} context=${o.contextHex}`,
    );
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
