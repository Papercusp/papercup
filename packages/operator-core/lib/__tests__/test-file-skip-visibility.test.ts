/**
 * EI-19380376466745152 — a SKIPPED assertion is an absent measurement wearing a pass.
 *
 * The incident these pin: an agent fixed a regression, ran the owning file, read
 * `Tests  8 passed | 1 skipped (9)` with exit 0, and filed it as proof. A peer had landed
 * `it.skip` on THE EXACT assertion being fixed six minutes earlier, so the fix was never
 * exercised by the evidence cited for it. Every signal in that run read as success.
 *
 * The countermeasure has three parts, and the middle one is load-bearing: a COUNT alone would not
 * have helped — the agent already had the count. What was missing was the skipped test's NAME,
 * which vitest's human reporter never prints.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateGroupResults,
  assertionOutcomesFromReport,
  callerChoseReporting,
  parseCli,
  requireRanFrom,
  requireRanVerdict,
  testsSkippedFrom,
  withInjectedJsonReport,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — untyped .mjs router, imported by path like its sibling suites
} from '../../../../scripts/test-files.mjs';

describe('testsSkippedFrom — three-state, because an unreadable row must not read as "nothing skipped"', () => {
  it('reads the skipped segment of a mixed summary row', () => {
    expect(testsSkippedFrom('      Tests  4 passed | 1 skipped (5)')).toBe(1);
  });

  it('counts todo as not-executed too — collected, deliberately not run', () => {
    expect(testsSkippedFrom('      Tests  1 passed | 2 todo (3)')).toBe(2);
  });

  it('sums several not-executed segments', () => {
    expect(testsSkippedFrom('      Tests  1 passed | 2 skipped | 3 todo (6)')).toBe(5);
  });

  it('reports a MEASURED zero for an all-green row', () => {
    // Load-bearing: vitest omits a zero-valued segment rather than printing `0 skipped`. If this
    // returned null the field would read `unknown` on every ordinary green run, and a warning
    // that fires constantly is a warning nobody reads.
    expect(testsSkippedFrom('      Tests  8 passed (8)')).toBe(0);
  });

  it('returns null — not 0 — when there is no summary row at all', () => {
    expect(testsSkippedFrom('some unrelated output')).toBeNull();
  });

  it('strips ANSI first, because vitest colourises this row', () => {
    // EI-18819483316574031 is this same file's previous instance of exactly this trap: a matcher
    // that skipped the strip passed every hand-written test and never once fired on real output.
    const ESC = '\x1b';
    const coloured =
      `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m4 passed${ESC}[39m${ESC}[22m` +
      ` | ${ESC}[33m1 skipped${ESC}[39m (5)`;
    // The fixture is only meaningful if it genuinely carries the control byte: a '\\x1b' typo
    // would make this whole case vacuous while staying green.
    expect(coloured.includes(ESC)).toBe(true);
    expect(ESC.charCodeAt(0)).toBe(27);
    expect(testsSkippedFrom(coloured)).toBe(1);
  });

  it('reads the LAST summary row, so appended output cannot resurrect a superseded one', () => {
    expect(testsSkippedFrom('      Tests  9 skipped (9)\n...\n      Tests  4 passed | 1 skipped (5)')).toBe(1);
  });

  it('treats "no tests" as a measured zero', () => {
    expect(testsSkippedFrom('      Tests  no tests')).toBe(0);
  });
});

describe('assertionOutcomesFromReport — the NAMES, which exist nowhere else', () => {
  const withReport = (body: unknown, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-visibility-'));
    try {
      const path = join(dir, 'report.json');
      writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const report = {
    testResults: [
      {
        name: '/repo/lib/voice-prefs.test.ts',
        assertionResults: [
          { status: 'passed', fullName: 'voice defaults keeps PTT as the default' },
          { status: 'failed', fullName: 'voice defaults ships channel-voice defaults' },
          { status: 'skipped', fullName: 'voice-prefs (PG-backed) migrated to PG' },
          { status: 'todo', fullName: 'voice-prefs writes a preference' },
        ],
      },
    ],
  };

  it('splits executed (passed+failed) from collected-but-not-run, keeping full names', () => {
    withReport(report, (path) => {
      const outcomes = assertionOutcomesFromReport(path, '/repo');
      expect(outcomes?.executed).toEqual([
        'voice defaults keeps PTT as the default',
        'voice defaults ships channel-voice defaults',
      ]);
      expect(outcomes?.skipped.map((s: { name: string }) => s.name)).toEqual([
        'voice-prefs (PG-backed) migrated to PG',
        'voice-prefs writes a preference',
      ]);
      expect(outcomes?.skipped[0].file).toBe('/repo/lib/voice-prefs.test.ts');
    });
  });

  it('returns null — never an empty result — for an unreadable report', () => {
    // The distinction IS the guard: null degrades to "names unavailable", while an empty result
    // would render as the reassuring, wrong "nothing was skipped".
    expect(assertionOutcomesFromReport(null, '/repo')).toBeNull();
    expect(assertionOutcomesFromReport('/nope/missing.json', '/repo')).toBeNull();
    withReport('{ not json', (path) => expect(assertionOutcomesFromReport(path, '/repo')).toBeNull());
    withReport({ numTotalTests: 3 }, (path) => expect(assertionOutcomesFromReport(path, '/repo')).toBeNull());
  });
});

describe('withInjectedJsonReport — a private report, without stealing stdout from a human', () => {
  it('adds a json reporter ALONGSIDE the default one', () => {
    // Verified against vitest 4.1.8 before this was written: `--reporter=default --reporter=json
    // --outputFile=<p>` keeps the human `Tests` row on stdout AND writes the report. Dropping
    // `--reporter=default` would replace stdout with JSON and break every human caller — which is
    // why this asserts its presence rather than just the outputFile.
    const { args, injectedReportPath } = withInjectedJsonReport(['--silent'], '/tmp/r.json');
    expect(args).toEqual(['--silent', '--reporter=default', '--reporter=json', '--outputFile=/tmp/r.json']);
    expect(injectedReportPath).toBe('/tmp/r.json');
  });

  it('leaves a caller that chose its own reporter completely alone', () => {
    // testing:run always passes --reporter=json and its whole contract is that stdout IS the
    // report. Injecting there would rewrite output somebody is parsing.
    const chosenSets = [
      ['--reporter=json'],
      ['--reporter', 'json'],
      ['--outputFile=/x.json'],
      ['--outputFile', '/x.json'],
    ];
    for (const chosen of chosenSets) {
      expect(callerChoseReporting(chosen)).toBe(true);
      const { args, injectedReportPath } = withInjectedJsonReport(chosen, '/tmp/r.json');
      expect(args).toEqual(chosen);
      expect(injectedReportPath).toBeNull();
    }
  });

  it('is a no-op when no report path could be created — diagnostics never fail a real run', () => {
    const { args, injectedReportPath } = withInjectedJsonReport(['--silent'], null);
    expect(args).toEqual(['--silent']);
    expect(injectedReportPath).toBeNull();
  });
});

describe('--require-ran — turning "did my fix get exercised?" into a checked postcondition', () => {
  const outcomes = {
    executed: ['pays for the answer ONCE, not on all thirteen calls'],
    skipped: [{ name: 'voice-prefs (PG-backed) migrated to PG', file: '/repo/a.test.ts' }],
  };

  it('parses the =-form and lets the last one win', () => {
    expect(requireRanFrom(['--require-ran=alpha', 'file.test.ts', '--require-ran=beta'])).toBe('beta');
    expect(requireRanFrom(['--require-ran=', 'file.test.ts'])).toBeNull();
    expect(requireRanFrom(['file.test.ts'])).toBeNull();
  });

  it('does not swallow the file list — the option must not read as the first vitest arg', () => {
    // parseCli stops collecting its own args at the first `-`-prefixed token. A new own-option
    // that is not exempted there silently forwards every FILE after it to vitest as argv.
    const parsed = parseCli(['--require-ran=keeps PTT', 'lib/voice-prefs.test.ts']);
    expect(parsed.files).toEqual(['lib/voice-prefs.test.ts']);
    expect(parsed.requireRan).toBe('keeps PTT');
    expect(parsed.vitestArgs).toEqual([]);
  });

  it('still separates real vitest args, and composes with --dry', () => {
    const parsed = parseCli(['--dry', '--require-ran=x', 'lib/a.test.ts', '-t', 'pattern']);
    expect(parsed.files).toEqual(['lib/a.test.ts']);
    expect(parsed.dry).toBe(true);
    expect(parsed.requireRan).toBe('x');
    // parseCli normalises `-t pattern` to the joined form (WI-39830), so assert THAT — asserting
    // the bare word would pass on the un-normalised shape too and pin nothing.
    expect(parsed.vitestArgs).toEqual(['--testNamePattern=pattern']);
  });

  it('passes only when the named assertion actually EXECUTED', () => {
    expect(requireRanVerdict('pays for the answer ONCE', outcomes)).toMatchObject({ status: 'ran' });
  });

  it('catches the incident: the named assertion exists but was skipped', () => {
    const verdict = requireRanVerdict('migrated to PG', outcomes);
    expect(verdict.status).toBe('skipped');
    expect(verdict.matches).toEqual(['voice-prefs (PG-backed) migrated to PG']);
  });

  it('distinguishes absent from skipped — a typo or rename is a different repair', () => {
    expect(requireRanVerdict('no-such-name', outcomes)).toMatchObject({ status: 'absent' });
  });

  it('reports UNVERIFIED, never a pass, when there is no readable report', () => {
    // The whole point is that an unanswered question must not read as a "yes".
    expect(requireRanVerdict('anything', null)).toMatchObject({ status: 'unverified' });
  });

  it('is inert when not requested', () => {
    expect(requireRanVerdict(null, outcomes)).toMatchObject({ status: 'not-requested' });
  });
});

describe('aggregateGroupResults — skipped counts aggregate three-state, like executed ones', () => {
  const group = (over: Record<string, unknown> = {}) => ({
    requested: 1,
    matched: 1,
    executed: 1,
    unmatchedCount: 0,
    failed: false,
    launchError: false,
    ...over,
  });

  it('sums measured counts and concatenates names across groups', () => {
    const summary = aggregateGroupResults([
      group({ testsSkipped: 1, skippedNames: [{ name: 'a', file: 'f1' }], executedNames: ['x'] }),
      group({ testsSkipped: 2, skippedNames: [{ name: 'b', file: 'f2' }], executedNames: ['y'] }),
    ]);
    expect(summary.testsSkipped).toBe(3);
    expect(summary.skippedUnmeasuredGroups).toBe(0);
    expect(summary.skippedNames.map((s: { name: string }) => s.name)).toEqual(['a', 'b']);
    expect(summary.executedNames).toEqual(['x', 'y']);
  });

  it('counts a group that never measured as UNMEASURED, not as a clean zero', () => {
    // A launch error or zero-match group contributes no count. Folding that into 0 would report
    // `skippedTests=0` for a run that never looked — the exact false reassurance this closes.
    const summary = aggregateGroupResults([group({ testsSkipped: 2 }), group({ launchError: true })]);
    expect(summary.testsSkipped).toBe(2);
    expect(summary.skippedUnmeasuredGroups).toBe(1);
  });

  it('reports null when NO group measured a skip count', () => {
    const summary = aggregateGroupResults([group({ testsSkipped: null })]);
    expect(summary.testsSkipped).toBeNull();
    expect(summary.skippedUnmeasuredGroups).toBe(1);
  });
});
