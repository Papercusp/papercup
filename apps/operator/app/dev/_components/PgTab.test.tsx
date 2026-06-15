// @vitest-environment jsdom
//
// PgTab — the Postgres connection / active-query / table-size inspector. The
// genuine pure logic is the two formatters it uses for the active-queries and
// table-size grids: fmtBytes (binary-prefix byte sizing) and fmtDuration
// (sub-second → multi-hour spans). Both are extracted + exported and pinned at
// their unit boundaries. The component body is an effect-only fetch shell over
// RichGrid, so only the formatters carry behavior worth pinning.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));

import { fmtBytes, fmtDuration } from './PgTab';

describe('fmtBytes', () => {
  it('renders raw bytes under 1KB', () => {
    expect(fmtBytes(0)).toBe('0B');
    expect(fmtBytes(512)).toBe('512B');
  });
  it('renders KB with one decimal', () => {
    expect(fmtBytes(2048)).toBe('2.0KB');
    expect(fmtBytes(1536)).toBe('1.5KB');
  });
  it('renders MB with one decimal', () => {
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0MB');
  });
  it('renders GB with two decimals past a gigabyte', () => {
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.00GB');
  });
});

describe('fmtDuration', () => {
  it('renders sub-second spans in milliseconds', () => {
    expect(fmtDuration(0.25)).toBe('250ms');
  });
  it('renders seconds with one decimal under a minute', () => {
    expect(fmtDuration(12.5)).toBe('12.5s');
  });
  it('renders "Nm Ss" between a minute and an hour', () => {
    expect(fmtDuration(125)).toBe('2m 5s');
  });
  it('renders whole hours past an hour', () => {
    expect(fmtDuration(2 * 3600 + 100)).toBe('2h');
  });
});
