#!/usr/bin/env node
/**
 * check-no-raw-control-bytes.mjs — recurrence guard for WI-5450.
 *
 * WI-5450: `packages/operator-core/lib/scout/src-hash.ts` (and 14 sibling files) used a
 * LITERAL NUL byte (0x00) inside a string/template literal as a composite-key separator
 * (`` `${a}\0${b}` ``, `const SEP = '\0'`, …) — a deliberate, working idiom (a NUL never
 * appears in a real path/id, so it can't collide). The problem isn't the runtime behavior
 * (identical either way); it's that a RAW control byte in a source file:
 *
 *   - renders as an invisible/space-like character in most text viewers (Read tool, `cat`,
 *     many editors) with NO visual cue that it isn't a real space — this cost three agents
 *     ~1.5h chasing a nonexistent "tsx compile cache serves stale code" bug on 2026-07-19,
 *     because "the file LOOKS like it says ' '" was mistaken for ground truth instead of a
 *     lossy rendering of the true byte (see
 *     docs/agent-insights/nul-byte-separator-reads-as-space-in-file-viewer).
 *   - makes git treat the whole file as **binary** (`Binary files ... differ` instead of a
 *     readable diff), which silently breaks `git diff`/`git log -p`/`grep` on that file for
 *     everyone, forever.
 *
 * The fix used repo-wide: replace the raw byte with the two-character TEXT ESCAPE `\0`
 * (backslash + zero) or `\xNN`/`\uXXXX` — byte-for-byte different on disk, IDENTICAL at
 * runtime (the JS/TS parser decodes the escape to the same code point), but now a normal,
 * diffable, greppable, honestly-rendered text file.
 *
 * This script is the going-forward guard: fail (or just report) if a NEW raw control byte
 * (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F — i.e. C0 controls other than \t \n \r) shows up in a
 * tracked .ts/.tsx/.mts/.cts source file. Escape sequences in source text (the two-character
 * `\`+`0`) are invisible to this check — it only flags the actual raw byte.
 *
 *   node scripts/check-no-raw-control-bytes.mjs             # report only (informational)
 *   node scripts/check-no-raw-control-bytes.mjs --strict    # exit 1 if any file has a hit
 *   node scripts/check-no-raw-control-bytes.mjs --self-test # verify the scanner on a fixture
 *
 * Scoped to git-tracked files (via `git ls-files`) so node_modules/build output never gets
 * scanned. Informational by default, like lint:knip / lint:generic-first — flip to --strict
 * once the fleet is comfortable it doesn't false-positive on some legitimate binary-adjacent
 * fixture; CI can opt in independently.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// C0 control bytes we consider "never legitimately raw in a text source file". Excludes
// \t (0x09), \n (0x0A), \r (0x0D) — normal whitespace/line-ending bytes.
const BAD_BYTES = new Set([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x0b, 0x0c,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

/** Scan one file's bytes; returns [{ offset, byte }] hits (empty if clean). */
export function scanBytesForControlChars(bytes) {
  const hits = [];
  for (let i = 0; i < bytes.length; i++) {
    if (BAD_BYTES.has(bytes[i])) hits.push({ offset: i, byte: bytes[i] });
  }
  return hits;
}

function listTrackedSourceFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((p) => {
      const dot = p.lastIndexOf('.');
      return dot !== -1 && EXTENSIONS.has(p.slice(dot));
    });
}

function selfTest() {
  const clean = Buffer.from("const x = '\\0hello';", 'utf8'); // TEXT escape — two bytes, no raw NUL
  const dirty = Buffer.from("const x = '\x00hello';", 'utf8'); // raw NUL byte
  const cleanHits = scanBytesForControlChars(clean);
  const dirtyHits = scanBytesForControlChars(dirty);
  if (cleanHits.length !== 0) throw new Error(`self-test FAILED: escape-sequence text falsely flagged: ${JSON.stringify(cleanHits)}`);
  if (dirtyHits.length !== 1 || dirtyHits[0].byte !== 0x00) throw new Error(`self-test FAILED: raw NUL byte not detected: ${JSON.stringify(dirtyHits)}`);
  console.log('check-no-raw-control-bytes: self-test passed (escape sequences pass clean, raw control bytes are caught).');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }
  const strict = args.includes('--strict');
  const files = listTrackedSourceFiles();
  const flagged = [];
  for (const rel of files) {
    let bytes;
    try {
      bytes = readFileSync(new URL(rel, `file://${ROOT}`));
    } catch {
      continue; // deleted-but-still-listed race, etc. — never fatal
    }
    const hits = scanBytesForControlChars(bytes);
    if (hits.length > 0) flagged.push({ file: rel, count: hits.length, firstOffset: hits[0].offset, firstByte: hits[0].byte });
  }
  if (flagged.length === 0) {
    console.log(`check-no-raw-control-bytes: clean (${files.length} tracked .ts/.tsx/.mts/.cts files scanned).`);
    return;
  }
  console.log(`check-no-raw-control-bytes: ${flagged.length} file(s) contain a raw control byte:`);
  for (const f of flagged) {
    console.log(`  ${f.file} — ${f.count} hit(s), first 0x${f.firstByte.toString(16).padStart(2, '0')} at byte offset ${f.firstOffset}`);
  }
  console.log(
    '\nIf this separator is intentional, use the TEXT ESCAPE (`\\0`, `\\xNN`, `\\uXXXX`) instead of' +
      " the raw byte — same runtime value, but the file stays readable/diffable/greppable (WI-5450:" +
      ' docs/agent-insights/nul-byte-separator-reads-as-space-in-file-viewer).',
  );
  if (strict) process.exitCode = 1;
}

main();
