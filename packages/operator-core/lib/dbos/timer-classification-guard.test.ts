/**
 * timer-classification-guard.test.ts — the timer-classification CI guard's detection
 * predicate (stop-discarded-dedup-and-audit-server-polling-2026-07-26, P-011).
 *
 * The guard (`scripts/check-timer-classification.mjs`) runs green on the clean tree
 * (BASELINE grandfathers the pre-P-011 unclassified call sites). This locks the
 * direction P-011 actually asks for — that it FLAGS a NEW `managedSetInterval(...)`
 * call missing a `classification`, while NOT flagging one that declares it (whether
 * as a literal or a threaded property reference), and ignores comments/prose.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only.
// Kept on ONE line deliberately: tsc reports TS7016 at the module-SPECIFIER line, so on a
// multi-line import the @ts-ignore above lands on `import {` and suppresses nothing (the
// directive only covers the immediately-following line). Do not re-wrap this import.
import { findManagedSetIntervalCalls, hasUnclassifiedCall } from '../../../../scripts/check-timer-classification.mjs';

describe('timer-classification guard predicate (P-011)', () => {
  it('FLAGS a managedSetInterval(...) call with no classification', () => {
    expect(
      hasUnclassifiedCall("managedSetInterval('x', 1000, fn, { category: 'global-sweep' });"),
    ).toBe(true);
  });

  it('does NOT flag a call declaring classification as a literal', () => {
    expect(
      hasUnclassifiedCall(
        "managedSetInterval('x', 1000, fn, { category: 'global-sweep', classification: 'must-sample' });",
      ),
    ).toBe(false);
  });

  it('does NOT flag a call threading classification from a variable/property (in-process-periodic.ts shape)', () => {
    expect(
      hasUnclassifiedCall(
        "managedSetInterval(check.name, check.intervalMs, fn, { category: 'global-sweep', classification: check.classification });",
      ),
    ).toBe(false);
  });

  it('does NOT flag a managedSetInterval(...) mentioned only in a comment (comments are stripped)', () => {
    const codeWithComment = [
      '// legacy: managedSetInterval(name, ms, fn, { category }) used to omit classification',
      "managedSetInterval('y', 2000, fn, { category: 'watchdog', classification: 'timeout-reaper' });",
    ].join('\n');
    expect(hasUnclassifiedCall(codeWithComment)).toBe(false);
  });

  it('is independent per call — one classified + one unclassified call in the same file still flags', () => {
    const code = [
      "managedSetInterval('a', 1000, fn, { category: 'cache', classification: 'must-sample' });",
      "managedSetInterval('b', 2000, fn, { category: 'cache' });",
    ].join('\n');
    expect(hasUnclassifiedCall(code)).toBe(true);
  });

  it('findManagedSetIntervalCalls extracts the balanced-paren argument text per call', () => {
    const code =
      "managedSetInterval('nested', 1000, () => doThing({ a: 1 }), { category: 'cache', classification: 'must-sample' });";
    const calls = findManagedSetIntervalCalls(code);
    expect(calls).toHaveLength(1);
    // Asserts the extraction spans the NESTED parens rather than stopping at the first ')'.
    // This used to assert toContain("'nested'"), i.e. on a string VALUE. String literal
    // contents are now emptied before scanning (EI-19989853369726696), so that assertion
    // was rewritten to check code-shaped structure instead — the extractor's actual
    // contract. The guard only ever reads the `classification:` KEY, never a value.
    expect(calls[0]).toContain('doThing({ a: 1 })');
    expect(calls[0]).toContain('category');
    expect(calls[0]).toContain('classification');
  });

  // --- EI-19989853369726696: the phantom-offender class -----------------------------
  // These are the twin of the comment test above. A call-shaped token inside a STRING
  // is not a call site, and treating it as one red-pinned the fleet gate for hours.

  it('does NOT flag a managedSetInterval( mentioned only in a STRING literal', () => {
    // Verbatim shape of the real phantom: green-checkpoint.ts quotes ANOTHER guard's
    // failure text, and `\s*\(` matched the space before `(P-008)`, so `P-008` was
    // parsed as the call's argument text and reported as an unclassified timer.
    const code =
      "const msg = '=== LINT FAILED — a new recurring timer bypassed managedSetInterval (P-008) ===';";
    expect(findManagedSetIntervalCalls(code)).toHaveLength(0);
    expect(hasUnclassifiedCall(code)).toBe(false);
  });

  it('does NOT flag a managedSetInterval( inside a template literal or a double-quoted string', () => {
    const code = [
      'const a = `see managedSetInterval(name, ms) for the contract`;',
      'const b = "call managedSetInterval(x) instead of setInterval";',
    ].join('\n');
    expect(findManagedSetIntervalCalls(code)).toHaveLength(0);
  });

  it('STILL flags a real unclassified call sitting next to a string that mentions the token', () => {
    // The falsifiability control: stripping strings must not disarm the guard. If this
    // ever goes green the fix has silently turned the leg off, which is far worse than
    // the phantom it replaced.
    const code = [
      "const help = 'pass classification: to managedSetInterval (see D-004)';",
      "managedSetInterval('real', 1000, fn, { category: 'cache' });",
    ].join('\n');
    expect(hasUnclassifiedCall(code)).toBe(true);
  });

  it('finds a real call inside a ${} template expression (strings are emptied, code is not)', () => {
    const code = "const t = `${managedSetInterval('inTemplate', 1000, fn, { category: 'c' })}`;";
    expect(findManagedSetIntervalCalls(code)).toHaveLength(1);
    expect(hasUnclassifiedCall(code)).toBe(true);
  });

  it('a // inside a string does not swallow the rest of the line (one-pass scan)', () => {
    // Why the scan is ONE pass: strip-comments-then-strip-strings would treat the `//`
    // in this URL as a line comment and delete the real call that follows it.
    const code = [
      "const url = 'https://example.com/x';",
      "managedSetInterval('after-url', 1000, fn, { category: 'c' });",
    ].join('\n');
    expect(findManagedSetIntervalCalls(code)).toHaveLength(1);
  });
});
