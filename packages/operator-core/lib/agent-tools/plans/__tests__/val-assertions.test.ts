/**
 * extractAssertions — VAL-* inline assertion parsing.
 *
 * P-064 of harness-tests-tab-and-tester-promotion-2026-05-26: the
 * `RequiresTest:` sub-bullet (default true; explicit false exempts a VAL
 * from the tester/validator test gate) round-trips through the parser.
 */

import { describe, expect, it } from 'vitest';
import { extractAssertions } from '../val-assertions';

const PLAN = [
  '- **P-001** `todo` Implement CSV export.',
  '  - **[VAL-demo-001]**',
  '    - **Verify:** `GET /x` returns 200',
  '    - **Evidence:** `tests/x.test.ts`',
  '    - **Status:** `todo`',
  '  - **[VAL-demo-002]**',
  '    - **Verify:** The button copy reads "Download".',
  '    - **Evidence:** Visual — design-spec match.',
  '    - **Status:** `todo`',
  '    - **RequiresTest:** `false`',
  '  - **[VAL-demo-003]**',
  '    - **Verify:** Header row matches column order.',
  '    - **Evidence:** `tests/x.test.ts`',
  '    - **Status:** `passed`',
  '    - **RequiresTest:** `true`',
].join('\n');

describe('extractAssertions — RequiresTest', () => {
  const byId = Object.fromEntries(extractAssertions(PLAN).map((a) => [a.valId, a]));

  it('parses all three assertions with Verify/Evidence/Status intact', () => {
    expect(Object.keys(byId).sort()).toEqual(['VAL-demo-001', 'VAL-demo-002', 'VAL-demo-003']);
    expect(byId['VAL-demo-001'].verifyText).toBe('`GET /x` returns 200');
    expect(byId['VAL-demo-003'].status).toBe('passed');
  });

  it('defaults requiresTest to true when the sub-bullet is absent', () => {
    expect(byId['VAL-demo-001'].requiresTest).toBe(true);
  });

  it('parses an explicit `RequiresTest: false` as an exemption', () => {
    expect(byId['VAL-demo-002'].requiresTest).toBe(false);
  });

  it('parses an explicit `RequiresTest: true`', () => {
    expect(byId['VAL-demo-003'].requiresTest).toBe(true);
  });
});

/**
 * WI-1411580 — VAL field lines are TOLERANT ABOUT FORM, STRICT ABOUT SUBSTANCE.
 *
 * These lines are hand-authored, so emphasis markup, bullet character and indent style
 * vary while the meaning does not. `VAL_FIELD_RE` used to require exactly bold-with-the-
 * colon-inside, a `-` bullet, and 2+ spaces of indent: of the 12 spellings below only 4
 * matched. The failure was silent AND self-contradicting — `extractAssertions` drops any
 * candidate lacking `verifyText`, so `promotion-assertion-gate` told an agent who HAD
 * written a `**Verify**:` line that their item declared no assertion, and advised them to
 * add the very line they already had.
 *
 * Driven through `extractAssertions` (the real consumer) rather than the regex, so these
 * pin the BEHAVIOUR an author experiences, not an implementation detail. The negative
 * cases are the other half: widening form must not widen meaning, and without them a
 * regex that matched everything would pass this file.
 */
/**
 * Every spelling an author plausibly writes. Shared by the accept cases and by the
 * legacy-regex control below, so the two can never drift apart into a control that
 * calibrates a different sample than the one being tested.
 */
const ACCEPTED_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['canonical bold, colon inside', '    - **Verify:** it returns 200'],
  ['bold with the colon OUTSIDE', '    - **Verify**: it returns 200'],
  ['no emphasis at all', '    - Verify: it returns 200'],
  ['single italic', '    - *Verify:* it returns 200'],
  ['a single TAB of indent', '\t- **Verify:** it returns 200'],
  ['two tabs of indent', '\t\t- **Verify:** it returns 200'],
  ['a `*` bullet', '    * **Verify:** it returns 200'],
  ['a `+` bullet', '    + **Verify:** it returns 200'],
  ['a space before the colon', '    - **Verify** : it returns 200'],
  ['a deeper indent', '            - **Verify:** it returns 200'],
  ['extra spaces after the colon', '    - **Verify:**     it returns 200'],
  ['a trailing CR (CRLF-authored plan)', '    - **Verify:** it returns 200\r'],
];

describe('extractAssertions — authored field-line spellings (WI-1411580)', () => {
  const parse = (fieldLine: string) =>
    extractAssertions(['- **P-001** `todo` Ship it.', '  - **[VAL-form-001]**', fieldLine].join('\n'));

  /**
   * The pre-fix regex, kept as a deliberately-wrong CONTROL implementation. For an
   * imported module this is the falsifiability proof: mutating `val-assertions.ts` on
   * the shared tree to show these tests can fail would let the git-sync sweep commit the
   * mutant, so the wrong implementation lives here permanently and is re-proven on every
   * run instead. Without it, a future edit that quietly re-narrowed the matcher would
   * still pass this file — the accept cases would simply stop being reached.
   */
  const LEGACY_VAL_FIELD_RE = /^\s{2,12}-\s+\*\*(Verify|Evidence|Status|RequiresTest):\*\*\s*(.*)/;

  it('CONTROL: the pre-fix regex really did miss most of these spellings', () => {
    const missed = ACCEPTED_FORMS.filter(([, line]) => !LEGACY_VAL_FIELD_RE.test(line)).map(([label]) => label);
    // Measured, not asserted from memory. The exact set matters: it shows the old rule
    // was about EMPHASIS, BULLET CHARACTER and TAB indent — none of which carry meaning —
    // while every spelling it did accept differed only in whitespace.
    expect(missed).toEqual([
      'bold with the colon OUTSIDE',
      'no emphasis at all',
      'single italic',
      'a single TAB of indent',
      'a `*` bullet',
      'a `+` bullet',
      'a space before the colon',
    ]);
    // CALIBRATION: the real parser must accept every one of them, including the 5 the
    // legacy regex also accepted — so a pass here means "the fix works", never "the
    // sample drifted to cases both implementations happen to agree on".
    expect(ACCEPTED_FORMS.filter(([, line]) => parse(line).length !== 1).map(([label]) => label)).toEqual([]);
  });

  it.each(ACCEPTED_FORMS)('accepts %s', (_label, line) => {
    const [assertion] = parse(line);
    expect(assertion, `this spelling produced no assertion: ${JSON.stringify(line)}`).toBeDefined();
    // The value must survive intact — a tolerant matcher that eats part of the text
    // would still "parse" while quietly corrupting what the author wrote.
    expect(assertion!.verifyText).toBe('it returns 200');
  });

  it.each([
    ['a top-level (un-nested) field line', '- **Verify:** it returns 200'],
    ['an unknown key', '    - **Notes:** it returns 200'],
    ['a key that merely starts with a known one', '    - **Verifying:** it returns 200'],
    ['no colon at all', '    - **Verify** it returns 200'],
    ['prose that merely contains the word', '    plain prose mentioning Verify: here'],
    ['an empty value', '    - **Verify:**'],
  ])('still rejects %s', (_label, line) => {
    expect(parse(line), `this should NOT have produced an assertion: ${JSON.stringify(line)}`).toEqual([]);
  });

  it('reads every field key in a non-canonical spelling, not just Verify', () => {
    const [assertion] = extractAssertions(
      [
        '- **P-001** `todo` Ship it.',
        '  - **[VAL-form-002]**',
        '    - Verify: it returns 200',
        '    - **Evidence**: `tests/x.test.ts`',
        '    * Status: `passed`',
        '\t\t- RequiresTest: false',
      ].join('\n'),
    );
    expect(assertion).toBeDefined();
    expect(assertion!.verifyText).toBe('it returns 200');
    expect(assertion!.evidenceText).toBe('`tests/x.test.ts`');
    expect(assertion!.status).toBe('passed');
    expect(assertion!.requiresTest).toBe(false);
  });
});
