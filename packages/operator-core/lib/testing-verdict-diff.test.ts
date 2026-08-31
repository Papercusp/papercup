/**
 * Guard tests for the gate-verdict diff core (plan `test-verdict-diff-2026-08-31`,
 * P-001 / P-004 / P-006).
 *
 * The controls here are deliberately WRONG implementations kept permanently in
 * the file, per the repo's falsifiability rule — the subject is a pure module we
 * import, so the tree is never mutated to prove these assertions can fail.
 */
import { describe, expect, it } from 'vitest';
import {
  boundBucket,
  classifyVerdict,
  diffVerdicts,
  failureSignature,
  groupBySignature,
  RED_STATUSES,
  type VerdictRow,
} from './testing-verdict-diff';

const row = (filePath: string, status: string, outputTail?: string): VerdictRow => ({
  filePath,
  status,
  outputTail,
});

describe('classifyVerdict (D-003 — a non-verdict is not a verdict)', () => {
  it('treats fail AND error as red', () => {
    expect(classifyVerdict('fail')).toBe('red');
    expect(classifyVerdict('error')).toBe('red');
    expect([...RED_STATUSES]).toEqual(['fail', 'error']);
  });

  it('treats only pass as green', () => {
    expect(classifyVerdict('pass')).toBe('green');
  });

  it('treats skip / cancelled / running as not-measured, never as an outcome', () => {
    for (const status of ['skip', 'cancelled', 'running']) {
      expect(classifyVerdict(status)).toBe('not-measured');
    }
  });

  /**
   * CALIBRATION for the guard below: the wrong-literal statuses that appear
   * throughout the corpus (`'passed'` / `'failed'`) are NOT in this vocabulary.
   * The dangerous direction is mapping an unknown status to `green`, which would
   * let a `status='failed'` style predicate read as a clean result — the exact
   * false negative this whole item exists to kill.
   */
  it('maps an UNRECOGNISED status to not-measured, never to green', () => {
    expect(classifyVerdict('failed')).toBe('not-measured');
    expect(classifyVerdict('passed')).toBe('not-measured');
    expect(classifyVerdict('')).toBe('not-measured');
    expect(classifyVerdict(null)).toBe('not-measured');
    expect(classifyVerdict(undefined)).toBe('not-measured');

    // The control: a classifier that defaulted to green would pass every
    // assertion above except this one.
    const naive = (status: string) => (status === 'fail' ? 'red' : 'green');
    expect(naive('failed')).toBe('green');
    expect(classifyVerdict('failed')).not.toBe(naive('failed'));
  });
});

describe('diffVerdicts — five buckets (D-002)', () => {
  const baseline = [
    row('a.test.ts', 'pass'),
    row('b.test.ts', 'fail'),
    row('c.test.ts', 'fail'),
    row('d.test.ts', 'pass'),
    row('gone.test.ts', 'pass'),
  ];
  const candidate = [
    row('a.test.ts', 'fail', 'AssertionError: expected 1 to be 2'),
    row('b.test.ts', 'pass'),
    row('c.test.ts', 'error'),
    row('d.test.ts', 'pass'),
    row('new.test.ts', 'fail'),
  ];

  it('separates newlyFailing / newlyPassing / stillFailing', () => {
    const diff = diffVerdicts({ baseline, candidate });
    expect(diff.newlyFailing.map((e) => e.filePath)).toEqual(['a.test.ts']);
    expect(diff.newlyPassing.map((e) => e.filePath)).toEqual(['b.test.ts']);
    expect(diff.stillFailing.map((e) => e.filePath)).toEqual(['c.test.ts']);
  });

  it('keeps presence-only files OUT of the transition buckets', () => {
    const diff = diffVerdicts({ baseline, candidate });
    // new.test.ts is RED in the candidate and absent from the baseline. Folding
    // it into newlyFailing would assert a transition that was never observed.
    expect(diff.onlyInCandidate.map((e) => e.filePath)).toEqual(['new.test.ts']);
    expect(diff.newlyFailing.map((e) => e.filePath)).not.toContain('new.test.ts');
    expect(diff.onlyInBaseline.map((e) => e.filePath)).toEqual(['gone.test.ts']);
  });

  it('counts both-passing files without listing them', () => {
    const diff = diffVerdicts({ baseline, candidate });
    expect(diff.unchangedPassing).toBe(1);
  });

  it('reports each side census and red totals', () => {
    const diff = diffVerdicts({ baseline, candidate });
    expect(diff.baselineFiles).toBe(5);
    expect(diff.candidateFiles).toBe(5);
    expect(diff.baselineRed).toBe(2);
    expect(diff.candidateRed).toBe(3);
    // The decomposition that is the whole point: the candidate's 3 red are
    // 1 newly-failing + 1 inherited + 1 never-run-before.
    expect(diff.newlyFailing.length + diff.stillFailing.length + diff.onlyInCandidate.length).toBe(3);
  });

  it('carries the status that produced each entry', () => {
    const diff = diffVerdicts({ baseline, candidate });
    expect(diff.newlyFailing[0]).toMatchObject({ baselineStatus: 'pass', candidateStatus: 'fail' });
    expect(diff.onlyInCandidate[0]).toMatchObject({ baselineStatus: null, candidateStatus: 'fail' });
    expect(diff.onlyInBaseline[0]).toMatchObject({ baselineStatus: 'pass', candidateStatus: null });
  });
});

describe('P-004 guard — a non-verdict transition never renders as a verdict change', () => {
  it('pass -> skip is notMeasured, not newlyPassing and not newlyFailing', () => {
    const diff = diffVerdicts({
      baseline: [row('x.test.ts', 'pass')],
      candidate: [row('x.test.ts', 'skip')],
    });
    expect(diff.notMeasured.map((e) => e.filePath)).toEqual(['x.test.ts']);
    expect(diff.newlyFailing).toEqual([]);
    expect(diff.newlyPassing).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
    expect(diff.unchangedPassing).toBe(0);
  });

  it('fail -> cancelled is notMeasured, NOT newlyPassing', () => {
    const diff = diffVerdicts({
      baseline: [row('x.test.ts', 'fail')],
      candidate: [row('x.test.ts', 'cancelled')],
    });
    expect(diff.notMeasured.map((e) => e.filePath)).toEqual(['x.test.ts']);
    expect(diff.newlyPassing).toEqual([]);
  });

  it('skip -> fail is notMeasured, NOT newlyFailing', () => {
    const diff = diffVerdicts({
      baseline: [row('x.test.ts', 'skip')],
      candidate: [row('x.test.ts', 'fail')],
    });
    expect(diff.notMeasured.map((e) => e.filePath)).toEqual(['x.test.ts']);
    expect(diff.newlyFailing).toEqual([]);
  });

  it('a WRONG-LITERAL status cannot silently land in a clean bucket', () => {
    // If `'failed'` were classified green, this file would read as an ordinary
    // unchanged pass — a red rendered as clean, invisibly.
    const diff = diffVerdicts({
      baseline: [row('x.test.ts', 'pass')],
      candidate: [row('x.test.ts', 'failed')],
    });
    expect(diff.unchangedPassing).toBe(0);
    expect(diff.newlyPassing).toEqual([]);
    expect(diff.notMeasured.map((e) => e.filePath)).toEqual(['x.test.ts']);
    expect(diff.candidateRed).toBe(0); // it is not counted as red either — it is unknown
  });
});

describe('duplicate rows', () => {
  it('takes the FIRST row per file and reports how many it ignored', () => {
    const diff = diffVerdicts({
      baseline: [row('x.test.ts', 'pass')],
      candidate: [row('x.test.ts', 'fail'), row('x.test.ts', 'pass')],
    });
    expect(diff.newlyFailing.map((e) => e.filePath)).toEqual(['x.test.ts']);
    expect(diff.duplicateRowsIgnored).toBe(1);
  });
});

describe('failureSignature (P-006 / D-005)', () => {
  it('strips real ANSI control sequences before matching', () => {
    // A genuine ESC byte, exactly as vitest writes it into output_tail.
    const colored = '\x1b[31mAssertionError\x1b[0m: expected 1 to be 2';
    expect(colored).toContain(String.fromCharCode(27)); // the fixture is really ANSI
    const signature = failureSignature(colored);
    expect(signature).not.toBeNull();
    expect(signature).not.toContain(String.fromCharCode(27));
    expect(signature).toContain('AssertionError');
  });

  it('normalises per-file noise so related reds share a signature', () => {
    const a = failureSignature('AssertionError: /repo/pkg/a.test.ts:12:4 expected 1 to be 2');
    const b = failureSignature('AssertionError: /repo/pkg/b.test.ts:99:1 expected 7 to be 8');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('does NOT collapse genuinely different failures', () => {
    const a = failureSignature('AssertionError: expected 1 to be 2');
    const b = failureSignature('TypeError: cannot read properties of undefined');
    expect(a).not.toBe(b);
  });

  it('returns null rather than inventing a shared empty signature', () => {
    expect(failureSignature(null)).toBeNull();
    expect(failureSignature(undefined)).toBeNull();
    expect(failureSignature('')).toBeNull();
    expect(failureSignature('   \n  \n')).toBeNull();
  });
});

describe('groupBySignature + ordering', () => {
  it('clusters by signature, largest first, and omits unsignatured entries', () => {
    const diff = diffVerdicts({
      baseline: [row('a.test.ts', 'pass'), row('b.test.ts', 'pass'), row('c.test.ts', 'pass')],
      candidate: [
        row('a.test.ts', 'fail', 'AssertionError: expected 1 to be 2'),
        row('b.test.ts', 'fail', 'AssertionError: expected 5 to be 6'),
        row('c.test.ts', 'fail'), // no output tail -> no signature
      ],
    });
    const clusters = groupBySignature(diff.newlyFailing);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(2);
    expect(clusters[0]!.files.sort()).toEqual(['a.test.ts', 'b.test.ts']);

    // Secondary ordering: the clustered pair sorts ahead of the unsignatured one.
    expect(diff.newlyFailing.map((e) => e.filePath)).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  });
});

describe('boundBucket (P-003 — a capped list never reads as a total)', () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({
    filePath: `f${i}.test.ts`,
    baselineStatus: 'pass',
    candidateStatus: 'fail',
  }));

  it('reports the CENSUS count while capping the returned list', () => {
    const bucket = boundBucket(entries, 3);
    expect(bucket.count).toBe(7); // the aggregate is NOT bounded by the limit
    expect(bucket.files).toHaveLength(3);
    expect(bucket.truncatedByLimit).toBe(true);
    expect(bucket.omitted).toBe(4);
  });

  it('says so explicitly when nothing was truncated', () => {
    const bucket = boundBucket(entries, 50);
    expect(bucket.count).toBe(7);
    expect(bucket.files).toHaveLength(7);
    expect(bucket.truncatedByLimit).toBe(false);
    expect(bucket.omitted).toBe(0);
  });

  it('an empty bucket is a real zero, not a truncation artifact', () => {
    const bucket = boundBucket([], 3);
    expect(bucket.count).toBe(0);
    expect(bucket.truncatedByLimit).toBe(false);
  });
});
