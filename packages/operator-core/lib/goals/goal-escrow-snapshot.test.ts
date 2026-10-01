import { describe, expect, it } from 'vitest';
import { mapGateReading, mapGoalRow, mapWorkItemRow, normaliseTestResult } from './goal-escrow-snapshot';

describe('normaliseTestResult (agent-authored prose -> enum)', () => {
  it('reads a passing report as pass', () => {
    expect(normaliseTestResult('192/192 + 147/147 passed (TEST_FILE_RESULT status=passed each)')).toBe('pass');
  });

  it('does not read "0 failed" or "failed: 0" as a failure', () => {
    expect(normaliseTestResult('44 passed, 0 failed')).toBe('pass');
    expect(normaliseTestResult('passed: 44 failed: 0')).toBe('pass');
    expect(normaliseTestResult('all green, no failures')).toBe('pass');
  });

  it('reads a bare failure as fail', () => {
    expect(normaliseTestResult('2 failed')).toBe('fail');
    expect(normaliseTestResult('FAIL lib/x.test.ts')).toBe('fail');
  });

  it('does not read prose ABOUT failures as a failing result (WI-10002029 false positive)', () => {
    const adjudication =
      'All six legs adjudicated. 5 of 6 reds proven already-fixed at the live repairHead by blob difference; the 6th is still failing and filed.';
    expect(normaliseTestResult(adjudication)).toBe('unknown');
    expect(normaliseTestResult('the failing test was quarantined')).toBe('unknown');
  });

  it('refuses to guess when the text names both a pass and a failure', () => {
    expect(normaliseTestResult('41 passed, 3 failed')).toBe('unknown');
  });

  it('is null for no text and unknown for text with neither signal', () => {
    expect(normaliseTestResult(null)).toBeNull();
    expect(normaliseTestResult('')).toBeNull();
    expect(normaliseTestResult('verified by reading the diff')).toBe('unknown');
  });
});

describe('mapWorkItemRow', () => {
  it('counts a done close with _completionEvidence as evidenced and parses its test result', () => {
    const item = mapWorkItemRow({
      feature_id: 'WI-1',
      status: 'done',
      authority: 'committed',
      taken_by: null,
      terminal_owner: 'su-a',
      closed_ts: '1790827090697',
      completion_evidence: { testResult: '12 passed' },
      terminal_completion_ref: null,
    });
    expect(item).toMatchObject({
      id: 'WI-1',
      completionAuthority: 'committed',
      terminalOwner: 'su-a',
      closedAtMs: 1790827090697,
      hasCompletionEvidence: true,
      testResult: 'pass',
    });
  });

  it('counts a dropped close that carries only terminal_completion_ref as evidenced', () => {
    const item = mapWorkItemRow({
      feature_id: 'WI-2',
      status: 'dropped',
      authority: null,
      terminal_owner: null,
      completion_evidence: null,
      terminal_completion_ref: 'dropped: superseded by WI-9',
    });
    expect(item.hasCompletionEvidence).toBe(true);
    expect(item.testResult).toBeNull();
  });

  it('flags a close with neither evidence surface as unevidenced', () => {
    const item = mapWorkItemRow({ feature_id: 'WI-3', status: 'done', completion_evidence: null, terminal_completion_ref: null });
    expect(item.hasCompletionEvidence).toBe(false);
  });

  it('accepts the evidence column arriving as a JSON string', () => {
    const item = mapWorkItemRow({
      feature_id: 'WI-4',
      status: 'done',
      completion_evidence: JSON.stringify({ testResult: '3 failed' }),
      terminal_completion_ref: null,
    });
    expect(item.testResult).toBe('fail');
  });
});

describe('mapGateReading', () => {
  it('takes the freshest observation and turns an active freeze into a bounded no-go reason', () => {
    const { gate, noGoReason } = mapGateReading({
      lastVerdict: 'not-green',
      observedAt: 1000,
      lastGreenAt: 500,
      freezeAndConverge: { state: 'converging', reason: 'frozen repair head is still red', observedAtMs: 2000 },
    });
    expect(gate).toEqual({ lastVerdict: 'not-green', observedAtMs: 2000, lastGreenAtMs: 500 });
    expect(noGoReason).toEqual({ text: 'freeze-and-converge converging: frozen repair head is still red', observedAtMs: 2000 });
  });

  it('does not invent a no-go reason when the freeze is off or none', () => {
    for (const state of ['off', 'none', 'retired']) {
      const { noGoReason } = mapGateReading({
        lastVerdict: 'not-green',
        observedAt: 1000,
        freezeAndConverge: { state, reason: 'whatever', observedAtMs: 2000 },
      });
      expect(noGoReason).toBeNull();
    }
  });

  it('returns nothing for an unreadable gate_health', () => {
    expect(mapGateReading(null)).toEqual({ gate: null, noGoReason: null });
    expect(mapGateReading('not json')).toEqual({ gate: null, noGoReason: null });
  });
});

describe('mapGoalRow', () => {
  const NOW = Date.parse('2026-10-01T04:00:00.000Z');

  it('lifts spend, disposition and the authoritative lineage figure out of metadata', () => {
    const mapped = mapGoalRow(
      {
        id: 'goal-x',
        status: 'achieved',
        standing: false,
        budget_cents: '20000',
        kill_criterion: 'kill after 7d',
        updated_at: '2026-10-01T03:00:00.000Z',
        metadata: {
          disposition: 'killed',
          dispositionAt: '2026-10-01T03:06:24.777Z',
          spentCents: 364,
          spentCentsAt: '2026-10-01T03:57:49.029Z',
          spentCentsBreakdown: { lineageCents: 364, potCents: 24817 },
          spentCentsUnmeasuredReason: null,
        },
      },
      NOW,
    );
    expect(mapped.goal).toMatchObject({ id: 'goal-x', status: 'achieved', disposition: 'killed', budgetCents: 20000, standing: false });
    expect(mapped.goal.dispositionAtMs).toBe(Date.parse('2026-10-01T03:06:24.777Z'));
    expect(mapped.spend).toEqual({
      spentCents: 364,
      spentAtMs: Date.parse('2026-10-01T03:57:49.029Z'),
      lineageCents: 364,
      unmeasuredReason: null,
    });
    expect(mapped.ownerReportRequired).toBe(true);
  });

  it('does not require a closure owner report for a standing goal', () => {
    const mapped = mapGoalRow({ id: 'g', status: 'active', standing: true, metadata: {}, updated_at: '2026-10-01T03:00:00.000Z' }, NOW);
    expect(mapped.ownerReportRequired).toBe(false);
    expect(mapped.ownerReportNotRequiredReason).toContain('standing');
  });

  it('maps absent spend metadata to nulls, never to zero', () => {
    const mapped = mapGoalRow({ id: 'g', status: 'active', standing: false, metadata: null, updated_at: null }, NOW);
    expect(mapped.spend).toEqual({ spentCents: null, spentAtMs: null, lineageCents: null, unmeasuredReason: null });
    expect(mapped.goal.updatedAtMs).toBe(NOW);
  });
});
