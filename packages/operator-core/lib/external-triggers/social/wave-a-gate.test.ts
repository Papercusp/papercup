/**
 * P-014 — the Wave A gate.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately does NOT do.
 *
 * Each Wave A adapter already runs itself through the P-003 conformance kit in
 * its own test file, and `conformance.test.ts` already proves the kit is
 * falsifiable (eight permanent broken-adapter controls) and honest about what
 * it skips. None of that is repeated here — re-proving it would be duplication,
 * not a gate.
 *
 * What no single-adapter test can assert is a WAVE-level property, because each
 * adapter test only ever sees itself. Two such properties carry P-014:
 *
 *   1. THE KIT WAS NOT BENT TO FIT A PLATFORM. P-014 is explicit that any
 *      conformance-kit change needed to accommodate a platform is a finding
 *      about the KIT, to be recorded — not quietly patched per-adapter. The
 *      executable form of that clause: no platform name may appear in the kit's
 *      EXECUTABLE CODE.
 *
 *      Prose is exempt, and that exemption is load-bearing rather than a
 *      loophole: the kit's comments cite Bluesky's retention window and
 *      Mastodon's absent cursor as the motivating examples for the
 *      cursor-unusable check. Naming why a check exists is documentation.
 *      Branching on who is being checked is special-casing. Only the second is
 *      a defect, so the guard strips comments before it looks.
 *
 *   2. THERE IS ONE KIT. All three adapters import the same runner from the
 *      same module. A forked or copied kit is the quiet way an adapter ends up
 *      passing a weaker suite while still reporting "conformance" — the failure
 *      mode clause 1 is written against, arrived at from the other direction.
 *
 * NOT asserted here, deliberately: that every kit check is exercised somewhere
 * in Wave A. That is already carried by bluesky-adapter.test.ts, which asserts
 * `checksSkipped` is empty — one adapter running the complete suite covers the
 * whole check universe on its own. Restating it here would be a second copy of
 * a truth that file already owns.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The directory this gate reads its subjects from. Defaults to the real one.
 *
 * The override exists so falsifiability can be PROVEN without mutating the
 * shared tree: point it at a copy carrying a deliberate special-case and this
 * suite must go red. Mutating the real kit in place to prove the same thing
 * would race git-sync, which sweeps and commits the whole tree on a timer — a
 * probe legitimately holds its mutation for as long as the suite runs, so a
 * sweep landing in that window commits it even though nothing went wrong.
 */
const SUBJECT_DIR = process.env.WAVE_A_GATE_SUBJECT_DIR ?? HERE;

/** The kit itself: the runner plus the contract every adapter implements. */
const KIT_FILES = ['conformance.ts', 'adapter-contract.ts'] as const;

/** The three platforms that make up Wave A. */
const WAVE_A_PLATFORMS = ['bluesky', 'mastodon', 'reddit'] as const;

const read = (file: string): string => readFileSync(join(SUBJECT_DIR, file), 'utf8');

/**
 * Strip comments while preserving string literals.
 *
 * Both naive forms are wrong in ways that matter here: cutting at every `//`
 * eats the back half of any URL inside a string literal, and cutting at every
 * `/*` eats a string that merely contains one. So this tracks quote state.
 *
 * Regex literals are not tracked. The kit contains none whose body could be
 * mistaken for a comment, and the CONTROL below measures that this function
 * still removes prose and still keeps code — so a future regression in the
 * stripper shows up as a failing control rather than as a guard that silently
 * stops looking at anything.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      if (ch === '\\') {
        out += ch + (source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

describe('P-014 Wave A gate — the kit was not bent to fit a platform', () => {
  it.each(KIT_FILES)('%s names no Wave A platform in executable code', (file) => {
    const code = stripComments(read(file));

    // POSITIVE CONTROL on the instrument. An absence claim needs one: if the
    // read or the stripper returned (nearly) nothing, every assertion below
    // would pass while measuring literally no code.
    expect(code.length).toBeGreaterThan(500);

    for (const platform of WAVE_A_PLATFORMS) {
      expect(
        code.toLowerCase(),
        `${file} branches on "${platform}" in executable code. P-014: a kit change needed to ` +
          `accommodate a platform is a finding about the KIT and must be recorded, not patched here.`,
      ).not.toContain(platform);
    }
  });

  it('CONTROL: the guard fires on special-casing and stays silent on prose', () => {
    // It must CATCH a real per-adapter patch...
    const specialCased = `if (adapter.platformId === 'mastodon') { skipCursorCheck(); }`;
    expect(stripComments(specialCased).toLowerCase()).toContain('mastodon');

    // ...and must TOLERATE the same name in documentation, in both comment
    // forms the kit actually uses. Without this half, a stripper that ate the
    // whole file would look exactly like a clean kit.
    const blockProse = `/** Bluesky refuses a cursor past its retention window. */\nconst keep = 1;`;
    expect(stripComments(blockProse).toLowerCase()).not.toContain('bluesky');
    expect(stripComments(blockProse)).toContain('const keep = 1;');

    const lineProse = `// Mastodon has no cursor at all.\nconst alsoKeep = 2;`;
    expect(stripComments(lineProse).toLowerCase()).not.toContain('mastodon');
    expect(stripComments(lineProse)).toContain('const alsoKeep = 2;');

    // A string literal is code, not prose: a URL must survive the `//` cut.
    expect(stripComments(`const u = 'https://bsky.social/xrpc';`)).toContain('https://bsky.social/xrpc');
  });
});

describe('P-014 Wave A gate — there is one kit, and all three adapters use it', () => {
  it('exports the conformance runner from exactly one module', () => {
    const sources = readdirSync(SUBJECT_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    // POSITIVE CONTROL: the directory scan found the modules at all.
    expect(sources.length).toBeGreaterThan(3);

    const exporters = sources.filter((f) =>
      /export\s+(async\s+)?function\s+runSocialAdapterConformance/.test(read(f)),
    );

    expect(
      exporters,
      'more than one module exports the conformance runner — a forked kit lets an adapter ' +
        'pass a weaker suite while still reporting "conformance"',
    ).toEqual(['conformance.ts']);
  });

  it.each(WAVE_A_PLATFORMS)('the %s adapter is run against the shared kit', (platform) => {
    const source = read(`${platform}-adapter.test.ts`);

    expect(source).toContain("from './conformance'");
    expect(source).toContain('runSocialAdapterConformance(');
  });
});
