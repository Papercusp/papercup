/**
 * RECURRENCE GUARD for the durable-file/in-process-resolve bug class
 * (EI-19339499404613652), and for the two ways a detector of it goes wrong.
 *
 * ## What this guard actually asserts — read before trusting its green
 *
 * It does NOT assert that any flagged row is genuinely orphaned. That is not
 * decidable from the ledger: silence past an emitter's resolve norm is equally
 * consistent with "the condition cleared and the resolve never ran" (the bug)
 * and with "this subject is no longer sampled" (the WI-7011 scope caveat). The
 * module's contract is the weaker, decidable one — classify each emitter
 * against its OWN close-time distribution and route the anomalies — and these
 * tests hold it to exactly that, no more.
 *
 * ## The controls, and why each exists
 *
 * Every case below is built from the distribution SHAPES actually measured on
 * the live ledger 2026-08-31, so a future reader can tell what the numbers
 * mean. Two of them are the point of the file:
 *
 *   - `spec-triad` (slow closer, old open rows) must NOT be flagged. A naive
 *     "older than N x cadence" rule reports 109 of its rows; they are work
 *     requests, not memory-gated resolve paths. This is the false positive the
 *     module was redesigned to avoid.
 *   - The SAME open-row ages under two different emitters must produce
 *     DIFFERENT verdicts. That is the discriminator: it proves the rule keys on
 *     the emitter's own behaviour and not on absolute age. If someone later
 *     "simplifies" this to an age threshold, that test is what fails.
 *
 * A deliberately-wrong classifier is kept permanently in the file as a
 * positive control, so the suite cannot pass merely because the property is
 * unfalsifiable — per the repo's falsifiability rules, which forbid proving
 * this by mutating the shared tree.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_CLOSE_SAMPLE,
  actionableFindings,
  percentileCont,
  scanDurableEscalations,
  type EscalationRow,
} from './durable-escalation-orphan-scan';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

/** `count` rows that were closed `closeHours` after they were filed. */
function closedRows(
  emitter: string,
  count: number,
  closeHours: number,
  prefix = 'c',
): EscalationRow[] {
  return Array.from({ length: count }, (_, i) => ({
    emitter,
    id: `${prefix}-${emitter}-${i}`,
    createdAtMs: NOW - 5000 * HOUR + i * HOUR,
    closedAtMs: NOW - 5000 * HOUR + i * HOUR + closeHours * HOUR,
  }));
}

/** `count` rows still open, each filed `ageHours` ago. */
function openRows(emitter: string, count: number, ageHours: number, prefix = 'o'): EscalationRow[] {
  return Array.from({ length: count }, (_, i) => ({
    emitter,
    id: `${prefix}-${emitter}-${i}`,
    createdAtMs: NOW - ageHours * HOUR,
    closedAtMs: null,
  }));
}

function findingFor(rows: EscalationRow[], emitter: string) {
  const report = scanDurableEscalations(rows, { nowMs: NOW });
  const found = report.findings.find((f) => f.emitter === emitter);
  if (!found) throw new Error(`no finding for ${emitter}`);
  return found;
}

describe('percentileCont', () => {
  it('interpolates linearly, matching Postgres percentile_cont', () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(percentileCont([0, 10], 0.95)).toBeCloseTo(9.5, 10);
    expect(percentileCont([7], 0.95)).toBe(7);
  });
});

describe('scanDurableEscalations', () => {
  it('POSITIVE CONTROL: flags the resource-governor shape — instant closes, old open rows', () => {
    // Measured 2026-08-31: 87,897 closes at p95 0.00h, 1,816 open at median 38.31h.
    const rows = [
      ...closedRows('system:resource-governor', 200, 0),
      ...openRows('system:resource-governor', 30, 38),
    ];
    const finding = findingFor(rows, 'system:resource-governor');

    expect(finding.verdict).toBe('orphan-suspect');
    expect(finding.p95CloseHours).toBeCloseTo(0, 10);
    // The floor is what keeps a p95 of 0 from flagging seconds-old rows.
    expect(finding.thresholdHours).toBe(1);
    expect(finding.anomalousOpen).toHaveLength(30);
  });

  it('DISCRIMINATOR: does NOT flag the spec-triad shape — slow closer, open rows inside its own norm', () => {
    // Measured: p95 close 336.02h, open median 325.15h. A pure age rule reports
    // these as orphans; they are work requests that clear when someone does them.
    const rows = [
      ...closedRows('system:spec-triad', 200, 120),
      ...openRows('system:spec-triad', 40, 325),
    ];
    const finding = findingFor(rows, 'system:spec-triad');

    expect(finding.verdict).toBe('within-own-norm');
    expect(finding.anomalousOpen).toEqual([]);
    // 325h open is far older than the resource-governor rows flagged above.
    expect(finding.openCount).toBe(40);
  });

  it('DISCRIMINATOR: identical open-row ages produce OPPOSITE verdicts under different emitters', () => {
    // The single test that fails if anyone reduces this to an age threshold.
    const AGE = 200;
    const rows = [
      ...closedRows('fast-closer', 200, 0.1, 'f'),
      ...openRows('fast-closer', 5, AGE, 'fo'),
      ...closedRows('slow-closer', 200, 300, 's'),
      ...openRows('slow-closer', 5, AGE, 'so'),
    ];
    const report = scanDurableEscalations(rows, { nowMs: NOW });

    const fast = report.findings.find((f) => f.emitter === 'fast-closer')!;
    const slow = report.findings.find((f) => f.emitter === 'slow-closer')!;

    expect(fast.verdict).toBe('orphan-suspect');
    expect(slow.verdict).toBe('within-own-norm');
    expect(fast.anomalousOpen).toHaveLength(5);
    expect(slow.anomalousOpen).toEqual([]);
  });

  it('reports an emitter that has NEVER closed a row as its own verdict, not as an orphan claim', () => {
    // Measured: system:p2p-perf (4 open, 0 closed), system:negative-space-mine (2 open, 0 closed).
    const finding = findingFor(openRows('system:p2p-perf', 4, 221), 'system:p2p-perf');

    expect(finding.verdict).toBe('no-resolve-path-observed');
    expect(finding.p95CloseHours).toBeNull();
    expect(finding.thresholdHours).toBeNull();
    expect(finding.anomalousOpen).toEqual([]);
  });

  it('VACUITY CONTROL: too few closes is UNDETERMINED — never within-own-norm', () => {
    // Measured: system:neologism-mine, 1 close / 8 open. The failure this guards
    // is a thin sample rendering as a confident clean verdict.
    const rows = [
      ...closedRows('system:neologism-mine', DEFAULT_MIN_CLOSE_SAMPLE - 1, 1),
      ...openRows('system:neologism-mine', 8, 703),
    ];
    const finding = findingFor(rows, 'system:neologism-mine');

    expect(finding.verdict).toBe('insufficient-close-sample');
    expect(finding.verdict).not.toBe('within-own-norm');
    expect(finding.p95CloseHours).toBeNull();
    // It must appear in the actionable list: undetermined is a thing to chase.
    expect(actionableFindings({ ...scanDurableEscalations(rows, { nowMs: NOW }) })).toHaveLength(1);
  });

  it('VACUITY CONTROL: an empty scan is distinguishable from a scan that found nothing', () => {
    const empty = scanDurableEscalations([], { nowMs: NOW });
    const clean = scanDurableEscalations(
      [...closedRows('quiet', 50, 1), ...openRows('quiet', 1, 0.5)],
      { nowMs: NOW },
    );

    expect(empty.findings).toEqual([]);
    expect(clean.findings.map((f) => f.verdict)).toEqual(['within-own-norm']);
    // Identical `findings` emptiness would be indistinguishable without these.
    expect(empty.rowsScanned).toBe(0);
    expect(empty.emittersScanned).toBe(0);
    expect(clean.rowsScanned).toBe(51);
    expect(clean.emittersScanned).toBe(1);
  });

  it('excludes closes recorded BEFORE their own creation instead of counting them as instant', () => {
    // The WI-1713046 shape: archive-served rows stamped closed ~1.9s before created.
    // Counting them as 0h closes would flatten the p95 and manufacture orphans.
    const incoherent: EscalationRow[] = Array.from({ length: 30 }, (_, i) => ({
      emitter: 'skewed',
      id: `bad-${i}`,
      createdAtMs: NOW - 100 * HOUR,
      closedAtMs: NOW - 100 * HOUR - 1900,
    }));
    const rows = [...closedRows('skewed', 40, 300), ...openRows('skewed', 3, 400), ...incoherent];
    const finding = findingFor(rows, 'skewed');

    expect(finding.incoherentClosedCount).toBe(30);
    expect(finding.closedCount).toBe(40);
    // p95 reflects only the coherent closes, so the open rows stay inside the norm.
    expect(finding.p95CloseHours).toBeCloseTo(300, 6);
    expect(finding.verdict).toBe('within-own-norm');
  });

  it('emitters with no open rows are censused, not accused', () => {
    const report = scanDurableEscalations(closedRows('all-clear', 50, 2), { nowMs: NOW });
    expect(report.findings).toEqual([]);
    expect(report.emittersWithNoOpenRows).toEqual(['all-clear']);
    expect(report.rowsScanned).toBe(50);
  });

  it('actionableFindings ranks orphan-suspect first and drops the clean emitters', () => {
    const rows = [
      ...closedRows('fast', 200, 0.1, 'f'),
      ...openRows('fast', 2, 500, 'fo'),
      ...openRows('never-closed', 1, 100, 'n'),
      ...closedRows('thin', 3, 1, 't'),
      ...openRows('thin', 1, 50, 'to'),
      ...closedRows('clean', 50, 100, 'g'),
      ...openRows('clean', 1, 10, 'go'),
    ];
    const ordered = actionableFindings(scanDurableEscalations(rows, { nowMs: NOW }));

    expect(ordered.map((f) => f.verdict)).toEqual([
      'orphan-suspect',
      'no-resolve-path-observed',
      'insufficient-close-sample',
    ]);
    expect(ordered.map((f) => f.emitter)).not.toContain('clean');
  });

  it('CALIBRATION: the real 2026-08-31 emitter shapes classify as measured', () => {
    // If this drifts, the module no longer describes the ledger it was built from.
    const rows = [
      ...closedRows('system:resource-governor', 300, 0, 'rg'),
      ...openRows('system:resource-governor', 50, 38.31, 'rgo'),
      ...closedRows('system:replication-liveness', 300, 0.19, 'rl'),
      ...openRows('system:replication-liveness', 20, 1260.6, 'rlo'),
      ...closedRows('system:spec-triad', 300, 120, 'st'),
      ...openRows('system:spec-triad', 20, 325.15, 'sto'),
    ];
    const byEmitter = Object.fromEntries(
      scanDurableEscalations(rows, { nowMs: NOW }).findings.map((f) => [f.emitter, f.verdict]),
    );

    expect(byEmitter).toEqual({
      'system:resource-governor': 'orphan-suspect',
      'system:replication-liveness': 'orphan-suspect',
      'system:spec-triad': 'within-own-norm',
    });
  });
});

/**
 * PERMANENT POSITIVE CONTROL — a deliberately-wrong classifier kept in the
 * file forever. It is the naive rule the originating item proposed: flag any
 * open row past a fixed absolute age. The controls above must CATCH it, which
 * is what proves they are testing the per-emitter property and not merely
 * agreeing with whatever the module happens to return.
 */
function naiveAgeOnlyVerdict(rows: readonly EscalationRow[], ageThresholdHours: number): string {
  const oldestOpen = rows
    .filter((r) => r.closedAtMs === null)
    .reduce((max, r) => Math.max(max, (NOW - r.createdAtMs) / HOUR), 0);
  return oldestOpen > ageThresholdHours ? 'orphan-suspect' : 'within-own-norm';
}

describe('permanent positive control: the naive age-only rule this module replaced', () => {
  it('the naive rule MISCLASSIFIES spec-triad, and the real module does not', () => {
    const specTriad = [
      ...closedRows('system:spec-triad', 200, 120),
      ...openRows('system:spec-triad', 40, 325),
    ];

    // The wrong answer, reproduced on purpose at a 7-day threshold (168h).
    expect(naiveAgeOnlyVerdict(specTriad, 168)).toBe('orphan-suspect');
    // The module under test disagrees, which is the entire reason it exists.
    expect(findingFor(specTriad, 'system:spec-triad').verdict).toBe('within-own-norm');
  });

  it('the naive rule and the module AGREE where they should — calibration, not contrarianism', () => {
    // A control that only ever disagreed would pass even if the module were
    // inverted. On the resource-governor shape both must say orphan-suspect.
    const governor = [
      ...closedRows('system:resource-governor', 200, 0),
      ...openRows('system:resource-governor', 30, 38),
    ];

    expect(naiveAgeOnlyVerdict(governor, 1)).toBe('orphan-suspect');
    expect(findingFor(governor, 'system:resource-governor').verdict).toBe('orphan-suspect');
  });
});
