import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  extractLaunchUsage,
  extractSampleContext,
  isLaunchCandidate,
  median,
  percentile,
  summarizeByDay,
  summarizeOverall,
  utcDay,
  type LaunchSample,
} from './launch-cost-metrics';

function sample(overrides: Partial<LaunchSample> & { totalPromptTokens: number }): LaunchSample {
  return {
    ownerId: 'su-test',
    sessionId: 'session-test',
    filePath: '/tmp/session-test.jsonl',
    timestamp: '2026-09-18T06:00:00.000Z',
    day: '2026-09-18',
    model: 'claude-opus-5',
    entrypoint: 'cli',
    cliVersion: '1.0.0',
    cwd: '/repo',
    lineNumber: 20,
    bytesBeforeSample: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  };
}

describe('percentile', () => {
  it('uses linear interpolation between closest ranks (R type 7 / numpy default)', () => {
    // Hand-computed against the type-7 definition so the constants are independently checkable:
    // for n=5, rank = p*(n-1). p=0.10 -> rank 0.4 -> 1 + (2-1)*0.4 = 1.4.
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 0.1)).toBeCloseTo(1.4, 10);
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.9)).toBeCloseTo(4.6, 10);
    expect(percentile(values, 1)).toBe(5);
  });

  it('returns the conventional mean-of-two-middles median for an even sample', () => {
    // This is the property that motivated type-7 over nearest-rank: a nearest-rank median of
    // [10,20,30,40] is 20, which would silently disagree with any median computed elsewhere.
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('does not require sorted input', () => {
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  it('handles a single sample', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('throws rather than inventing a value for an empty sample set', () => {
    // A percentile over no data must not be representable as a number: the whole plan is graded
    // on a median moving DOWN, so a zero here would read as total success.
    expect(() => percentile([], 0.5)).toThrow(/empty sample set/);
  });

  it('rejects an out-of-range p', () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(/\[0,1\]/);
  });
});

describe('extractLaunchUsage', () => {
  it('sums all three prompt-side fields, not input_tokens alone', () => {
    // The measured real shape: a cached launch turn reports input_tokens: 2 while actually
    // paying ~232k. Reading input_tokens alone reports that launch as 2.
    const usage = extractLaunchUsage({
      message: {
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 128_745,
          cache_read_input_tokens: 103_666,
          output_tokens: 296,
        },
      },
    });
    expect(usage).toEqual({
      inputTokens: 2,
      cacheCreationTokens: 128_745,
      cacheReadTokens: 103_666,
      totalPromptTokens: 232_413,
    });
  });

  it('returns null when there is no usage object', () => {
    expect(extractLaunchUsage({ type: 'user', message: { content: 'hi' } })).toBeNull();
    expect(extractLaunchUsage({ type: 'user' })).toBeNull();
    expect(extractLaunchUsage(null)).toBeNull();
    expect(extractLaunchUsage('not an object')).toBeNull();
    expect(extractLaunchUsage([{ message: { usage: {} } }])).toBeNull();
  });

  it('treats missing individual fields as zero rather than throwing', () => {
    const usage = extractLaunchUsage({ message: { usage: { input_tokens: 5 } } });
    expect(usage).toEqual({
      inputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalPromptTokens: 5,
    });
  });

  it('ignores non-numeric and non-finite field values', () => {
    const usage = extractLaunchUsage({
      message: { usage: { input_tokens: '900', cache_read_input_tokens: Number.NaN } },
    });
    expect(usage?.totalPromptTokens).toBe(0);
  });
});

describe('isLaunchCandidate', () => {
  const big = {
    inputTokens: 2,
    cacheCreationTokens: 100_000,
    cacheReadTokens: 100_000,
    totalPromptTokens: 200_002,
  };
  const tiny = {
    inputTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalPromptTokens: 40,
  };

  it('accepts a large non-sidechain turn', () => {
    expect(isLaunchCandidate({ isSidechain: false }, big)).toBe(true);
  });

  it('rejects a turn at or below the token floor', () => {
    expect(isLaunchCandidate({}, tiny)).toBe(false);
    expect(
      isLaunchCandidate({}, { ...tiny, totalPromptTokens: DEFAULT_MIN_PROMPT_TOKENS }),
    ).toBe(false);
    expect(
      isLaunchCandidate({}, { ...tiny, totalPromptTokens: DEFAULT_MIN_PROMPT_TOKENS + 1 }),
    ).toBe(true);
  });

  it('rejects sidechain turns by default and accepts them when asked', () => {
    expect(isLaunchCandidate({ isSidechain: true }, big)).toBe(false);
    expect(isLaunchCandidate({ isSidechain: true }, big, { includeSidechains: true })).toBe(true);
  });
});

describe('utcDay', () => {
  it('derives a UTC day, not a local one', () => {
    // 03:00Z on the 18th is still the 17th in this box's local -04:00 offset. The instrument
    // groups in UTC so its days line up with Papercusp timestamps rather than the host's TZ.
    expect(utcDay('2026-09-18T03:00:00.000Z')).toBe('2026-09-18');
    expect(utcDay('2026-09-18T00:30:00.000Z')).toBe('2026-09-18');
  });

  it('returns null rather than inventing a day for an unparseable timestamp', () => {
    expect(utcDay('not a date')).toBeNull();
    expect(utcDay(null)).toBeNull();
    expect(utcDay(undefined)).toBeNull();
    expect(utcDay('')).toBeNull();
  });
});

describe('extractSampleContext', () => {
  it('reads the descriptive fields and falls back from sessionId to session_id', () => {
    expect(
      extractSampleContext({
        timestamp: '2026-09-18T06:31:53.858Z',
        entrypoint: 'cli',
        version: '2.1.0',
        cwd: '/repo',
        session_id: 'legacy-id',
        message: { model: 'claude-opus-5' },
      }),
    ).toEqual({
      timestamp: '2026-09-18T06:31:53.858Z',
      model: 'claude-opus-5',
      entrypoint: 'cli',
      cliVersion: '2.1.0',
      cwd: '/repo',
      sessionId: 'legacy-id',
    });
  });

  it('returns nulls, not undefined or empty strings, for absent fields', () => {
    expect(extractSampleContext({})).toEqual({
      timestamp: null,
      model: null,
      entrypoint: null,
      cliVersion: null,
      cwd: null,
      sessionId: null,
    });
  });
});

describe('summarizeOverall', () => {
  it('returns null for an empty sample set instead of a zero-filled record', () => {
    // The load-bearing assertion of this file. A zero-filled summary over no data reads as
    // "launch cost is 0" — a spectacular apparent success — and is indistinguishable at the
    // call site from a real measurement.
    expect(summarizeOverall([])).toBeNull();
  });

  it('computes totals and the cache split', () => {
    const stats = summarizeOverall([
      sample({ totalPromptTokens: 100, cacheReadTokens: 60, cacheCreationTokens: 40 }),
      sample({ totalPromptTokens: 200, cacheReadTokens: 120, cacheCreationTokens: 80 }),
      sample({ totalPromptTokens: 300, cacheReadTokens: 180, cacheCreationTokens: 120 }),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.medianTotal).toBe(200);
    expect(stats!.minTotal).toBe(100);
    expect(stats!.maxTotal).toBe(300);
    expect(stats!.medianCacheRead).toBe(120);
    expect(stats!.medianCacheCreation).toBe(80);
  });
});

describe('summarizeByDay', () => {
  it('groups by UTC day, ascending, without zero-filling absent days', () => {
    const days = summarizeByDay([
      sample({ day: '2026-09-18', totalPromptTokens: 300 }),
      sample({ day: '2026-09-11', totalPromptTokens: 100 }),
      sample({ day: '2026-09-11', totalPromptTokens: 200 }),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-09-11', '2026-09-18']);
    expect(days[0]!.count).toBe(2);
    expect(days[0]!.medianTotal).toBe(150);
    expect(days[1]!.count).toBe(1);
    expect(days[1]!.medianTotal).toBe(300);
    // 2026-09-12..17 had no samples and must be ABSENT, not present with zeros — a zero-valued
    // day in a downward-trending report would look like the best day on record.
    expect(days).toHaveLength(2);
  });

  it('returns an empty array, not a fabricated day, for no samples', () => {
    expect(summarizeByDay([])).toEqual([]);
  });
});
