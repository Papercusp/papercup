/**
 * `scripts/lib/serial-phase.mjs` measures the SERIAL-EQUIVALENT task work performed by
 * `scripts/affected-tests.mjs`. D-021 introduced it while tasks were serial; P-002 now overlaps
 * them under a global budget, so the legacy `serialMs` field is a sum, not phase wall time.
 *
 * WHY THIS FILE EXISTS (the WI-37830 argument, same as affected-tests-load-suspect.test.ts):
 * in-process this arithmetic runs only during a real multi-workspace suite run — minutes long,
 * and needing a loaded box to be representative — so a wrong bound would not be caught by
 * running it. It would be caught by someone QUOTING it in a planning decision, which is the
 * expensive way to find out. That is exactly how the inherited "1.65 parallelism" figure this
 * measurement replaces survived unchallenged: nothing executed it, so nothing could contradict
 * it.
 *
 * The assertions are two-sided for a reason specific to this subject. `ceilingX` is an UPPER
 * BOUND on what parallelizing the phase could buy, and the naive misreading — "we will get
 * ceilingX faster" — is one careless edit away from justifying a fork-cap raise, which is the
 * one thing this plan's rails forbid outright (WI-3792/WI-5621: the box melted twice). So every
 * test proving the number is REPORTED is paired with one proving it stays a BOUND: never
 * exceeding the leg count, collapsing to 1.00 when there is nothing to parallelize, and never
 * escaping as Infinity/NaN from a degenerate run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  summarizeSerialPhase,
  formatSerialPhaseMarker,
  formatSerialPhaseSummary,
} from '../../../../scripts/lib/serial-phase.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Overridable so falsifiability can be proven against a COPY outside the tree
// (`scripts/mutation-probe.sh --file scripts/affected-tests.mjs`). Mutating the real file to
// prove a guard bites is unsafe here: git-sync sweeps the whole working tree on a schedule and
// can COMMIT the mutant even when nothing goes wrong and no restore handler fails.
// Resolved against REPO_ROOT so a RELATIVE override still works: vitest runs this file with cwd
// at the workspace (packages/operator-core), not the repo root, and `resolve` leaves an absolute
// override (the probe's scratch copy) untouched.
const AFFECTED_TESTS_PATH = resolve(
  REPO_ROOT,
  process.env.PROBE_AFFECTED_TESTS ?? 'scripts/affected-tests.mjs',
);
const AFFECTED_TESTS_SRC = readFileSync(AFFECTED_TESTS_PATH, 'utf8').replaceAll('"', "'");

describe('summarizeSerialPhase', () => {
  it('sums the legs and names the longest', () => {
    const s = summarizeSerialPhase([
      { name: 'a :: test', ms: 1000 },
      { name: 'b :: test', ms: 4000 },
      { name: 'c :: test', ms: 3000 },
    ])!;
    expect(s.legs).toBe(3);
    expect(s.serialMs).toBe(8000);
    expect(s.longestMs).toBe(4000);
    expect(s.longestName).toBe('b :: test');
    expect(s.ceilingX).toBeCloseTo(2, 5);
  });

  it('orders `slowest` slowest-first, so the top-N block names the real hot legs', () => {
    const s = summarizeSerialPhase([
      { name: 'quick', ms: 10 },
      { name: 'slow', ms: 900 },
      { name: 'medium', ms: 100 },
    ])!;
    expect(s.slowest.map((l) => l.name)).toEqual(['slow', 'medium', 'quick']);
  });

  // ── the BOUND half: every one of these is a way the number could overstate the lever ──

  it('is 1.00x for a single leg — serialization can buy nothing when there is nothing to overlap', () => {
    const s = summarizeSerialPhase([{ name: 'only', ms: 5000 }])!;
    expect(s.ceilingX).toBe(1);
  });

  it('never exceeds the leg count — that is the arithmetic ceiling of perfect overlap', () => {
    for (const legs of [
      [{ name: 'a', ms: 1 }, { name: 'b', ms: 1 }],
      [{ name: 'a', ms: 1 }, { name: 'b', ms: 1000 }],
      [{ name: 'a', ms: 7 }, { name: 'b', ms: 13 }, { name: 'c', ms: 2 }, { name: 'd', ms: 900 }],
    ]) {
      const s = summarizeSerialPhase(legs)!;
      expect(s.ceilingX).toBeLessThanOrEqual(legs.length);
      expect(s.ceilingX).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports 1.00x rather than Infinity/NaN when every leg measured 0ms', () => {
    const s = summarizeSerialPhase([
      { name: 'a', ms: 0 },
      { name: 'b', ms: 0 },
    ])!;
    expect(Number.isFinite(s.ceilingX)).toBe(true);
    expect(s.ceilingX).toBe(1);
  });

  it('one dominant leg pins the ceiling near 1.00 — a phase that is ONE slow suite is not a parallelism problem', () => {
    const s = summarizeSerialPhase([
      { name: 'dominant', ms: 600_000 },
      { name: 'trivial-a', ms: 500 },
      { name: 'trivial-b', ms: 500 },
    ])!;
    expect(s.ceilingX).toBeLessThan(1.01);
  });

  // ── the EMPTY half: a zeroed measurement must never look like a real one ──

  it('returns null for no legs, so a zero-task run emits nothing instead of a row of zeros', () => {
    expect(summarizeSerialPhase([])).toBeNull();
    expect(summarizeSerialPhase(undefined as never)).toBeNull();
  });

  it('returns null when every leg is malformed, rather than inventing a 0ms phase', () => {
    expect(
      summarizeSerialPhase([
        { name: 'bad', ms: Number.NaN },
        { name: 'worse', ms: -1 },
      ] as never),
    ).toBeNull();
  });
});

describe('the emitted block', () => {
  const legs = [
    { name: '@papercusp/operator-core :: test', ms: 120_000 },
    { name: '@papercusp/web :: test', ms: 30_000 },
  ];

  it('leads with a greppable single-line marker carrying every number', () => {
    const marker = formatSerialPhaseMarker(summarizeSerialPhase(legs)!);
    expect(marker).toBe(
      'AFFECTED_TESTS_PHASE legs=2 serialMs=150000 longestMs=120000 ceilingX=1.25',
    );
    expect(marker.split('\n')).toHaveLength(1);
  });

  it('emits nothing at all for an empty leg set', () => {
    expect(formatSerialPhaseSummary([])).toEqual([]);
  });

  it('renders the marker plus a human block, and honours topN', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `ws-${i}`, ms: (i + 1) * 1000 }));
    const lines = formatSerialPhaseSummary(many, { topN: 3 });
    expect(lines.filter((l) => l.startsWith('AFFECTED_TESTS_PHASE'))).toHaveLength(1);
    // 3 top-N rows, and they are the three slowest, slowest-first.
    const rows = lines.filter((l) => /^\s+\d/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('ws-8');
    expect(rows[2]).toContain('ws-6');
  });

  it('calls the number a ceiling in the text a human reads, not a speedup', () => {
    const text = formatSerialPhaseSummary(legs).join('\n');
    expect(text).toContain('serial-equivalent');
    expect(text).toContain('scheduler may overlap legs');
    expect(text).not.toContain('one at a time');
    expect(text).toContain('ideal overlap versus serial execution');
    expect(text).toContain('ceiling');
    // The misreading this guards against is "we will get 1.25x faster".
    expect(text).toMatch(/bound and not a forecast/);
    expect(text).not.toMatch(/speedup|will be faster|expect(ed)? gain/i);
  });
});

describe('wiring in affected-tests.mjs', () => {
  it('records every initial scheduler result and every post-pool retry as separate work', () => {
    expect(AFFECTED_TESTS_SRC).toContain(
      'recordLeg(scheduled.task.t, scheduled.value.__elapsedMs)',
    );
    expect(AFFECTED_TESTS_SRC).toContain('recordLeg(t, retry.value.__elapsedMs)');
  });

  it('emits the phase block from the shared helper', () => {
    expect(AFFECTED_TESTS_SRC).toContain("from './lib/serial-phase.mjs'");
    expect(AFFECTED_TESTS_SRC).toContain('formatSerialPhaseSummary(taskLegs)');
  });

  /**
   * The measurement must NOT ride the verdict line. `AFFECTED_TESTS_RESULT`'s shape is pinned by
   * affected-tests-result-line.test.ts and parsed by green-checkpoint; widening a VERDICT
   * contract to carry a MEASUREMENT is how measurements come to be read as verdicts — the same
   * reasoning that keeps the load-suspect marker on its own line.
   */
  it('keeps the phase numbers OFF the AFFECTED_TESTS_RESULT verdict line', () => {
    const resultLine = AFFECTED_TESTS_SRC.slice(
      AFFECTED_TESTS_SRC.indexOf('const resultLine = (status) =>'),
    ).split('\n')[1];
    expect(resultLine).toContain('AFFECTED_TESTS_RESULT');
    for (const field of ['serialMs', 'longestMs', 'ceilingX', 'legs=']) {
      expect(resultLine).not.toContain(field);
    }
  });
});
