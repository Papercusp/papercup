import { describe, expect, it } from 'vitest';
import {
  CHECK_RUN_CACHE_SCHEMA_VERSION,
  CHECK_RUN_CACHE_TTL_MS,
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  buildPrCheckStatusCacheRow,
  composeCacheKey,
  isCacheStale,
  isCheckRunComplete,
  isCheckRunEntry,
  isPrCheckStatusCacheRow,
  summarizeCheckRuns,
  type CheckRunEntry,
  type PrCheckStatusCacheRow,
} from './pr-check-status-cache-types';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function makeEntry(over: Partial<CheckRunEntry> = {}): CheckRunEntry {
  return {
    id: 100,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://github.com/x/y/runs/100',
    started_at: 1716_000_000_000,
    completed_at: 1716_000_001_000,
    ...over,
  };
}

function makeRow(over: Partial<PrCheckStatusCacheRow> = {}): PrCheckStatusCacheRow {
  return {
    workspace_id: 'ws1',
    harness_slug: 'papercup',
    head_sha: SHA1,
    check_runs: [makeEntry()],
    fetched_at: 1716_000_002_000,
    schema_version: 1,
    ...over,
  };
}

describe('constants', () => {
  it('CHECK_RUN_STATUSES has 3 values', () => {
    expect([...CHECK_RUN_STATUSES]).toEqual(['queued', 'in_progress', 'completed']);
  });

  it('CHECK_RUN_CONCLUSIONS has 8 values incl. action_required + stale', () => {
    expect(CHECK_RUN_CONCLUSIONS.length).toBe(8);
    expect([...CHECK_RUN_CONCLUSIONS]).toContain('success');
    expect([...CHECK_RUN_CONCLUSIONS]).toContain('action_required');
    expect([...CHECK_RUN_CONCLUSIONS]).toContain('stale');
  });

  it('CHECK_RUN_CACHE_TTL_MS is 60s per v5 §8.4 poll cadence', () => {
    expect(CHECK_RUN_CACHE_TTL_MS).toBe(60 * 1000);
  });

  it('CHECK_RUN_CACHE_SCHEMA_VERSION is 1', () => {
    expect(CHECK_RUN_CACHE_SCHEMA_VERSION).toBe(1);
  });
});

describe('isCheckRunEntry', () => {
  it('accepts well-formed completed entry', () => {
    expect(isCheckRunEntry(makeEntry())).toBe(true);
  });

  it('accepts in-progress entry (conclusion=null)', () => {
    expect(
      isCheckRunEntry(makeEntry({ status: 'in_progress', conclusion: null, completed_at: null })),
    ).toBe(true);
  });

  it('rejects unknown status', () => {
    expect(isCheckRunEntry({ ...makeEntry(), status: 'pending' })).toBe(false);
  });

  it('rejects unknown conclusion', () => {
    expect(isCheckRunEntry({ ...makeEntry(), conclusion: 'whatever' })).toBe(false);
  });

  it('rejects non-positive id + empty name', () => {
    expect(isCheckRunEntry(makeEntry({ id: 0 }))).toBe(false);
    expect(isCheckRunEntry(makeEntry({ name: '' }))).toBe(false);
  });

  it('accepts null details_url / started_at / completed_at', () => {
    expect(
      isCheckRunEntry(makeEntry({ details_url: null, started_at: null, completed_at: null })),
    ).toBe(true);
  });

  it('rejects non-object', () => {
    expect(isCheckRunEntry(null)).toBe(false);
    expect(isCheckRunEntry('x')).toBe(false);
  });
});

describe('isPrCheckStatusCacheRow', () => {
  it('accepts well-formed row with SHA-1', () => {
    expect(isPrCheckStatusCacheRow(makeRow())).toBe(true);
  });

  it('accepts SHA-256 head_sha', () => {
    expect(isPrCheckStatusCacheRow(makeRow({ head_sha: SHA256 }))).toBe(true);
  });

  it('rejects bad head_sha length', () => {
    expect(isPrCheckStatusCacheRow(makeRow({ head_sha: 'short' }))).toBe(false);
    expect(isPrCheckStatusCacheRow(makeRow({ head_sha: 'A'.repeat(40) }))).toBe(false);
  });

  it('rejects empty harness_slug', () => {
    expect(isPrCheckStatusCacheRow(makeRow({ harness_slug: '' }))).toBe(false);
  });

  it('accepts empty workspace_id (legacy default)', () => {
    expect(isPrCheckStatusCacheRow(makeRow({ workspace_id: '' }))).toBe(true);
  });

  it('rejects non-array check_runs', () => {
    expect(isPrCheckStatusCacheRow({ ...makeRow(), check_runs: 'no' })).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isPrCheckStatusCacheRow({ ...makeRow(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isPrCheckStatusCacheRow(null)).toBe(false);
  });
});

describe('isCacheStale', () => {
  const NOW = 1716_000_100_000;

  it('false when fetched within TTL', () => {
    expect(isCacheStale(makeRow({ fetched_at: NOW - 1000 }), NOW)).toBe(false);
  });

  it('true when fetched outside TTL', () => {
    expect(
      isCacheStale(makeRow({ fetched_at: NOW - CHECK_RUN_CACHE_TTL_MS - 1 }), NOW),
    ).toBe(true);
  });

  it('boundary: exactly TTL ago is NOT stale (strict greater-than)', () => {
    expect(
      isCacheStale(makeRow({ fetched_at: NOW - CHECK_RUN_CACHE_TTL_MS }), NOW),
    ).toBe(false);
  });

  it('respects custom TTL', () => {
    expect(isCacheStale(makeRow({ fetched_at: NOW - 1000 }), NOW, 500)).toBe(true);
    expect(isCacheStale(makeRow({ fetched_at: NOW - 100 }), NOW, 500)).toBe(false);
  });
});

describe('isCheckRunComplete', () => {
  it('true for status=completed', () => {
    expect(isCheckRunComplete(makeEntry({ status: 'completed' }))).toBe(true);
  });

  it('false for queued + in_progress', () => {
    expect(isCheckRunComplete(makeEntry({ status: 'queued', conclusion: null }))).toBe(false);
    expect(isCheckRunComplete(makeEntry({ status: 'in_progress', conclusion: null }))).toBe(false);
  });
});

describe('summarizeCheckRuns', () => {
  it('empty → unknown', () => {
    expect(summarizeCheckRuns([])).toBe('unknown');
  });

  it('all success → success', () => {
    expect(
      summarizeCheckRuns([
        makeEntry({ conclusion: 'success' }),
        makeEntry({ id: 2, conclusion: 'success' }),
      ]),
    ).toBe('success');
  });

  it('any in_progress → pending', () => {
    expect(
      summarizeCheckRuns([
        makeEntry({ conclusion: 'success' }),
        makeEntry({ id: 2, status: 'in_progress', conclusion: null, completed_at: null }),
      ]),
    ).toBe('pending');
  });

  it('any failure → failure (takes precedence over in_progress)', () => {
    expect(
      summarizeCheckRuns([
        makeEntry({ conclusion: 'failure' }),
        makeEntry({ id: 2, status: 'in_progress', conclusion: null, completed_at: null }),
      ]),
    ).toBe('failure');
  });

  it('timed_out + action_required → error', () => {
    expect(summarizeCheckRuns([makeEntry({ conclusion: 'timed_out' })])).toBe('error');
    expect(summarizeCheckRuns([makeEntry({ conclusion: 'action_required' })])).toBe('error');
  });

  it('cancelled only → cancelled', () => {
    expect(summarizeCheckRuns([makeEntry({ conclusion: 'cancelled' })])).toBe('cancelled');
  });

  it('failure > error > cancelled > pending > success precedence', () => {
    expect(
      summarizeCheckRuns([
        makeEntry({ conclusion: 'success' }),
        makeEntry({ id: 2, conclusion: 'cancelled' }),
        makeEntry({ id: 3, conclusion: 'timed_out' }),
        makeEntry({ id: 4, conclusion: 'failure' }),
      ]),
    ).toBe('failure');
  });

  it('skipped + neutral don\'t change success outcome', () => {
    expect(
      summarizeCheckRuns([
        makeEntry({ conclusion: 'success' }),
        makeEntry({ id: 2, conclusion: 'skipped' }),
        makeEntry({ id: 3, conclusion: 'neutral' }),
      ]),
    ).toBe('success');
  });
});

describe('composeCacheKey', () => {
  it('builds <workspace>:<harness>@<sha-first-7>', () => {
    expect(
      composeCacheKey({ workspace_id: 'ws1', harness_slug: 'papercup', head_sha: 'abcdef1234567890' + 'x'.repeat(24) }),
    ).toBe('ws1:papercup@abcdef1');
  });
});

describe('buildPrCheckStatusCacheRow', () => {
  it('builds a valid row', () => {
    const row = buildPrCheckStatusCacheRow({
      workspace_id: 'ws1',
      harness_slug: 'papercup',
      head_sha: SHA1,
      check_runs: [makeEntry()],
      now: 1716_000_000_000,
    });
    expect(row.workspace_id).toBe('ws1');
    expect(row.head_sha).toBe(SHA1);
    expect(row.fetched_at).toBe(1716_000_000_000);
    expect(row.schema_version).toBe(1);
  });

  it('defensive-copies the check_runs array', () => {
    const runs = [makeEntry()];
    const row = buildPrCheckStatusCacheRow({
      workspace_id: '',
      harness_slug: 'x',
      head_sha: SHA1,
      check_runs: runs,
      now: 1,
    });
    runs.push(makeEntry({ id: 2 }));
    expect(row.check_runs).toHaveLength(1);
  });

  it('rejects bad inputs', () => {
    expect(() =>
      buildPrCheckStatusCacheRow({
        workspace_id: '',
        harness_slug: '',
        head_sha: SHA1,
        check_runs: [],
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildPrCheckStatusCacheRow({
        workspace_id: '',
        harness_slug: 'x',
        head_sha: 'short',
        check_runs: [],
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('round-trips through isPrCheckStatusCacheRow', () => {
    const row = buildPrCheckStatusCacheRow({
      workspace_id: '',
      harness_slug: 'x',
      head_sha: SHA1,
      check_runs: [],
      now: 1,
    });
    expect(isPrCheckStatusCacheRow(row)).toBe(true);
  });
});
