/**
 * EI-20057167830211785 — a backgrounded tsc that DIED must never read as clean.
 *
 * The controls are the point, not the ceremony. This guard is satisfied by an
 * empty input set in BOTH directions: a population test that matches nothing
 * makes every "no verdict" vacuous, and a death test that never fires makes the
 * whole module decorative. So each half carries a control that would catch it
 * being permanently silent, and the population test is pinned to the LITERAL
 * command `capability:inspect` builds — a detector armed for a population that
 * excludes its own caller is the failure mode this file exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import {
  backgroundTypecheckVerdict,
  countTscDiagnostics,
  isTypecheckCommand,
  typecheckHeapLaunchWarning,
} from './background-typecheck-verdict';
import { TSC_HEAP_MB } from '../tsc-heap';

/** The verbatim shape of the measured failure (EI-20057167830211785 repro). */
const OOM_LOG = `
<--- Last few GCs --->
[1496354:0x7f8] 124051 ms: Mark-compact 4070.2 (4093.1) -> 4068.3 (4086.9) MB, 1200.1 / 0.0 ms

<--- JS stacktrace --->

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
 1: 0xb8a3d0 node::Abort() [node]
 2: 0xaa07e9 node::FatalError(char const*, char const*) [node]
Aborted (core dumped)
`;

/** A real failing compile: non-zero exit, but it SAID something. */
const REAL_ERRORS_LOG = [
  'apps/operator/x.ts(89,41): error TS2322: Type A is not assignable to type B.',
  'apps/operator/y.ts(12,3): error TS2554: Expected 1 arguments, but got 2.',
  '',
  'Found 2 errors in 2 files.',
].join('\n');

describe('isTypecheckCommand — the population', () => {
  it('CALIBRATION: matches the literal command capability:inspect builds for a typecheck', () => {
    // inspect.ts: `return { ok: true, command: 'npx tsc --noEmit', cwd }`.
    // If this ever goes false, the verdict below is armed for nobody.
    expect(isTypecheckCommand('npx tsc --noEmit')).toBe(true);
  });

  it.each([
    ['bare binary', 'tsc --noEmit -p apps/operator/tsconfig.json'],
    ['env-prefixed', 'NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit'],
    ['runner flags', 'npx --yes tsc --noEmit'],
    ['explicit bin path', './node_modules/.bin/tsc --noEmit'],
    ['after a cd', 'cd packages/operator-core && npx tsc --noEmit'],
    ['env(1) prefix', 'env NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit'],
    // The wrapper shapes callers in THIS repo actually type. `job.command` is
    // stored raw, so if these did not resolve the detector would be armed for a
    // narrower population than the one that hits the bug.
    ['queued behind pc-heavy', 'bash scripts/pc-heavy.sh npx tsc --noEmit -p apps/operator/tsconfig.json'],
    ['a measured run', '/usr/bin/time -v env NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit'],
    ['quoted through bash -c', `bash -c 'npx tsc --noEmit'`],
  ])('matches a real invocation: %s', (_label, command) => {
    expect(isTypecheckCommand(command)).toBe(true);
  });

  it.each([
    // The false-alarm case: an ordinary grep that finds nothing exits 1 with no
    // `error TS` lines, which is byte-identical to a dead compile from the
    // verdict's point of view. A substring test would announce it as one.
    ['grep for the word', 'grep tsc /tmp/build.log'],
    ['a filename, not the binary', 'cat tsc.log'],
    ['a differently-named binary', 'node scripts/lib/tsc-baseline-gate.mjs'],
    // Excluded ON PURPOSE — an npm script wraps tsc in a reporter whose output
    // format this module does not own, so zero parsed diagnostics there means
    // "unreadable", not "died".
    ['an npm script wrapping tsc', 'npm run lint:tsc -- --files=a.ts'],
    ['a test run', 'npx vitest run packages/operator-core'],
    // Walking PAST a wrapper must not mean trusting its arguments: `tsc` here is
    // an operand of another script, not the program being run.
    ['tsc as another script\'s argument', 'bash scripts/report.sh tsc'],
    ['a quoted grep inside bash -c', `bash -c "grep tsc /tmp/build.log"`],
  ])('does NOT match: %s', (_label, command) => {
    expect(isTypecheckCommand(command)).toBe(false);
  });
});

describe('countTscDiagnostics', () => {
  it('counts real diagnostics and finds none in a crash dump', () => {
    expect(countTscDiagnostics(REAL_ERRORS_LOG)).toBe(2);
    // The whole bug in one assertion: the crash log contains ZERO error tokens.
    expect(countTscDiagnostics(OOM_LOG)).toBe(0);
  });
});

describe('backgroundTypecheckVerdict', () => {
  const job = (over: Partial<Parameters<typeof backgroundTypecheckVerdict>[0]>) => ({
    command: 'npx tsc --noEmit',
    status: 'failed',
    exitCode: 134,
    log: OOM_LOG,
    ...over,
  });

  it('FIRES on the measured OOM: exit 134, zero diagnostics', () => {
    const v = backgroundTypecheckVerdict(job({}));
    expect(v?.reason).toBe('typecheck_died_out_of_memory');
    expect(v?.headline).toContain('MEASURED NOTHING');
  });

  it('FIRES on an OOM whose exit code is not 134, from the log signature alone', () => {
    expect(backgroundTypecheckVerdict(job({ exitCode: 1 }))?.reason).toBe('typecheck_died_out_of_memory');
  });

  it('FIRES on a timeout that emitted no diagnostics', () => {
    const v = backgroundTypecheckVerdict(job({ status: 'timed_out', exitCode: null, log: '' }));
    expect(v?.reason).toBe('typecheck_timed_out_without_diagnostics');
  });

  it('FIRES on any other silent non-zero exit (a bad --project operand)', () => {
    const v = backgroundTypecheckVerdict(job({ exitCode: 2, log: 'error: bad operand\n' }));
    expect(v?.reason).toBe('typecheck_died_without_diagnostics');
  });

  it('CONTROL: silent on a clean run', () => {
    expect(backgroundTypecheckVerdict(job({ status: 'completed', exitCode: 0, log: '' }))).toBeNull();
  });

  it('CONTROL: silent on a REAL failing compile — non-zero, but it emitted diagnostics', () => {
    expect(backgroundTypecheckVerdict(job({ exitCode: 2, log: REAL_ERRORS_LOG }))).toBeNull();
  });

  it('CONTROL: silent while the job is still running — "not finished" is not "measured nothing"', () => {
    expect(backgroundTypecheckVerdict(job({ status: 'running', exitCode: null, log: '' }))).toBeNull();
  });

  it('CONTROL: silent for a non-typecheck command that died the same way', () => {
    // Same exit code, same dump — a vitest run that OOMs is a real event, but it
    // is not this verdict's to report, and claiming it would be a false alarm.
    expect(backgroundTypecheckVerdict(job({ command: 'npx vitest run' }))).toBeNull();
  });
});

describe('typecheckHeapLaunchWarning — EI-20063051138162607', () => {
  /** No ambient pin, so the command is the only thing under test. */
  const NO_AMBIENT = '';

  it('warns on an unpinned tsc command, naming the pin the caller would need', () => {
    const warning = typecheckHeapLaunchWarning('npx tsc --noEmit -p apps/operator/tsconfig.json', NO_AMBIENT);
    expect(warning).toBeTruthy();
    expect(warning).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
  });

  it('names the SILENT-SHAPED failure, not just the heap — a grep would read the death as clean', () => {
    // The whole reason this is said at LAUNCH: the caller's next move after a
    // dead compile is to grep for `error TS`, which reports zero either way.
    const warning = typecheckHeapLaunchWarning('npx tsc --noEmit', NO_AMBIENT);
    expect(warning).toContain('error TS');
  });

  it('warns about an UNDER-pin and states the actual number (the WI-37450 shape)', () => {
    // Deferring to a pin below what the compile needs is the dangerous case:
    // withTscHeap RAISES it, but a hand-rolled command gets no such correction.
    const warning = typecheckHeapLaunchWarning(
      'NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit -p apps/operator/tsconfig.json',
      NO_AMBIENT,
    );
    expect(warning).toBeTruthy();
    expect(warning).toContain('4096MB');
  });

  it('is SILENT when the command already carries an adequate pin', () => {
    expect(
      typecheckHeapLaunchWarning(
        `NODE_OPTIONS=--max-old-space-size=${TSC_HEAP_MB} npx tsc --noEmit`,
        NO_AMBIENT,
      ),
    ).toBeNull();
  });

  it('is SILENT when the pin comes from the ambient NODE_OPTIONS instead of the command', () => {
    // The child inherits the operator's env, so an ambient pin is a real pin —
    // warning here would be a false alarm about a correctly-configured run.
    expect(
      typecheckHeapLaunchWarning('npx tsc --noEmit', `--max-old-space-size=${TSC_HEAP_MB}`),
    ).toBeNull();
  });

  it('CONTROL: silent for a command that merely MENTIONS tsc', () => {
    // Inherits isTypecheckCommand's head-position rule. A false alarm is a bug
    // in the alarm, and an unconditional warning would be indistinguishable
    // from a working one on the only input that matters.
    expect(typecheckHeapLaunchWarning('grep tsc build.log', NO_AMBIENT)).toBeNull();
  });

  it('CONTROL: silent for an npm script wrapping tsc — that population owns its own heap', () => {
    expect(typecheckHeapLaunchWarning('npm run lint:tsc', NO_AMBIENT)).toBeNull();
  });
});
