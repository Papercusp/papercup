import { describe, expect, it } from 'vitest';
import {
  COMPACTION_HINT_PCT,
  CONTEXT_GAUGE_CRITICAL_PCT,
  CONTEXT_GAUGE_LOUD_PCT,
  CONTEXT_GAUGE_QUIET_PCT,
  contextGaugeBand,
  renderBandedContextGauge,
  renderContextUsageLine,
} from './inbox-context-usage';

describe('renderContextUsageLine (WI-1795 compaction affordance)', () => {
  it('returns null when usage cannot be computed', () => {
    expect(renderContextUsageLine(null, 158000)).toBeNull();
    expect(renderContextUsageLine(undefined, 158000)).toBeNull();
    expect(renderContextUsageLine(1000, null)).toBeNull();
    expect(renderContextUsageLine(1000, undefined)).toBeNull();
    expect(renderContextUsageLine(1000, 0)).toBeNull(); // 0 limit is falsy → no divide-by-zero
  });

  it('renders a bare fact BELOW the threshold (no affordance)', () => {
    const line = renderContextUsageLine(50_000, 158_000); // ~32%
    expect(line).toBe('context: 50000/158000 (32%)');
    expect(line).not.toMatch(/request-compaction/);
  });

  it('stays a bare fact JUST below the threshold', () => {
    // 84% < 85% → no hint
    const line = renderContextUsageLine(84, 100);
    expect(line).toBe('context: 84/100 (84%)');
    expect(line).not.toMatch(/request-compaction/);
  });

  it('NAMES the action AT the threshold', () => {
    const line = renderContextUsageLine(85, 100); // exactly 85%
    expect(line).toContain('context: 85/100 (85%)');
    expect(line).toContain('session:request-compaction');
    expect(line).toContain('/compact');
  });

  it('NAMES the action ABOVE the threshold, including over 100%', () => {
    const line = renderContextUsageLine(217_577, 158_000); // 138%
    expect(line).toContain('context: 217577/158000 (138%)');
    expect(line).toContain('CALL session:request-compaction');
    // guards the behavioral trap the owner flagged: narrating turn-end instead of calling
    expect(line).toMatch(/do not merely describe ending the turn/i);
  });

  it('gates precisely on the rounded percentage at COMPACTION_HINT_PCT', () => {
    // pct rounds: 0.845 → 85 (hint), 0.844 → 84 (no hint)
    const withHint = renderContextUsageLine(845, 1000);
    const without = renderContextUsageLine(844, 1000);
    expect(withHint).toContain('request-compaction');
    expect(without).not.toContain('request-compaction');
    expect(COMPACTION_HINT_PCT).toBe(85);
  });
});

describe('contextGaugeBand (P-013/P-015 banding)', () => {
  it('is silent (null) below the QUIET threshold', () => {
    expect(contextGaugeBand(null)).toBeNull();
    expect(contextGaugeBand(undefined)).toBeNull();
    expect(contextGaugeBand(0)).toBeNull();
    expect(contextGaugeBand(CONTEXT_GAUGE_QUIET_PCT - 1)).toBeNull();
  });
  it('bands quiet / loud / critical at the boundaries', () => {
    expect(contextGaugeBand(CONTEXT_GAUGE_QUIET_PCT)).toBe('quiet'); // 65
    expect(contextGaugeBand(CONTEXT_GAUGE_LOUD_PCT - 1)).toBe('quiet'); // 79
    expect(contextGaugeBand(CONTEXT_GAUGE_LOUD_PCT)).toBe('loud'); // 80
    expect(contextGaugeBand(CONTEXT_GAUGE_CRITICAL_PCT - 1)).toBe('loud'); // 89
    expect(contextGaugeBand(CONTEXT_GAUGE_CRITICAL_PCT)).toBe('critical'); // 90
    expect(contextGaugeBand(140)).toBe('critical');
  });
  it('exposes the owner-proposed thresholds', () => {
    expect([CONTEXT_GAUGE_QUIET_PCT, CONTEXT_GAUGE_LOUD_PCT, CONTEXT_GAUGE_CRITICAL_PCT]).toEqual([
      65, 80, 90,
    ]);
  });
});

describe('renderBandedContextGauge (P-013/P-015 ambient gauge)', () => {
  it('is silent below the quiet band and when usage is uncomputable', () => {
    expect(renderBandedContextGauge(50_000, 158_000)).toBeNull(); // ~32%
    expect(renderBandedContextGauge(64, 100)).toBeNull(); // 64%
    expect(renderBandedContextGauge(null, 300_000)).toBeNull();
    expect(renderBandedContextGauge(1000, 0)).toBeNull();
  });

  it('renders a bare fact in the quiet band (65–79%), no affordance', () => {
    const line = renderBandedContextGauge(70, 100);
    expect(line).toBe('context: 70/100 (70%)');
    expect(line).not.toMatch(/request-compaction/);
    expect(line).not.toMatch(/⚠/);
  });

  it('renders a LOUD ⚠ action line in 80–89%', () => {
    const line = renderBandedContextGauge(85, 100);
    expect(line).toContain('⚠ context: 85/100 (85%)');
    expect(line).toContain('session:request-compaction');
    expect(line).toMatch(/approaching your soft compaction limit/i);
  });

  it('renders a CRITICAL ⚠ urgent line at/above 90%', () => {
    const line = renderBandedContextGauge(95, 100);
    expect(line).toContain('⚠ context: 95/100 (95%)');
    expect(line).toContain('CRITICAL');
    expect(line).toContain('session:request-compaction');
    expect(line).toMatch(/do not merely narrate ending the turn/i);
  });

  it('bands exactly on the rounded percent at each boundary', () => {
    expect(renderBandedContextGauge(64, 100)).toBeNull(); // 64 silent
    expect(renderBandedContextGauge(65, 100)).toBe('context: 65/100 (65%)'); // quiet
    expect(renderBandedContextGauge(80, 100)).toMatch(/approaching/); // loud
    expect(renderBandedContextGauge(90, 100)).toMatch(/CRITICAL/); // critical
  });
});
