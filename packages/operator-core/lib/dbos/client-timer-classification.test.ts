/**
 * client-timer-classification.test.ts — the CLIENT half of the timer-classification guard
 * (`scripts/check-timer-classification.mjs`), P-026 of
 * semantic-search-fingerprint-coverage-2026-08-03.
 *
 * WHY THIS FILE EXISTS: the guard's own header cited this filename TWICE — once as the
 * thing that "asserts the handoff stays airtight, so a file cannot fall between the two"
 * guards, and once as what "fails if that guard grows a browser/client entry this set does
 * not know". Neither claim was backed: the file had never been committed (`git log --all`
 * empty for the path), and the only existing test covered the HOST predicate. The client
 * scan shipped 2026-08-09 with zero coverage while a comment asserted otherwise — the same
 * shape CLAUDE.md documents at length, where a confident citation outlives the thing it
 * cites. Every assertion below was measured against the real predicate before being
 * written, not inferred from reading it.
 *
 * TWO GUARDS, ONE POPULATION, NO GAP:
 *   - `check-no-raw-setinterval.mjs` asks "is this timer visible in schedule:inventory?"
 *     — a question a renderer timer structurally cannot answer, so it EXEMPTS browser
 *     /client code (`.tsx` wholesale, plus BROWSER_CLIENT_ALLOWLIST by name).
 *   - `check-timer-classification.mjs` asks "did you declare a D-004 classification?" and
 *     picks up exactly that exempted population via `isClientFile`.
 * A file that leaves the first without arriving at the second is checked by NEITHER. That
 * is a silent hole, not a loud failure, which is why it needs a test rather than a comment.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only.
// Kept on ONE line deliberately: tsc reports TS7016 at the module-SPECIFIER line, so on a
// multi-line import the @ts-ignore above lands on `import {` and suppresses nothing (the
// directive only covers the immediately-following line). Do not re-wrap this import.
import { findUndeclaredClientTimers, isClientFile, CLASSIFICATIONS, CLIENT_TS_FILES, DECL_LOOKBACK_LINES } from '../../../../scripts/check-timer-classification.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its allowlist sets only.
import { BROWSER_CLIENT_ALLOWLIST, ALLOWLIST, isExcluded } from '../../../../scripts/check-no-raw-setinterval.mjs';

describe('client timer-classification predicate (P-026)', () => {
  it('FLAGS a bare setInterval() with no declaration', () => {
    expect(findUndeclaredClientTimers('const t = setInterval(fn, 1000);')).toEqual([1]);
  });

  it('FLAGS window.setInterval() — the dominant client spelling', () => {
    expect(findUndeclaredClientTimers('const t = window.setInterval(fn, 1000);')).toEqual([1]);
  });

  it('does NOT flag managedSetInterval() — that is the HOST scan\'s call site, not this one', () => {
    expect(
      findUndeclaredClientTimers("managedSetInterval('x', 1000, fn, { category: 'c' });"),
    ).toEqual([]);
  });

  it('does NOT flag a member call (foo.setInterval / this.setInterval) — not the global timer', () => {
    expect(findUndeclaredClientTimers('const t = foo.setInterval(fn, 1000);')).toEqual([]);
    expect(findUndeclaredClientTimers('const t = this.setInterval(fn, 1000);')).toEqual([]);
  });

  it('accepts a declaration on the line(s) ABOVE the call', () => {
    expect(
      findUndeclaredClientTimers(
        '// timer-classification: ui-timer — render tick\nconst t = setInterval(fn, 1000);',
      ),
    ).toEqual([]);
  });

  it('accepts a declaration on the call\'s OWN line', () => {
    expect(
      findUndeclaredClientTimers(
        'const t = setInterval(fn, 1000); // timer-classification: must-sample',
      ),
    ).toEqual([]);
  });

  it('accepts every classification in the vocabulary, and ONLY those', () => {
    for (const c of CLASSIFICATIONS) {
      expect(
        findUndeclaredClientTimers(`// timer-classification: ${c}\nconst t = setInterval(fn, 1);`),
      ).toEqual([]);
    }
    // An unrecognised bucket must NOT satisfy the guard — otherwise "timer-classification:
    // whatever" silently passes and the vocabulary means nothing. Measured: flagged.
    expect(
      findUndeclaredClientTimers('// timer-classification: whatever\nconst t = setInterval(fn, 1);'),
    ).toEqual([2]);
  });

  it('enforces the proximity window — a declaration further than DECL_LOOKBACK_LINES above does NOT count', () => {
    const far = `// timer-classification: ui-timer\n${'\n'.repeat(DECL_LOOKBACK_LINES + 2)}const t = setInterval(fn, 1);`;
    expect(findUndeclaredClientTimers(far)).not.toEqual([]);
    const near = `// timer-classification: ui-timer\n${'\n'.repeat(DECL_LOOKBACK_LINES - 2)}const t = setInterval(fn, 1);`;
    expect(findUndeclaredClientTimers(near)).toEqual([]);
  });
});

describe('client/host file partition (P-026)', () => {
  it('treats every .tsx as client, and a host .ts as host', () => {
    expect(isClientFile('apps/operator-vite/src/components/Anything.tsx')).toBe(true);
    expect(isClientFile('packages/operator-core/lib/some-host-file.ts')).toBe(false);
  });

  it('treats a named CLIENT_TS_FILES entry as client', () => {
    for (const f of CLIENT_TS_FILES) expect(isClientFile(f)).toBe(true);
  });
});

/**
 * THE HANDOFF INVARIANT — the claim the guard's header made and nothing enforced.
 *
 * Anchored to an exported SET (`BROWSER_CLIENT_ALLOWLIST`), not to comment placement.
 * The previous arrangement encoded "is this browser/client?" as which comment heading an
 * entry sat under, and two entries already sat under the "Separate processes" heading with
 * their own inline `// browser ...` note — so any check that read section headers would
 * have mis-partitioned them while looking rigorous.
 */
describe('two-guard handoff: no file falls between them (P-026)', () => {
  it('every browser/client file exempted by no-raw-setinterval is PICKED UP by the client scan', () => {
    const dropped = [...BROWSER_CLIENT_ALLOWLIST].filter((f) => !isClientFile(f as string));
    expect(
      dropped,
      `These files are exempt from lint:no-raw-setinterval as browser/client, but ` +
        `check-timer-classification's isClientFile() does not claim them — so NEITHER guard ` +
        `checks them. Add each to CLIENT_TS_FILES in scripts/check-timer-classification.mjs.`,
    ).toEqual([]);
  });

  it('every non-.tsx client file the classification scan claims is EXEMPTED by no-raw-setinterval', () => {
    // The reverse direction. A client `.ts` this scan claims but the sibling guard still
    // polices would be asked to satisfy two contradictory contracts at once: register with
    // a host registry the renderer cannot reach, AND declare a client classification.
    const contested = [...CLIENT_TS_FILES].filter(
      (f) => !ALLOWLIST.has(f as string) && !isExcluded(f as string),
    );
    expect(
      contested,
      `These files are scanned as CLIENT by check-timer-classification but are NOT exempt ` +
        `from lint:no-raw-setinterval, so both guards police them under incompatible rules.`,
    ).toEqual([]);
  });

  it('the two sets agree exactly on the non-.tsx client population', () => {
    // Measured 2026-08-09: 9 files, identical both ways. Stated as set equality rather than
    // a count so a legitimate addition to either side fails LOUDLY on the missing twin
    // instead of silently drifting past a hardcoded number.
    expect(new Set(CLIENT_TS_FILES)).toEqual(new Set(BROWSER_CLIENT_ALLOWLIST));
  });
});
