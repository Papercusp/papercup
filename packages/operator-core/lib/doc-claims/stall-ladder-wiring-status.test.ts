/**
 * EI-21528303638863879 recurrence guard: a module may not ADVERTISE ITSELF AS UNWIRED
 * while something imports it.
 *
 * `stall-escalation-ladder.ts` shipped inert, with a header saying so and pointing at
 * WI-42116 as the pending follow-up that would wire it. WI-42116 then landed the call site
 * in `harness/routines/release-actions.ts` and closed — and the header kept advertising the
 * module as un-imported.
 *
 * That is not a cosmetic lag. The ladder owns the human `notifyAttention` leg of gate-stall
 * escalation, deliberately split from the durable-escalation leg (release-actions.ts warns
 * at length not to recollapse them). An agent who reads "still inert, wiring tracked on
 * WI-42116", checks WI-42116, and finds it `done` draws the most natural available
 * inference — that the item was closed WITHOUT doing the wiring — and adds a SECOND call
 * site. Nothing crashes; the owner simply gets notified twice per rung, which is the
 * EI-7472 alert re-spam that this ladder's bounded, super-linear rung design exists to
 * prevent. The stale claim inverts the truth, so it is worse than no claim at all.
 *
 * WHY A GUARD RATHER THAN A CAREFUL EDIT: wiring status is a value that DESCRIBES code, so
 * per CLAUDE.md's derive/pin/attest ladder it must not be hand-maintained in prose. Rung 1
 * (derive) is not available to a comment; this is rung 2 (pin) — the claim stays readable
 * where a reader needs it, and the build fails the next time reality moves out from under
 * it.
 *
 * SCOPE IS DELIBERATE, in two directions:
 *  · Only PRODUCTION importers count. Tests import the module precisely to test it, and a
 *    test import is not a wiring decision.
 *  · The guard judges the module's SELF-DESCRIPTION, not other files' descriptions of it.
 *    A doc elsewhere calling the ladder inert is a different (and much less dangerous)
 *    claim, because it is not sitting in the file the wirer has open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPERATOR_CORE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LADDER = join(OPERATOR_CORE, 'lib/release/stall-escalation-ladder.ts');

/** The module specifier any importer of the ladder must mention. */
const LADDER_SPECIFIER = 'stall-escalation-ladder';

/**
 * Extract the leading block comment (the module header) — the only region whose claims
 * this guard judges. A claim buried beside the code it describes is out of scope; the
 * hazard is specifically the header a wirer reads first.
 */
export function moduleHeader(source: string): string {
  const start = source.indexOf('/**');
  if (start !== 0) return '';
  const end = source.indexOf('*/', start);
  return end < 0 ? '' : source.slice(start, end + 2);
}

/**
 * Does this header ASSERT that the module has no importers / no call site?
 *
 * Phrasings are matched as whole claims rather than on the word "inert" alone: the fixed
 * header legitimately uses "shipped inert" and "still inert" while NARRATING the history,
 * and a detector that fired on those would be unfixable — every correct header describing
 * the bug it fixed would trip it.
 */
export function claimsUnwired(header: string): string[] {
  const text = header.replace(/\s+/g, ' ');
  const patterns: Array<[string, RegExp]> = [
    ['nothing-imports', /nothing\s+imports\s+this/i],
    ['no-call-site', /\bno\s+call\s+site\b/i],
    ['not-imported', /\bnot\s+(?:yet\s+)?imported\b/i],
    ['un-imported', /\bun-?imported\b/i],
    ['wiring-is-a-follow-up', /wiring\s+is\s+a\s+follow-?up/i],
    ['nothing-calls-this', /nothing\s+calls\s+this/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Recursively collect .ts files under a directory, skipping node_modules. */
function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) tsFilesUnder(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Is this path a test/spec file (whose import is not a wiring decision)? */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path) || /\.integration\.test\.ts$/.test(path);
}

/**
 * Production files that import the ladder — excluding the module itself, any test, and
 * this guard (which necessarily names the specifier in order to look for it: the same
 * self-match trap that makes `pgrep -f <pattern>` match its own argv).
 */
export function productionImporters(): string[] {
  const self = resolve(fileURLToPath(import.meta.url));
  return tsFilesUnder(join(OPERATOR_CORE, 'lib'))
    .filter((f) => resolve(f) !== self)
    .filter((f) => resolve(f) !== resolve(LADDER))
    .filter((f) => !isTestFile(f))
    .filter((f) => readFileSync(f, 'utf8').includes(LADDER_SPECIFIER))
    .map((f) => relative(OPERATOR_CORE, f));
}

describe('unwired-claim detector — fixture controls (the detector must be able to FAIL)', () => {
  it('catches the exact stale claim that shipped', () => {
    const stale = `/**
 * PURE + INERT: nothing imports this yet, and it performs no I/O. Wiring is a follow-up
 * one-call-site change tracked on WI-42116.
 */`;
    expect(claimsUnwired(stale)).toContain('nothing-imports');
    expect(claimsUnwired(stale)).toContain('wiring-is-a-follow-up');
  });

  it('catches the common paraphrases a rewrite would reach for', () => {
    expect(claimsUnwired('/** built but not yet imported */')).toContain('not-imported');
    expect(claimsUnwired('/** deliberately INERT, no call site */')).toContain('no-call-site');
    expect(claimsUnwired('/** nothing calls this yet */')).toContain('nothing-calls-this');
  });

  it('is deliberately DUMB: a trigger phrase fires even inside historical narration', () => {
    // This is a design choice, and it caught a real defect the first time it ran: the
    // corrected header narrated its own history as "previously ... as un-imported", the
    // detector matched that, and the live-source test below went red on a module whose
    // wiring status was by then perfectly accurate.
    //
    // Keeping the matcher dumb is still right. Distinguishing an ASSERTED claim from a
    // NARRATED one is natural-language work that would make this guard unpredictable and
    // quietly permissive — the failure mode that matters here is a FALSE PASS, and a
    // false pass ships the double-wire trap. A false FAIL costs one rewording and says
    // exactly what to reword. So the contract is: a corrected header must describe its
    // history WITHOUT reusing a trigger phrase.
    const narrating = '/** This header previously advertised the module as un-imported. */';
    expect(claimsUnwired(narrating)).toContain('un-imported');
  });

  it('accepts a corrected header that narrates the history without a trigger phrase', () => {
    // The escape hatch the rule above obliges us to leave open — proof the guard is
    // satisfiable by an honest header, not just a permanent red.
    const fixed = `/**
 * PURE, AND WIRED — do not wire it again. This module shipped inert; it IS now imported by
 * release-actions.ts. This header previously described the module as still inert and its
 * wiring as a pending follow-up, which was a double-wire trap.
 */`;
    expect(claimsUnwired(fixed)).toEqual([]);
  });

  it('accepts a header making no wiring claim at all', () => {
    expect(claimsUnwired('/** Geometric growth factor between rungs. */')).toEqual([]);
  });

  it('only reads the leading block comment', () => {
    const src = '/**\n * clean header\n */\nconst x = 1; // nothing imports this\n';
    expect(claimsUnwired(moduleHeader(src))).toEqual([]);
  });

  it('returns an empty header when the file does not open with one', () => {
    expect(moduleHeader('const x = 1;\n/** later block */')).toBe('');
  });
});

describe('stall-escalation-ladder wiring status — live source', () => {
  const source = readFileSync(LADDER, 'utf8');

  it('the guard subject still exists and still opens with a header', () => {
    // A missing header is a real finding about this guard's subject, not a silent pass.
    expect(moduleHeader(source), 'stall-escalation-ladder.ts lost its module header').not.toBe('');
  });

  it('has one notification consumer and one read-only projection consumer', () => {
    // release-actions owns the notification decision. git-pipeline-stats uses
    // highestRungCrossed only to project whether a threshold has been crossed;
    // that pure read cannot notify twice. A third importer needs a new review.
    const importers = productionImporters();
    expect(importers).toEqual(['lib/git-pipeline-stats.ts', 'lib/harness/routines/release-actions.ts']);
  });

  it('does not advertise itself as unwired while it has production importers', () => {
    // THE CONTRACT. Not "the header must never say inert" — a header is free to say so
    // while it IS inert. The defect is the CONJUNCTION: an unwired claim standing next to
    // a real importer.
    const claims = claimsUnwired(moduleHeader(source));
    const importers = productionImporters();
    expect(
      claims.length === 0 || importers.length === 0,
      `stall-escalation-ladder.ts header asserts it is unwired (${claims.join(', ')}) ` +
        `but is imported by: ${importers.join(', ')}. Update the header — a reader who ` +
        `believes this module is inert will add a second call site and double every ` +
        `gate-stall owner notification (EI-21528303638863879).`,
    ).toBe(true);
  });
});
