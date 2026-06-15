// TestRunsTab — the desktop-first suite runner. The render is a large nuqs +
// fetch-polling shell (→ e2e), but three pure helpers carry display/grouping
// logic and are extracted + exported: formatCounts, formatMs, and
// groupResultsBySuite. Those are tested here branch-by-branch.

import { describe, expect, it } from 'vitest';
import { formatCounts, formatMs, groupResultsBySuite } from './TestRunsTab';
import type {
  AdminTestCheckResult,
  AdminTestStatus,
  AdminTestSuiteId,
} from '@papercusp/operator-core/lib/admin-test-suites-shared';

describe('formatCounts', () => {
  it('renders the pass/warn/fail/skip tally line', () => {
    const counts = { pass: 3, warn: 1, fail: 2, skip: 0 } as Record<AdminTestStatus, number>;
    expect(formatCounts(counts)).toBe('3 pass · 1 warn · 2 fail · 0 skip');
  });
});

describe('formatMs', () => {
  it('renders "0ms" for non-positive or non-finite input', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(-5)).toBe('0ms');
    expect(formatMs(NaN)).toBe('0ms');
  });
  it('rounds sub-second durations to whole ms', () => {
    expect(formatMs(123.7)).toBe('124ms');
    expect(formatMs(999)).toBe('999ms');
  });
  it('renders seconds with one decimal past a second', () => {
    expect(formatMs(1500)).toBe('1.5s');
    expect(formatMs(12_340)).toBe('12.3s');
  });
});

function check(over: Partial<AdminTestCheckResult> & { suiteId: string; id: string; label: string }): AdminTestCheckResult {
  return {
    status: 'pass', expected: '', actual: '', durationMs: 0,
    ...over,
    suiteId: over.suiteId as AdminTestSuiteId,
  };
}

describe('groupResultsBySuite', () => {
  it('returns an empty object for no results', () => {
    expect(groupResultsBySuite([])).toEqual({});
  });

  it('groups results by suiteId', () => {
    const grouped = groupResultsBySuite([
      check({ suiteId: 'desktop-health', id: 'a', label: 'A' }),
      check({ suiteId: 'memory-core', id: 'b', label: 'B' }),
      check({ suiteId: 'desktop-health', id: 'c', label: 'C' }),
    ]);
    expect(Object.keys(grouped).sort()).toEqual(['desktop-health', 'memory-core']);
    expect(grouped['desktop-health']).toHaveLength(2);
  });

  it('sorts each group by label (localeCompare)', () => {
    const grouped = groupResultsBySuite([
      check({ suiteId: 'desktop-health', id: 'z', label: 'Zebra' }),
      check({ suiteId: 'desktop-health', id: 'a', label: 'Apple' }),
      check({ suiteId: 'desktop-health', id: 'm', label: 'Mango' }),
    ]);
    expect(grouped['desktop-health'].map((r) => r.label)).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});
