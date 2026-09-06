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
    // P-004 (gate-latency-selection-and-retry-policy-2026-09-06): retries no longer run in a
    // serial per-workspace loop — every retry goes through ONE runBudgetedTasks pool and its
    // leg is recorded INSIDE the pool's runTask (`context.t`, `value`), still one leg per retry.
    expect(AFFECTED_TESTS_SRC).toContain('recordLeg(context.t, value.__elapsedMs)');
  });

  it('emits the phase block from the shared helper', () => {
    expect(AFFECTED_TESTS_SRC).toContain("from './lib/serial-phase.mjs'");
    // P-005 widened the call to pass the measured phase wall, so this pins the CALL and its leg
    // argument rather than an exact argument list — the previous literal
    // `formatSerialPhaseSummary(taskLegs)` broke on that addition while nothing was actually
    // wrong, which is a guard failing for a change it was never meant to police.
    expect(AFFECTED_TESTS_SRC).toMatch(/formatSerialPhaseSummary\(\s*taskLegs\b/);
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

/**
 * P-005: `ceilingX` is a BOUND — what perfect overlap COULD buy. It cannot say what the scheduler
 * ACTUALLY got, and the gap between the two is the whole question when deciding whether a gate run
 * is short of concurrency or short of nothing. D-032 forbids raising the fork cap; the honest way
 * to keep that ruling off inference is to MEASURE achieved overlap rather than reconstruct it.
 *
 * It cannot be reconstructed after the fact. AFFECTED_TASK_PROGRESS lines carry no timestamps; the
 * gate log is not written in chronological order (per-leg captured output is flushed when a leg
 * ends, so the phase summary can appear ABOVE the first leg's start line); and
 * harness_shared.test_runs stamps commit_sha on only a fraction of gate rows — the 2026-08-30
 * 04:44Z run attributed 221 file-runs that way, against 127 legs and 5309s of task work. So the
 * phase measures its own wall or the number does not exist.
 *
 * Paired assertions, the same discipline as the ceiling above: every test proving the measurement
 * is REPORTED is paired with one proving an ABSENT measurement stays absent. A missing wall
 * rendering as `wallMs=0 achievedX=0.00` would be a non-measurement dressed as a real one, and
 * indistinguishable from a phase that genuinely took no time.
 */
describe('achieved overlap (P-005)', () => {
  // 150s of work whose longest single leg is 120s: ceiling 1.25x. Every wall below is >= 120s,
  // because a phase cannot finish faster than its longest leg — a smaller wall would be
  // physically impossible input, and asserting on it would pin nonsense.
  const legs = [
    { name: '@papercusp/web :: test', ms: 120_000 },
    { name: '@papercusp/operator-core :: test', ms: 30_000 },
  ];

  it('reports wall and achieved overlap on the marker when the phase measured them', () => {
    const marker = formatSerialPhaseMarker(summarizeSerialPhase(legs, { wallMs: 130_000 })!);
    expect(marker).toContain('wallMs=130000');
    // 150s of work in 130s of wall = 1.15x achieved, under the 1.25x ceiling.
    expect(marker).toContain('achievedX=1.15');
    expect(marker).toContain('ceilingX=1.25');
    expect(marker.split('\n')).toHaveLength(1);
  });

  it('leaves the marker byte-identical to its pre-P-005 shape when the wall is unmeasured', () => {
    expect(formatSerialPhaseMarker(summarizeSerialPhase(legs)!)).toBe(
      'AFFECTED_TESTS_PHASE legs=2 serialMs=150000 longestMs=120000 ceilingX=1.25',
    );
  });

  it('treats a zero, negative, NaN, Infinite or non-numeric wall as UNMEASURED, never 0.00x', () => {
    const badWalls: unknown[] = [0, -1, NaN, Infinity, '130000', null, undefined];
    for (const wallMs of badWalls) {
      const summary = summarizeSerialPhase(legs, { wallMs } as { wallMs?: number })!;
      expect(summary.wallMs).toBeUndefined();
      expect(summary.achievedX).toBeUndefined();
      const marker = formatSerialPhaseMarker(summary);
      expect(marker).not.toContain('wallMs=');
      expect(marker).not.toContain('achievedX=');
    }
  });

  it('states achieved overlap and the remaining headroom in the human block', () => {
    const text = formatSerialPhaseSummary(legs, { wallMs: 150_000 }).join('\n');
    // 150s of work in 150s of wall: no overlap achieved at all.
    expect(text).toContain('achievedX=1.00');
    expect(text).toContain('MEASURED overlap');
    expect(text).toContain('phase wall');
    // 150s wall against a 120s longest leg = 30.0s perfect overlap could still remove.
    expect(text).toContain('30.0s of wall beyond the longest leg');
  });

  it('reports ZERO headroom when the phase is already bounded by its longest leg', () => {
    const text = formatSerialPhaseSummary(legs, { wallMs: 120_000 }).join('\n');
    expect(text).toContain('0.0s of wall beyond the longest leg');
    // Achieved then EQUALS the ceiling: nothing is left for more concurrency to buy, which is the
    // measured form of D-032's ruling rather than the reconciled one.
    const summary = summarizeSerialPhase(legs, { wallMs: 120_000 })!;
    expect(summary.achievedX).toBeCloseTo(summary.ceilingX, 10);
  });

  it('derives the phase wall in affected-tests.mjs from the legs, not a dispatch timestamp', () => {
    // Derived from the legs themselves (a leg's end is now, its start is now minus its measured
    // duration), so no dispatch-boundary timestamp has to be found and kept correct.
    expect(AFFECTED_TESTS_SRC).toContain('phaseFirstStartMs');
    expect(AFFECTED_TESTS_SRC).toContain('phaseLastEndMs');
    expect(AFFECTED_TESTS_SRC).toMatch(/wallMs:\s*\n?\s*phaseFirstStartMs/);
  });
});
