// @vitest-environment jsdom
//
// AuditTab — the operator audit-log grid. It is mostly an effect-only fetch
// shell over RichGrid; the one bit of display logic worth pinning is the
// compact details preview (JSON, 100-char cap, '—' for empty), extracted as
// fmtAuditDetails + exported. grid/nuqs/Select mocked so the module imports.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('nuqs', () => ({
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));

import { fmtAuditDetails } from './AuditTab';

describe('fmtAuditDetails', () => {
  it('renders an em dash for null / undefined / empty details', () => {
    expect(fmtAuditDetails(null)).toBe('—');
    expect(fmtAuditDetails(undefined)).toBe('—');
    expect(fmtAuditDetails('')).toBe('—');
    expect(fmtAuditDetails(0)).toBe('—');
  });
  it('JSON-stringifies an object payload', () => {
    expect(fmtAuditDetails({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
  it('caps the preview at 100 chars', () => {
    const out = fmtAuditDetails({ k: 'z'.repeat(300) });
    expect(out.length).toBe(100);
  });
});
