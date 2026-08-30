/**
 * fake-timers-integration-guard.test.ts — the recurrence guard for EI-18697393226276295.
 *
 * The incident: `vi.useFakeTimers()` was added to an integration test whose code path
 * reached unmocked real infrastructure. Faking `setTimeout` stopped that infrastructure's
 * internal timers from ever firing, and the suite HUNG — no assertion failure, no error,
 * no timeout, no output. It had to be killed with `kill -9` on the process tree. A failure
 * with zero diagnostic signal cannot be debugged by reading output, because there is none;
 * it can only be prevented.
 *
 * WHAT IS ACTUALLY BEING ASSERTED HERE, and why the false-positive half carries as much
 * weight as the true-positive half: `scripts/check-fake-timers-in-integration-tests.mjs` is
 * wired into REPO_WIDE_INVARIANT_GUARDS, so ONE wrong finding red-pins the fleet gate for
 * every agent. The guard therefore has to draw a precise line, not a broad one —
 *
 *     faking the CLOCK    (Date/performance/hrtime)  is SAFE: real timers still fire
 *     faking the SCHEDULER (setTimeout, setInterval)  is the hang
 *
 * — and the tree contains a live, correct instance of the safe form that a naive
 * "no fake timers in integration tests" rule would wrongly red-line. That instance is the
 * calibration case below: if this guard ever flags it, the guard is wrong, not the file.
 *
 * EVERY FIXTURE IS SYNTHETIC STRING INPUT. The functions under test are pure, so proving
 * falsifiability needs no mutation of the shared tree at all — no copy-out, no sweep race,
 * no restore step that a killed process could skip. The deliberately-wrong inputs live here
 * permanently rather than existing for one probe run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

let classifyCall: (argText: string) => string | null;
let findUseFakeTimersCalls: (text: string) => { argText: string; line: number }[];
let maskCommentsAndStrings: (text: string) => string;

const HERE = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  // PROBE_SCRIPT points this suite at a mutated COPY outside the tree, so
  // scripts/mutation-probe.sh can prove the guard falsifiable without ever mutating the
  // shared working tree (git-sync would commit the mutant mid-probe).
  //
  // ⚠ EVERY binding asserted on below MUST come from this one dynamic import. A suite that
  // hardcodes the real path while the probe mutates a copy runs happily, reports "MUTANT
  // SURVIVED", and was measuring the REAL module the whole time.
  ({ classifyCall, findUseFakeTimersCalls, maskCommentsAndStrings } = await import(
    /* @vite-ignore */ process.env.PROBE_SCRIPT ||
      resolve(HERE, '../../../../scripts/check-fake-timers-in-integration-tests.mjs')
  ));
});

/** Classify a whole source snippet the way the guard does: any offending call wins. */
function reasonsFor(source: string): string[] {
  return findUseFakeTimersCalls(source)
    .map((c) => classifyCall(c.argText))
    .filter((r): r is string => r !== null);
}

describe('scheduler faking is caught (the hang)', () => {
  // Each of these fakes setTimeout and would strand real infra. If ANY of them stops
  // being reported, the guard has gone weaker than it looks and the hang can return.
  const HAZARDS: [string, string][] = [
    ['bare call — fakes the full default set', 'vi.useFakeTimers();'],
    ['options but no toFake', 'vi.useFakeTimers({ shouldAdvanceTime: true });'],
    ['explicit setTimeout', "vi.useFakeTimers({ toFake: ['setTimeout'] });"],
    ['setInterval alongside a safe entry', "vi.useFakeTimers({ toFake: ['Date', 'setInterval'] });"],
    ['nextTick', "vi.useFakeTimers({ toFake: ['nextTick'] });"],
    ['queueMicrotask', "vi.useFakeTimers({ toFake: ['queueMicrotask'] });"],
  ];

  for (const [label, source] of HAZARDS) {
    it(`flags: ${label}`, () => {
      expect(reasonsFor(source)).toHaveLength(1);
    });
  }

  it('reports WHICH entry is the scheduler, not just that something is wrong', () => {
    const [reason] = reasonsFor("vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });");
    expect(reason).toContain('setTimeout');
    expect(reason).not.toContain('Date');
  });
});

describe('fails closed on anything not statically provable', () => {
  // An unreadable toFake is reported rather than assumed safe. The cost of a wrong report
  // is one line of human review; the cost of a wrong pass is a silent infinite hang.
  const OPAQUE: [string, string][] = [
    ['spread from a variable', 'vi.useFakeTimers({ toFake: [...TIMERS] });'],
    ['a bare identifier instead of an array', 'vi.useFakeTimers({ toFake: someList });'],
    ['an empty list', 'vi.useFakeTimers({ toFake: [] });'],
    ['a non-literal entry', 'vi.useFakeTimers({ toFake: [TIMER_CONST] });'],
  ];

  for (const [label, source] of OPAQUE) {
    it(`flags: ${label}`, () => {
      expect(reasonsFor(source)).toHaveLength(1);
    });
  }

  it('an unrecognized fake name fails closed rather than being assumed harmless', () => {
    // The allowlist polarity: a fake vitest/sinon adds later must not slip through
    // silently just because this guard has never heard of it.
    expect(reasonsFor("vi.useFakeTimers({ toFake: ['someFutureTimerApi'] });")).toHaveLength(1);
  });
});

describe('clock-only faking stays silent (the false positives that would red-pin the gate)', () => {
  const SAFE = [
    "vi.useFakeTimers({ toFake: ['Date'] });",
    "vi.useFakeTimers({ toFake: ['Date', 'performance'] });",
    "vi.useFakeTimers({ toFake: ['hrtime'] });",
    'vi.useFakeTimers({\n  toFake: [\n    "Date",\n  ],\n});',
  ];

  for (const source of SAFE) {
    it(`silent on: ${source.replace(/\s+/g, ' ').slice(0, 60)}`, () => {
      expect(reasonsFor(source)).toEqual([]);
    });
  }
});

describe('prose and strings are not call sites', () => {
  // EI-19989853369726696's class: a call-shaped token quoted in prose was read as a real
  // call site and produced a phantom offender that red-pinned the gate. The sibling guards
  // solve it by emptying string contents — this guard cannot, because the evidence it must
  // read (toFake: ['Date']) lives inside a string. Hence the length-preserving mask.
  it('ignores a mention inside a line comment', () => {
    expect(findUseFakeTimersCalls('// never call vi.useFakeTimers() in here\n')).toHaveLength(0);
  });

  it('ignores a mention inside a block comment', () => {
    expect(findUseFakeTimersCalls('/* vi.useFakeTimers({ toFake: ["setTimeout"] }) */')).toHaveLength(0);
  });

  it('ignores a mention inside a string literal', () => {
    const src = 'const advice = "do not vi.useFakeTimers() in integration tests";';
    expect(findUseFakeTimersCalls(src)).toHaveLength(0);
  });

  it('a stray paren inside a string cannot unbalance the argument walk', () => {
    // The masked text is what the paren walk reads, so the ")" in the string below must
    // not terminate the call early and truncate toFake out of the argument text.
    const src = "vi.useFakeTimers({ label: 'oops )', toFake: ['setTimeout'] });";
    const calls = findUseFakeTimersCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0].argText).toContain('setTimeout');
    expect(classifyCall(calls[0].argText)).toContain('setTimeout');
  });

  it('still finds a real call that follows a prose mention', () => {
    // The dangerous direction: masking must not swallow real code after a comment.
    const src = ['// see vi.useFakeTimers() for why', 'vi.useFakeTimers();'].join('\n');
    expect(findUseFakeTimersCalls(src)).toHaveLength(1);
  });
});

describe('the mask preserves indices', () => {
  it('is length-preserving, which is what keeps argText readable', () => {
    // This is the whole reason argText can be sliced from the ORIGINAL using offsets found
    // in the MASKED text. If the mask ever starts removing characters instead of blanking
    // them, every reported line number and argument slice silently shifts.
    const src = "const a = 'hello'; // note\nvi.useFakeTimers({ toFake: ['Date'] });";
    expect(maskCommentsAndStrings(src)).toHaveLength(src.length);
  });

  it('keeps newlines so reported line numbers stay correct', () => {
    const src = "/* a\nb\nc */\nvi.useFakeTimers();";
    const calls = findUseFakeTimersCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0].line).toBe(4);
  });
});

describe('live calibration', () => {
  // The single real instance in the tree of the SAFE form. It is the calibration case: a
  // guard that flags this is wrong, and a naive "ban fake timers in integration tests"
  // rule WOULD flag it. Asserting the file's existence is deliberate — a control that can
  // silently vanish is not a control, so if this file is ever moved or deleted this test
  // fails loudly and whoever moved it re-points the calibration rather than losing it.
  const LIVE = resolve(
    HERE,
    '../sync/hyperbee/__tests__/cross-plan-federation-seam.integration.test.ts',
  );

  it('the calibration subject still exists', () => {
    expect(existsSync(LIVE)).toBe(true);
  });

  it('the guard is silent on real, correct production code', () => {
    const text = readFileSync(LIVE, 'utf8');
    const calls = findUseFakeTimersCalls(text);
    // Positive control: if this ever reads 0, the scan stopped seeing the call at all and
    // the silence below would be vacuous rather than earned.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => classifyCall(c.argText)).filter(Boolean)).toEqual([]);
  });
});
