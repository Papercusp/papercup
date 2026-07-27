import { describe, it, expect } from 'vitest';
import { cellUnknown, formatCellUnknown, type CellUnknownCode } from './cell-contract';

/**
 * The contract term under test (unified-agent-state-plane-2026-07-27 #D-038,
 * axis 2 corollary) is not "the reason is present" — three surfaces already had
 * that and still shipped the defect. It is that the reason is BRANCHABLE, and
 * that a prose surface can never silently lose it.
 */
describe('cell-contract: the in-band unknown', () => {
  it('omits `detail` entirely rather than storing undefined, so a code-only unknown is still a clean object', () => {
    expect(cellUnknown('not-measured')).toEqual({ code: 'not-measured' });
    expect('detail' in cellUnknown('not-measured')).toBe(false);
  });

  it('keeps the prose as `detail` — the human sentence is preserved, not traded away for the code', () => {
    const u = cellUnknown('resolver-failed', 'the probe timed out');
    expect(u.code).toBe('resolver-failed');
    expect(u.detail).toBe('the probe timed out');
  });

  /**
   * THE REGRESSION THIS MODULE EXISTS TO PREVENT, in its second form. The first
   * form was prose-only (unbranchable). The opposite failure is a code-only
   * unknown rendered into a report as `undefined`, or dropped — which puts the
   * reader back to a bare null, exactly where we started.
   */
  it('never renders empty for a code-only unknown — every code has fallback prose', () => {
    const codes: CellUnknownCode[] = ['not-applicable', 'resolver-failed', 'not-measured', 'insufficient-data'];
    for (const code of codes) {
      const rendered = formatCellUnknown({ code });
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered).not.toContain('undefined');
    }
  });

  it('prefers the specific detail over the generic fallback when one was supplied', () => {
    expect(formatCellUnknown({ code: 'resolver-failed', detail: 'systemd said no' })).toBe('systemd said no');
    expect(formatCellUnknown({ code: 'resolver-failed' })).not.toBe('systemd said no');
  });

  /**
   * `not-applicable` is FINAL; `resolver-failed` is retry-or-escalate. If those
   * two ever collapse to the same value, the enum has bought nothing over the
   * free text it replaced — which is the whole finding behind D-038's corollary.
   */
  it('keeps the two codes with OPPOSITE caller responses distinguishable', () => {
    expect(cellUnknown('not-applicable').code).not.toBe(cellUnknown('resolver-failed').code);
  });
});
