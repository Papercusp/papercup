import { describe, expect, it } from 'vitest';
import { buildDrainFlowReport } from './drain-flow';

const basis = {
  windowStart: '2026-08-13T00:00:00.000Z',
  workspaceId: 'ws-1',
  harness: 'papercusp',
  ownerId: 'su-1',
};

describe('buildDrainFlowReport', () => {
  it('fills every severity bucket, coerces bigint strings, and defaults unknown severity to minor', () => {
    const report = buildDrainFlowReport(
      [
        { severity: 'critical', opened: '2', terminaled: '1' },
        { severity: 'major', opened: 0, terminaled: 2 },
        { severity: 'unexpected', opened: '3', terminaled: null },
      ],
      basis,
    );

    expect(report.bySeverity).toEqual({
      critical: { opened: 2, terminaled: 1, net: 1 },
      major: { opened: 0, terminaled: 2, net: -2 },
      minor: { opened: 3, terminaled: 0, net: 3 },
      nit: { opened: 0, terminaled: 0, net: 0 },
    });
    expect(report.totals).toEqual({ opened: 5, terminaled: 3, net: 2 });
  });

  it('admits the 0/0 first bug, then trips at positive break-even or positive net flow', () => {
    expect(buildDrainFlowReport([], basis).breaker.tripped).toBe(false);
    expect(buildDrainFlowReport([{ severity: 'minor', opened: 1, terminaled: 1 }], basis).breaker.tripped).toBe(true);
    expect(buildDrainFlowReport([{ severity: 'minor', opened: 2, terminaled: 1 }], basis).breaker.tripped).toBe(true);
  });

  it('reopens only after terminaled strictly exceeds opened', () => {
    const report = buildDrainFlowReport(
      [{ severity: 'major', opened: 2, terminaled: 3 }],
      basis,
    );
    expect(report.totals).toEqual({ opened: 2, terminaled: 3, net: -1 });
    expect(report.breaker).toMatchObject({ tripped: false, blocksNewBugs: false });
  });
});
