import { describe, expect, it } from 'vitest';
import { COMPACTION_HINT_PCT, renderContextUsageLine } from './inbox-context-usage';

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
