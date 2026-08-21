/**
 * P-008 / D-012 — the tenure rule: a cut-or-keep verdict for registered cells.
 *
 * ⚠ WHAT THESE TESTS ARE GUARDING AGAINST is not "the arithmetic is wrong". It is
 * that the rule, written the obvious way, RECOMMENDS CUTTING ITS OWN NAMED FIRST
 * SUBJECTS on day one. So most of the cases below assert a NON-cut, and a suite of
 * "does not cut" assertions is exactly the suite that passes when the rule cuts
 * NOTHING EVER — including a genuinely dead cell. That is why
 * `CALIBRATION` below is not optional: it is the positive control that proves the
 * instrument can still fire. Delete it and every other case here becomes vacuous.
 */
import { describe, it, expect } from 'vitest';
import {
  composeCellTenure,
  summariseCellTenure,
  formatCellTenureLog,
  isStructuralCellZero,
  isCutCandidate,
  CELL_TENURE_WINDOW_DAYS,
  TOOL_INVOCATIONS_RETENTION_DAYS,
  type CellReadCount,
} from './cell-tenure';
import { BUILTIN_CELLS } from './cell-registrations';
import { DEFAULT_RETENTION_TARGETS } from './harness/routines/telemetry-retention-action';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-21T00:00:00Z');

/** A window fully covered by telemetry — the ordinary, assessable case. */
const FULLY_OBSERVED = NOW - (CELL_TENURE_WINDOW_DAYS + 1) * DAY;

function noReads(): ReadonlyMap<string, CellReadCount> {
  return new Map();
}

function readsFor(cell: string, reads: number, callers = 1): ReadonlyMap<string, CellReadCount> {
  return new Map([[cell, { reads, callers }]]);
}

/** Days before NOW, as the YYYY-MM-DD the registry declares. */
function registeredDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString().slice(0, 10);
}

describe('CALIBRATION — the rule CAN recommend a cut', () => {
  /**
   * THE POSITIVE CONTROL. Every other case asserts something is NOT cut; without
   * this one, a `composeCellTenure` that returned 'keep' unconditionally — or that
   * threw away the cut branch entirely — would pass the whole file.
   */
  it('a genuinely dormant cell — old enough, window fully observed, zero reads — IS a cut-candidate', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'dead.cell', registeredOn: registeredDaysAgo(90) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('cut-candidate');
    expect(isCutCandidate(line.verdict)).toBe(true);
    // A cut is a MEASURED finding, not one of the "nothing was measured" zeros.
    expect(isStructuralCellZero(line.verdict)).toBe(false);
    expect(line.reads).toBe(0);
    expect(line.tenureDays).toBe(90);
  });
});

describe('a read is a read — KEEP is unconditional', () => {
  it('keeps a cell with reads even when it is far younger than the window', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'young.but.read', registeredOn: registeredDaysAgo(1) }],
      reads: readsFor('young.but.read', 5, 4),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('keep');
    expect(line.callers).toBe(4);
  });

  it('keeps a cell with reads even when the window is barely observed at all', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'read.but.blind', registeredOn: registeredDaysAgo(90) }],
      reads: readsFor('read.but.blind', 1),
      nowMs: NOW,
      observableSinceMs: NOW - 1 * DAY,
    });

    // Partial evidence of adoption is still evidence; only a CUT needs the guards.
    expect(line.verdict).toBe('keep');
  });

  it('keeps a cell with reads even when registeredOn is missing', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'undated.but.read' }],
      reads: readsFor('undated.but.read', 2),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('keep');
  });
});

describe('the three structural zeros — measured NOTHING, so they suppress the cut', () => {
  it('too-young: a cell younger than the window is not judged', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'fresh.cell', registeredOn: registeredDaysAgo(3) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('too-young');
    expect(isCutCandidate(line.verdict)).toBe(false);
    expect(isStructuralCellZero(line.verdict)).toBe(true);
    expect(line.why).toContain('predate the cell');
  });

  it('the boundary is inclusive: tenure EXACTLY equal to the window is assessable', () => {
    const at = composeCellTenure({
      registered: [{ cell: 'boundary', registeredOn: registeredDaysAgo(CELL_TENURE_WINDOW_DAYS) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    })[0];
    const justUnder = composeCellTenure({
      registered: [{ cell: 'boundary', registeredOn: registeredDaysAgo(CELL_TENURE_WINDOW_DAYS - 1) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    })[0];

    expect(at.verdict).toBe('cut-candidate');
    expect(justUnder.verdict).toBe('too-young');
  });

  it('unobservable: telemetry covering less than the window is not evidence of no demand', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'old.cell', registeredOn: registeredDaysAgo(90) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: NOW - 3 * DAY,
    });

    expect(line.verdict).toBe('unobservable');
    expect(line.observedDays).toBe(3);
    expect(line.why).toContain('absent history is not absent demand');
  });

  it('tenure-unknown: a missing registeredOn can only SUPPRESS a cut, never cause one', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'undated.cell' }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('tenure-unknown');
    expect(line.tenureDays).toBeNull();
  });

  it('an unparseable registeredOn fails CLOSED, it does not throw or read as age 0', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'garbage.date', registeredOn: 'last Tuesday' }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(line.verdict).toBe('tenure-unknown');
  });

  it('a null observability horizon fails CLOSED — a broken probe cannot manufacture cuts', () => {
    const [line] = composeCellTenure({
      registered: [{ cell: 'old.cell', registeredOn: registeredDaysAgo(90) }],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: null,
    });

    expect(line.verdict).toBe('unobservable');
    expect(line.observedDays).toBe(0);
  });
});

describe('D-012 REGRESSION — P-008’s own named first subjects must not be cut', () => {
  /**
   * The measured scenario, verbatim: both cells were registered 2026-08-18 (commit
   * 92db953012) and had 0 state:read rows on 2026-08-21. A literal "0 reads over a
   * trailing window ⇒ cut" recommends removing both, three days after they shipped.
   */
  it('testing.census.population and testing.coverage.floor read as too-young, not cut-candidates', () => {
    const lines = composeCellTenure({
      registered: [
        { cell: 'testing.census.population', registeredOn: '2026-08-18' },
        { cell: 'testing.coverage.floor', registeredOn: '2026-08-18' },
      ],
      reads: noReads(),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(lines.map((l) => l.verdict)).toEqual(['too-young', 'too-young']);
    expect(lines.every((l) => !isCutCandidate(l.verdict))).toBe(true);
  });

  it('and they BECOME assessable once they are old enough — the guard is a delay, not an exemption', () => {
    const laterThanTheWindow = Date.parse('2026-08-18T00:00:00Z') + (CELL_TENURE_WINDOW_DAYS + 1) * DAY;

    const [line] = composeCellTenure({
      registered: [{ cell: 'testing.census.population', registeredOn: '2026-08-18' }],
      reads: noReads(),
      nowMs: laterThanTheWindow,
      observableSinceMs: laterThanTheWindow - (CELL_TENURE_WINDOW_DAYS + 1) * DAY,
    });

    expect(line.verdict).toBe('cut-candidate');
  });
});

describe('the registry declares what the rule needs', () => {
  it('EVERY registered cell declares registeredOn — optional in the type, mandatory here', () => {
    const undated = BUILTIN_CELLS.filter((c) => !c.registeredOn).map((c) => c.cell);

    expect(
      undated,
      `these registered cells declare no registeredOn, so the tenure rule can never assess them ` +
        `(they report 'tenure-unknown' forever): ${undated.join(', ')}. Add registeredOn: 'YYYY-MM-DD' ` +
        `— the date the cell entered the registry, which git will tell you: ` +
        `git log -S'<cell id>' -- packages/operator-core/lib/cell-registrations.ts | tail -1`,
    ).toEqual([]);
  });

  /**
   * FALSIFIABILITY CONTROL for the guard above. That guard passes today because
   * all 10 registrations were dated — which is indistinguishable from a guard whose
   * predicate detects nothing. A synthetic undated spec proves the predicate still
   * fires. Kept in the test file rather than mutating cell-registrations.ts: an
   * in-tree mutation can be committed by the git-sync sweep even when nothing goes
   * wrong (CLAUDE.md, "Proving a guard is falsifiable").
   */
  it('DELIBERATE VIOLATION: an undated spec is detected by the same predicate', () => {
    const withAMissingDate = [...BUILTIN_CELLS, { cell: 'synthetic.undated' } as (typeof BUILTIN_CELLS)[number]];

    expect(withAMissingDate.filter((c) => !c.registeredOn).map((c) => c.cell)).toEqual(['synthetic.undated']);
  });

  it('every declared registeredOn parses as a real date and is not in the future', () => {
    for (const spec of BUILTIN_CELLS) {
      if (!spec.registeredOn) continue;
      expect(spec.registeredOn, `${spec.cell} registeredOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const t = Date.parse(`${spec.registeredOn}T00:00:00Z`);
      expect(Number.isNaN(t), `${spec.cell} registeredOn does not parse`).toBe(false);
      expect(t, `${spec.cell} is registered in the future`).toBeLessThanOrEqual(Date.now());
    }
  });

  /**
   * The window is pinned to retention because a window longer than retention cannot
   * be observed. If someone retunes retention, this fails rather than letting the
   * rule silently start reading pruned history as absent demand.
   */
  it('the mirrored retention constant still agrees with the routine that enforces it', () => {
    const target = DEFAULT_RETENTION_TARGETS.find((t) => t.category === 'tool-invocations');

    expect(target, 'the tool-invocations retention target has been renamed or removed').toBeDefined();
    expect(target?.retention_days).toBe(TOOL_INVOCATIONS_RETENTION_DAYS);
    expect(CELL_TENURE_WINDOW_DAYS).toBeLessThanOrEqual(TOOL_INVOCATIONS_RETENTION_DAYS);
  });
});

describe('the reported line', () => {
  it('counts every verdict and leads the log with what was NOT assessed', () => {
    const lines = composeCellTenure({
      registered: [
        { cell: 'a.read', registeredOn: registeredDaysAgo(90) },
        { cell: 'b.dead', registeredOn: registeredDaysAgo(90) },
        { cell: 'c.young', registeredOn: registeredDaysAgo(2) },
        { cell: 'd.undated' },
      ],
      reads: readsFor('a.read', 12, 9),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(summariseCellTenure(lines)).toEqual({
      keep: 1,
      'cut-candidate': 1,
      'too-young': 1,
      unobservable: 0,
      'tenure-unknown': 1,
    });

    const log = formatCellTenureLog(lines);
    // "4 registered · 1 keep · 1 cut-candidate" alone would let a reader conclude
    // the registry is 3/4 healthy, when HALF of it was never judged at all.
    expect(log).toContain('2 NOT-ASSESSED');
    expect(log).toContain('b.dead=CUT-CANDIDATE');
    expect(log).toContain('c.young=TOO-YOUNG');
    expect(log).toContain('d.undated=TENURE-UNKNOWN');
    // A kept cell is not noise in the detail list.
    expect(log).not.toContain('a.read=');
  });

  it('a cell absent from the reads map is zero reads, not a lookup failure', () => {
    const lines = composeCellTenure({
      registered: [{ cell: 'absent', registeredOn: registeredDaysAgo(90) }],
      reads: readsFor('some.other.cell', 100),
      nowMs: NOW,
      observableSinceMs: FULLY_OBSERVED,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].reads).toBe(0);
    expect(lines[0].verdict).toBe('cut-candidate');
  });
});
