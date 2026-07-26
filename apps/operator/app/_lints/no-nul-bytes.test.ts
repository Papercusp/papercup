/**
 * Source-integrity lint — no raw NUL byte may appear in operator source.
 *
 * A NUL in a text source file is always corruption, never intent: no language
 * here needs one, and every tool that meets it degrades SILENTLY rather than
 * erroring. `git grep`/`grep` reclassify the file as binary and stop matching it
 * (so a later audit sweeps straight past the file), `git diff` renders "Binary
 * files differ" instead of a reviewable hunk, and the parser happily accepts the
 * byte inside a string literal — so the damage lands at RUNTIME, not build time.
 *
 * That is exactly how it bit: /adv/HUD's "all fleets" sentinel is the string
 * ' all' (a leading space — deliberately not a valid kebab slug). HudBoard.tsx
 * had its copy's leading space corrupted to a NUL, so HudView's
 * `slug === ALL_FLEETS` never matched and clicking "all fleets" pushed a junk
 * slug into the filter — emptying the board instead of clearing the filter. The
 * corruption was invisible in review (a NUL renders as nothing), invisible to
 * grep (binary), and invisible to tsc (a legal string character). Only a
 * byte-level check like this one sees it.
 *
 * The sentinel now has a single exported definition, which stops THAT drift; this
 * lint is the class guard, so the next silently-corrupted file fails a test
 * instead of shipping a dead code path.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const APPS_ROOT = resolve(OPERATOR_ROOT, '..');

const SOURCE_DIRS = [join(OPERATOR_ROOT, 'app'), join(APPS_ROOT, 'operator-vite/src')];

const SKIP_DIR_NAMES = new Set(['node_modules', '.next', 'test-results', 'dist', 'build']);

/** Text sources only — a NUL is expected and fine inside a real binary asset. */
const TEXT_FILE_RE = /\.(?:tsx?|jsx?|css|md|mdx|json|ya?ml)$/;

const NUL = String.fromCharCode(0);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_FILE_RE.test(name)) out.push(full);
  }
  return out;
}

describe('source integrity', () => {
  it('contains no raw NUL bytes in operator text sources', () => {
    const offenders: string[] = [];

    for (const dir of SOURCE_DIRS) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes(NUL)) continue;
        const line = text.split('\n').findIndex((l) => l.includes(NUL)) + 1;
        offenders.push(`${relative(APPS_ROOT, file)}:${line}`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Raw NUL byte(s) found in text source:\n  ${offenders.join('\n  ')}\n\n` +
          'A NUL here is corruption, not intent — it makes the file "binary" to grep/diff ' +
          'and survives typecheck, so it breaks behaviour silently. Re-write the affected ' +
          'literal (a whitespace-ish sentinel belongs in ONE exported constant, imported ' +
          'everywhere else) rather than pasting the byte back.',
    ).toEqual([]);
  });
});
