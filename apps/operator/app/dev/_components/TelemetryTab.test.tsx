// @vitest-environment jsdom
//
// TelemetryTab — the per-tool latency/error aggregation grid. Two genuine
// pure surfaces are pinned: errPct (error rate as a 0-safe percentage, which
// drives both the Err% value and its >10% red threshold) and nextTransportParam
// (the comma-separated transport URL-filter set arithmetic — add/remove, empty
// → ''). Both are extracted + exported; the data fetch + grid are an
// effect-only shell. grid/nuqs/primitives mocked so the module imports.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('nuqs', () => ({
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Checkbox', () => ({ Checkbox: () => null }));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));

import { errPct, nextTransportParam } from './TelemetryTab';

describe('errPct', () => {
  it('returns 0 for zero calls (no divide by zero)', () => {
    expect(errPct(0, 0)).toBe(0);
    expect(errPct(0, 5)).toBe(0);
  });
  it('computes the error rate as a percentage', () => {
    expect(errPct(10, 1)).toBe(10);
    expect(errPct(4, 1)).toBe(25);
    expect(errPct(3, 3)).toBe(100);
  });
});

describe('nextTransportParam', () => {
  it('adds a transport to an empty filter', () => {
    expect(nextTransportParam('', 'http')).toBe('http');
    expect(nextTransportParam(null, 'mcp')).toBe('mcp');
  });
  it('appends a second transport, preserving the first', () => {
    expect(nextTransportParam('http', 'mcp')).toBe('http,mcp');
  });
  it('removes a transport already in the filter', () => {
    expect(nextTransportParam('http,mcp', 'http')).toBe('mcp');
  });
  it('collapses to "" (no filter) when the last transport is removed', () => {
    expect(nextTransportParam('ipc', 'ipc')).toBe('');
  });
});
