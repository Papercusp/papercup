/**
 * invalid-args-miner.test.ts — WI-5017.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractOffendingKey,
  planInvalidArgsSignals,
  runInvalidArgsMinerTick,
  type InvalidArgsRow,
} from './invalid-args-miner';
import type { CaptureImprovementResult } from './capture-core';

describe('extractOffendingKey', () => {
  it('extracts the key from a path-prefixed message', () => {
    expect(extractOffendingKey('coordNotes: Required')).toBe('coordNotes');
    expect(extractOffendingKey('id: Expected string, received number')).toBe('id');
  });

  it('extracts the leading top-level segment of a dotted/nested path', () => {
    expect(extractOffendingKey('verification.testResult: Expected string, received undefined')).toBe('verification');
  });

  it('extracts the key from a root-level "Unrecognized key(s)" message (no path)', () => {
    expect(extractOffendingKey(`Unrecognized key(s) in object: 'unreadOnly'`)).toBe('unreadOnly');
    expect(extractOffendingKey(`Unrecognized key: "unreadOnly"`)).toBe('unreadOnly');
  });

  it('takes only the FIRST clause of a joined multi-issue message', () => {
    expect(extractOffendingKey('foo: Required; bar: Expected string')).toBe('foo');
  });

  it('returns null for an unparseable message, empty, or missing message', () => {
    expect(extractOffendingKey('totally free-form text with no colon-path')).toBeNull();
    expect(extractOffendingKey('')).toBeNull();
    expect(extractOffendingKey(null)).toBeNull();
    expect(extractOffendingKey(undefined)).toBeNull();
  });

  // EI-22170146677569151: define-tool.ts's dispatch-stack path prefixes the
  // literal error CODE onto the message text (`invalid_args: ${formatIssues(...)}`),
  // which the naive path regex mistook for the offending field (9 of the top
  // 12 mined pairs in production carried this pseudo-key instead of a real one).
  it('strips a leading "invalid_args:" code prefix and finds the real path underneath', () => {
    expect(extractOffendingKey('invalid_args: coordNotes: Required')).toBe('coordNotes');
    expect(extractOffendingKey('invalid_args: id: Expected string, received number; foo: Required')).toBe('id');
  });

  it('strips a leading "invalid_input:" code prefix and finds the real path underneath', () => {
    expect(extractOffendingKey('invalid_input: threadLimit: Expected number, received string')).toBe('threadLimit');
  });

  it('returns null (not the code) when a code prefix has no real path underneath', () => {
    expect(extractOffendingKey('invalid_args: totally free-form text with no colon-path')).toBeNull();
  });
});

function row(overrides: Partial<InvalidArgsRow> = {}): InvalidArgsRow {
  return {
    tool_name: 'coord:inbox',
    error_message: 'unreadOnly: Unrecognized key(s) in object: \'unreadOnly\'',
    args_json: { limit: 5, unreadOnly: true },
    coord_owner_id: 'su-aaa',
    invoked_at: new Date('2026-07-10T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('planInvalidArgsSignals', () => {
  it('files a (tool, key) pair once it clears the DISTINCT-OWNERS bar, even below the occurrence bar', () => {
    const rows = [
      row({ coord_owner_id: 'su-a' }),
      row({ coord_owner_id: 'su-b' }),
      row({ coord_owner_id: 'su-c' }),
    ];
    const out = planInvalidArgsSignals(rows, { minDistinctOwners: 3, minOccurrences: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: 'coord:inbox', key: 'unreadOnly', count: 3, distinctOwners: 3 });
  });

  it('files a (tool, key) pair once it clears the OCCURRENCE bar, even from a single caller', () => {
    const rows = Array.from({ length: 10 }, () => row({ coord_owner_id: 'su-solo' }));
    const out = planInvalidArgsSignals(rows, { minDistinctOwners: 3, minOccurrences: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: 'coord:inbox', key: 'unreadOnly', count: 10, distinctOwners: 1 });
  });

  it('does NOT file a pair that clears neither bar (kills one-off noise)', () => {
    const rows = [row({ coord_owner_id: 'su-a' }), row({ coord_owner_id: 'su-a' })];
    const out = planInvalidArgsSignals(rows, { minDistinctOwners: 3, minOccurrences: 10 });
    expect(out).toEqual([]);
  });

  it('excludes rows whose key could not be extracted', () => {
    const rows = Array.from({ length: 20 }, () => row({ error_message: 'no colon path here at all' }));
    expect(planInvalidArgsSignals(rows, { minOccurrences: 10 })).toEqual([]);
  });

  it('excludes the improvement loop\'s own tools (never files a bug about its own capture path)', () => {
    const rows = Array.from({ length: 20 }, () => row({ tool_name: 'improvements:capture' }));
    expect(planInvalidArgsSignals(rows, { minOccurrences: 10 })).toEqual([]);
  });

  it('keeps DISTINCT (tool, key) pairs separate, and the latest sample wins', () => {
    const rows = [
      row({ tool_name: 'toolA', error_message: 'foo: Required', coord_owner_id: 'su-a', invoked_at: '2026-07-01T00:00:00Z', args_json: { old: true } }),
      row({ tool_name: 'toolA', error_message: 'foo: Required', coord_owner_id: 'su-b', invoked_at: '2026-07-10T00:00:00Z', args_json: { fresh: true } }),
      row({ tool_name: 'toolA', error_message: 'bar: Required', coord_owner_id: 'su-c' }),
      row({ tool_name: 'toolB', error_message: 'foo: Required', coord_owner_id: 'su-d' }),
    ];
    const out = planInvalidArgsSignals(rows, { minDistinctOwners: 2, minOccurrences: 100 });
    expect(out).toHaveLength(1); // only toolA/foo clears 2 distinct owners
    expect(out[0]).toMatchObject({ tool: 'toolA', key: 'foo', distinctOwners: 2, sampleArgs: { fresh: true } });
  });

  it('sorts by distinct-owner count first, then occurrence count', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row({ tool_name: 'toolLowOwners', error_message: 'k1: Required', coord_owner_id: `su-${i}` })),
      ...Array.from({ length: 20 }, () => row({ tool_name: 'toolManyHits', error_message: 'k2: Required', coord_owner_id: 'su-solo' })),
    ];
    const out = planInvalidArgsSignals(rows, { minDistinctOwners: 3, minOccurrences: 10 });
    expect(out.map((o) => o.tool)).toEqual(['toolLowOwners', 'toolManyHits']); // 3 distinct owners ranks above 1
  });
});

describe('runInvalidArgsMinerTick', () => {
  const okResult = (created: boolean): CaptureImprovementResult => ({
    ok: true,
    created,
    possibleDuplicates: [],
    issue: created ? ({ id: 'EI-9999' } as CaptureImprovementResult['issue']) : undefined,
  });

  it('captures each candidate that clears the bar, with a stable watchdogKey + findingClass', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ coord_owner_id: `su-${i % 4}` }));
    const capture = vi.fn().mockResolvedValue(okResult(true));
    const result = await runInvalidArgsMinerTick('ws-1', { minDistinctOwners: 3, minOccurrences: 10 }, { rows, capture });
    expect(result).toMatchObject({ scanned: 10, candidates: 1, declined: 0, failed: 0 });
    expect(result.captured).toEqual(['EI-9999']);
    expect(capture).toHaveBeenCalledTimes(1);
    const [input] = capture.mock.calls[0];
    expect(input).toMatchObject({
      kind: 'change',
      severity: 'minor',
      dedupScope: 'open',
      sourceRole: 'system',
      watchdogKey: 'invalid-args-miner:coord:inbox:unreadOnly',
      findingClass: 'invalid-args-miner:coord:inbox:unreadOnly',
    });
    expect(input.title).toContain('coord:inbox');
    expect(input.title).toContain('unreadOnly');
  });

  it('counts a declined (likely-duplicate) capture separately from a captured one', async () => {
    const rows = Array.from({ length: 10 }, () => row());
    const capture = vi.fn().mockResolvedValue(okResult(false));
    const result = await runInvalidArgsMinerTick('ws-1', {}, { rows, capture });
    expect(result).toMatchObject({ candidates: 1, declined: 1, captured: [] });
  });

  it('a capture failure is counted, never thrown, and never blocks the rest of the tick', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [
      ...Array.from({ length: 10 }, () => row({ tool_name: 'toolA', error_message: 'x: Required' })),
      ...Array.from({ length: 10 }, () => row({ tool_name: 'toolB', error_message: 'y: Required' })),
    ];
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(okResult(true));
    const result = await runInvalidArgsMinerTick('ws-1', {}, { rows, capture });
    expect(result.candidates).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.captured).toEqual(['EI-9999']);
  });

  it('respects maxPerTick, keeping the highest-signal candidates', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => row({ tool_name: 'toolLow', error_message: 'k1: Required', coord_owner_id: `su-${i}` })),
      ...Array.from({ length: 20 }, () => row({ tool_name: 'toolHigh', error_message: 'k2: Required', coord_owner_id: 'su-solo' })),
    ];
    const capture = vi.fn().mockResolvedValue(okResult(true));
    const result = await runInvalidArgsMinerTick('ws-1', { minDistinctOwners: 3, minOccurrences: 10, maxPerTick: 1 }, { rows, capture });
    expect(result.candidates).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0].title).toContain('toolLow'); // 3 distinct owners outranks 20 same-caller hits
  });
});
