import { describe, expect, it } from 'vitest';
import { admitArm, ARM_ADMISSIONS } from './fair-comparison-admission';

describe('P-017 arm admission (D-011)', () => {
  it('admits every recorded arm and returns its telemetry-off environment', () => {
    for (const a of ARM_ADMISSIONS) expect(() => admitArm(a.armId)).not.toThrow();
    expect(admitArm('codegraph').env).toEqual({ CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' });
    expect(admitArm('trace-mcp').env).toEqual({ TRACE_MCP_TELEMETRY: 'off' });
  });

  it('resolves a versioned arm id to its engine admission', () => {
    expect(admitArm('gitnexus@1.6.9').admission.licence).toBe('noncommercial');
  });

  it('refuses an arm whose licence was never read', () => {
    expect(() => admitArm('sverklo')).toThrow(/no admission record/);
  });

  it('classifies licences consistently with their SPDX id', () => {
    for (const a of ARM_ADMISSIONS) {
      if (a.spdx === 'first-party') expect(a.licence).toBe('first-party');
      else if (/Noncommercial/i.test(a.spdx)) expect(a.licence).toBe('noncommercial');
      else expect(a.licence).toBe('permissive');
    }
  });

  it('records an opt-out for every engine whose telemetry is on by default', () => {
    const on = ARM_ADMISSIONS.filter((a) => /^ON\b/.test(a.telemetryDefault));
    expect(on.map((a) => a.armId).sort()).toEqual(['codegraph', 'trace-mcp']);
    for (const a of on) expect(Object.keys(a.telemetryOffEnv).length).toBeGreaterThan(0);
  });
});
