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
import {
  findManagedSetIntervalCalls,
  hasUnclassifiedCall,
} from '../../../../scripts/check-timer-classification.mjs';

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
    expect(calls[0]).toContain("'nested'");
    expect(calls[0]).toContain('classification');
  });
});
