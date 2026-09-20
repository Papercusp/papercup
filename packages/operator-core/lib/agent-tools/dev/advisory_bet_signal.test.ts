import { describe, expect, it } from 'vitest';
import {
  TRIGGER_TOO_NARROW_FIRES_PER_WEEK,
  noBehaviourChange,
  triggerTooNarrow,
  windowOf,
  type WindowSpec,
} from './advisory_bet_signal';
import type { AdvisoryFireCount } from '../../pg-query-advisory/fires';
import type { CorrectionReport } from '../../coord-lifecycle/population-claim-correction';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-20T00:00:00.000Z');

function completeWindow(hours: number): WindowSpec {
  return windowOf(new Date(NOW.getTime() - hours * HOUR), NOW, NOW);
}

function partialWindow(elapsedHours: number, remainingHours: number): WindowSpec {
  return windowOf(
    new Date(NOW.getTime() - elapsedHours * HOUR),
    new Date(NOW.getTime() + remainingHours * HOUR),
    NOW,
  );
}

const measured = (total: number): AdvisoryFireCount => ({
  status: 'measured',
  total,
  byLabel: { 'sql-shape:count-star': total },
});

function report(over: Partial<CorrectionReport> = {}): CorrectionReport {
  return {
    messages: 100,
    authored: 50,
    speechActs: 5,
    corrections: 0,
    ratePerAuthored: 0,
    rejected: {
      automated: 0,
      'machine-restatement': 0,
      'no-speech-act': 0,
      'no-population-referent': 0,
    },
    ...over,
  };
}

describe('windowOf', () => {
  it('reports a finished window as complete, with its full span elapsed', () => {
    const w = completeWindow(168);
    expect(w.complete).toBe(true);
    expect(w.elapsedHours).toBeCloseTo(168, 6);
  });

  it('reports an unfinished window as incomplete and clamps elapsed time to now', () => {
    const w = partialWindow(24, 144);
    expect(w.complete).toBe(false);
    // Not 168: only 24h has actually run. Reporting the nominal span here would
    // make a barely-started window look like a full one.
    expect(w.elapsedHours).toBeCloseTo(24, 6);
  });

  it('never reports negative elapsed time for a wholly future window', () => {
    const w = windowOf(new Date(NOW.getTime() + 5 * HOUR), new Date(NOW.getTime() + 9 * HOUR), NOW);
    expect(w.elapsedHours).toBe(0);
    expect(w.complete).toBe(false);
  });
});

describe('triggerTooNarrow', () => {
  // The load-bearing distinction: an uninstrumented database and a genuine zero
  // both produce "no rows", and only one of them may settle the falsifier.
  it('is indeterminate when the fire count is not instrumented, NOT "met"', () => {
    const f = triggerTooNarrow(
      { status: 'not-instrumented', reason: 'migration 1183 has not applied' },
      completeWindow(168),
    );
    expect(f.status).toBe('indeterminate');
    expect(f.why).toContain('NOT a measured zero');
  });

  it('is indeterminate when the fire count is unavailable', () => {
    const f = triggerTooNarrow(
      { status: 'unavailable', reason: 'connection refused' },
      completeWindow(168),
    );
    expect(f.status).toBe('indeterminate');
  });

  it('treats a genuine measured zero over a full week as met', () => {
    // Paired with the not-instrumented case above on purpose: same visible
    // "nothing happened", opposite verdicts.
    expect(triggerTooNarrow(measured(0), completeWindow(168)).status).toBe('met');
  });

  it('is indeterminate when the window has barely started', () => {
    expect(triggerTooNarrow(measured(0), partialWindow(0.5, 167.5)).status).toBe('indeterminate');
  });

  it('is met below the fires-per-week floor', () => {
    const f = triggerTooNarrow(measured(TRIGGER_TOO_NARROW_FIRES_PER_WEEK - 1), completeWindow(168));
    expect(f.status).toBe('met');
  });

  it('is not-met at exactly the floor (the comparison is strict)', () => {
    const f = triggerTooNarrow(measured(TRIGGER_TOO_NARROW_FIRES_PER_WEEK), completeWindow(168));
    expect(f.status).toBe('not-met');
  });

  it('extrapolates a short window to a weekly rate rather than comparing raw counts', () => {
    // 2 fires in 24h is 14/week — above the floor — even though the raw count
    // is below it. Comparing counts instead of rates would report 'met' here.
    expect(triggerTooNarrow(measured(2), completeWindow(24)).status).toBe('not-met');
  });
});

describe('noBehaviourChange', () => {
  const complete = completeWindow(168);

  it('is indeterminate when fires were never measured', () => {
    const f = noBehaviourChange(
      { status: 'not-instrumented', reason: 'migration 1183 has not applied' },
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.1 }),
      complete,
    );
    expect(f.status).toBe('indeterminate');
  });

  it('is indeterminate when the advisory never fired', () => {
    const f = noBehaviourChange(
      measured(0),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.1 }),
      complete,
    );
    expect(f.status).toBe('indeterminate');
    expect(f.why).toContain('never fired');
  });

  it('is indeterminate while the after-window is still running', () => {
    const f = noBehaviourChange(
      measured(50),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.1 }),
      partialWindow(24, 144),
    );
    expect(f.status).toBe('indeterminate');
  });

  it('is indeterminate when either window had no authored traffic to divide by', () => {
    expect(
      noBehaviourChange(
        measured(50),
        report({ ratePerAuthored: null }),
        report({ ratePerAuthored: 0.1 }),
        complete,
      ).status,
    ).toBe('indeterminate');
    expect(
      noBehaviourChange(
        measured(50),
        report({ ratePerAuthored: 0.1 }),
        report({ ratePerAuthored: null }),
        complete,
      ).status,
    ).toBe('indeterminate');
  });

  it('is not-met when the correction rate moved by at least 10%', () => {
    const f = noBehaviourChange(
      measured(50),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.2 }),
      complete,
    );
    expect(f.status).toBe('not-met');
  });

  it('is met when the correction rate barely moved', () => {
    const f = noBehaviourChange(
      measured(50),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.101 }),
      complete,
    );
    expect(f.status).toBe('met');
  });

  // Regression: a zero BEFORE-rate leaves no relative change to compute. Reading
  // that as "no behaviour change" reported the LARGEST movement the metric can
  // express as evidence the advisory did nothing.
  it('is not-met when the rate rose from a zero baseline', () => {
    const f = noBehaviourChange(
      measured(50),
      report({ ratePerAuthored: 0 }),
      report({ ratePerAuthored: 0.25 }),
      complete,
    );
    expect(f.status).toBe('not-met');
    expect(f.why).toContain('zero baseline');
  });

  it('is met when both windows sat at a zero rate', () => {
    const f = noBehaviourChange(
      measured(50),
      report({ ratePerAuthored: 0 }),
      report({ ratePerAuthored: 0 }),
      complete,
    );
    expect(f.status).toBe('met');
  });

  // Design rule C: the two signals are counted independently and never joined.
  // The fire count gates whether the question is askable; it must not influence
  // the answer, or "it fired constantly and nothing changed" becomes unreachable.
  it('does not let the fire volume change the verdict', () => {
    const quiet = noBehaviourChange(
      measured(1),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.101 }),
      complete,
    );
    const loud = noBehaviourChange(
      measured(5_000),
      report({ ratePerAuthored: 0.1 }),
      report({ ratePerAuthored: 0.101 }),
      complete,
    );
    expect(quiet.status).toBe('met');
    expect(loud.status).toBe('met');
  });
});
