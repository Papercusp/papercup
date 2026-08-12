/**
 * testing:runs — plan sql-escape-tool-routing-2026-08-12 P-004.
 *
 * The matcher shapes and the saturation classifier are the parts that decide
 * whether a caller gets the right ROWS; the SQL around them is exercised
 * against the live table during development. The classifier's NULL case is the
 * one with a documented failure mode, so it is asserted directly.
 */

import { describe, it, expect } from 'vitest';
import { isSaturationSuspect, toPathPattern, toShaPattern } from './runs';
import { CRITICAL_P95_MS } from '../../event-loop-lag-monitor';

describe('toPathPattern', () => {
  it('matches a memorable path FRAGMENT as a substring — the corpus shape', () => {
    // Corpus: WHERE file_path LIKE '%release-submodule-freshness-fail-closed%'
    expect(toPathPattern('release-submodule-freshness')).toBe('%release-submodule-freshness%');
  });

  it('honours an explicit pattern verbatim', () => {
    expect(toPathPattern('packages/%/lib/x.test.ts')).toBe('packages/%/lib/x.test.ts');
  });
});

describe('toShaPattern', () => {
  it('treats a short sha as a PREFIX — the column holds the full 40 chars', () => {
    // Corpus: WHERE commit_sha LIKE '362398846fd2%'
    expect(toShaPattern('362398846fd2')).toBe('362398846fd2%');
  });

  it('honours an explicit pattern verbatim', () => {
    expect(toShaPattern('%362398%')).toBe('%362398%');
  });
});

describe('isSaturationSuspect', () => {
  it('does NOT treat a NULL lag sample as suspect', () => {
    // The column comment is emphatic: NULL means no monitor was running on
    // that process — it is NOT a claim the host was calm. Treating NULL as
    // suspect would quietly mark most historical rows unreliable and give
    // every red an excuse, which is the "blame high load" failure inverted.
    expect(isSaturationSuspect(null)).toBe(false);
  });

  it('flags a sample at or past the critical band', () => {
    expect(isSaturationSuspect(CRITICAL_P95_MS)).toBe(true);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 500)).toBe(true);
  });

  it('leaves a calm sample unflagged', () => {
    // Real observed values on this box sit around 20-25ms.
    expect(isSaturationSuspect(25)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 1)).toBe(false);
  });

  it('classifies against the monitor’s own tunable, not a hardcoded 600', () => {
    // Guards the drift this import exists to prevent: if the monitor's band
    // moves (PAPERCUSP_LOOP_CRITICAL_MS), the ledger reader must move with it.
    // A control value derived from the constant cannot pass against a
    // hardcoded threshold unless the two agree.
    expect(CRITICAL_P95_MS).toBeGreaterThan(0);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 0.5)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 0.5)).toBe(true);
  });
});
