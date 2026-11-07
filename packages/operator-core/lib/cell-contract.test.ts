import { describe, it, expect } from 'vitest';
import { cellUnknown, formatCellUnknown, projectCellComparison, parseCellObservationAnchor, type CellUnknownCode } from './cell-contract';
import type { CellRead } from './cell-read';

const semanticRead = (): Extract<CellRead, { status: 'value' }> => ({
  status: 'value', cell: 'test.semantic', resolver: 'test:read', measurementPath: 'sha', value: 'abc', headline: 'candidate',
  assessment: { status: 'resolved', path: 'assessment', code: 'executing', meaning: 'running', safeAction: 'wait', evidence: [{ path: 'count', value: 0, measuredBy: { path: 'measured', value: true } }] },
  material: { path: 'contained', value: false },
  source: { path: 'source', value: 'live', authoritative: true, why: 'measured' },
  unknownHoist: { key: 'unknown', value: [] },
});

describe('versioned cell comparison projection', () => {
  it('selects a SHA independently from an unchanged assessment and retains false material values', () => {
    const r = semanticRead();
    expect(projectCellComparison(r, 'a.ts', 'measurement')).toMatchObject({ status: 'value', selected: 'abc', target: 'measurement' });
    expect(projectCellComparison(r, 'a.ts', 'assessment')).toMatchObject({ status: 'value', selected: 'executing' });
    expect(projectCellComparison(r)).toMatchObject({ status: 'value', selected: false, target: 'material' });
    expect(projectCellComparison({ ...r, value: 0 }, undefined, 'measurement')).toMatchObject({ selected: 0 });
  });

  it('keeps assessment, uncertainty, measuredness, authority and schema in the comparison', () => {
    const r = semanticRead();
    const baseline = projectCellComparison(r, 'a.ts');
    expect(projectCellComparison({ ...r, source: { ...r.source!, authoritative: false } }, 'a.ts')).not.toEqual(baseline);
    expect(projectCellComparison({ ...r, unknownHoist: { key: 'unknown', value: ['incomplete'] } }, 'a.ts')).not.toEqual(baseline);
    expect(projectCellComparison({ ...r, measurementPath: 'different' }, 'a.ts')).not.toEqual(baseline);
    expect(projectCellComparison(r, 'b.ts')).not.toEqual(baseline);
  });

  it('ignores evidence telemetry values while preserving their measuredness qualifiers', () => {
    const r = semanticRead();
    const assessment = r.assessment!;
    expect(projectCellComparison({ ...r, assessment: { ...assessment, evidence: [{ ...assessment.evidence[0], value: 12345 }] } })).toEqual(projectCellComparison(r));
    expect(projectCellComparison({ ...r, assessment: { ...assessment, evidence: [{ ...assessment.evidence[0], measuredBy: { path: 'measured', value: false } }] } })).not.toEqual(projectCellComparison(r));
  });

  it('refuses unavailable assessments, drifted uncertainty and an undeclared target', () => {
    const r = semanticRead();
    expect(projectCellComparison({ ...r, assessment: { status: 'unavailable', path: 'assessment', code: null, meaning: null, safeAction: 'reread', evidence: [], unknown: { code: 'not-measured' } } })).toEqual({ status: 'unknown', unknown: 'not-measured' });
    expect(projectCellComparison({ ...r, unknownHoist: { key: 'unknown', value: null, drifted: true } })).toEqual({ status: 'unknown', unknown: 'insufficient-data' });
    expect(projectCellComparison({ ...r, material: undefined }, undefined, 'material').status).toBe('unknown');
    expect(projectCellComparison({ status: 'unknown', cell: r.cell, unknown: { code: 'resolver-failed' } }).status).toBe('unknown');
  });

  it('never upgrades missing, malformed or future anchor versions to the current version', () => {
    expect(parseCellObservationAnchor(undefined)).toBeUndefined();
    expect(parseCellObservationAnchor({ version: 2, target: 'measurement' })).toBeUndefined();
    expect(parseCellObservationAnchor({ version: 1, target: 'measurement', identityDigest: 'invalid' })).toBeUndefined();
  });
});

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
