// @vitest-environment jsdom
//
// SqlTab — the read-only SQL playground. Its grid renders raw result cells via
// renderCell, the one pure helper carrying display behavior (null sentinel,
// boolean/number stringify, 200-char truncation, JSON fallback). It's extracted
// + exported and pinned here. The rest of the tab is a Monaco editor + fetch
// shell (effect-only); Monaco/nuqs/Select/grid are mocked so the module imports.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/router-compat/dynamic', () => ({ default: () => () => null }));
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('nuqs', () => ({
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));

import { renderCell } from './SqlTab';

describe('renderCell', () => {
  it('renders ∅ for null and undefined', () => {
    expect(renderCell(null)).toBe('∅');
    expect(renderCell(undefined)).toBe('∅');
  });
  it('stringifies booleans and numbers', () => {
    expect(renderCell(true)).toBe('true');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(42)).toBe('42');
    expect(renderCell(0)).toBe('0');
  });
  it('passes short strings through unchanged', () => {
    expect(renderCell('hello')).toBe('hello');
  });
  it('truncates strings longer than 200 chars to 197 + ellipsis', () => {
    const out = renderCell('z'.repeat(300));
    expect(out).toBe('z'.repeat(197) + '…');
    expect(out.length).toBe(198);
  });
  it('JSON-stringifies objects and arrays', () => {
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
    expect(renderCell([1, 2])).toBe('[1,2]');
  });
  it('truncates long JSON output too', () => {
    const out = renderCell({ k: 'q'.repeat(300) });
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(198);
  });
});
