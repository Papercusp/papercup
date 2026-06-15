// @vitest-environment jsdom
//
// HarnessesTab — the cross-workspace harness health matrix. Its only genuine
// pure logic is fmtAge, the "last run" age formatter shared by the matrix's
// Last-run column (it tolerates null/undefined for harnesses that never ran).
// The rest of the tab is an effect-only fetch shell over RichGrid. fmtAge is
// extracted + exported and pinned at its s/m/h/d boundaries + the null case.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));

import { fmtAge } from './HarnessesTab';

describe('fmtAge', () => {
  it('renders an em dash for null / undefined (never ran)', () => {
    expect(fmtAge(null)).toBe('—');
    expect(fmtAge(undefined)).toBe('—');
  });
  it('renders seconds under a minute', () => {
    expect(fmtAge(0)).toBe('0s');
    expect(fmtAge(45)).toBe('45s');
  });
  it('renders whole minutes / hours / days at each boundary', () => {
    expect(fmtAge(90)).toBe('1m');
    expect(fmtAge(2 * 3600)).toBe('2h');
    expect(fmtAge(3 * 86400)).toBe('3d');
  });
});
