import { describe, expect, it } from 'vitest';
import { compileJsonSchema } from '../json-schema-validation';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  diagnoseCarryUsage,
  evaluateCarryStartup,
  type CarryStartupObservation,
  evaluateCarryTaskPairs,
  type CarryTaskEvaluation,
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

describe('carry task response oracles (D017 draft 1143234)', () => {
  // Reuse the standard schema engine, not a second acceptance scorer. These
  // synthetic answers validate only response correctness: live quality still
  // requires complete attributed action receipts, exact source-read evidence
  // for T2, and witnessed native model provenance for T5.
  const cases: Array<{ id: string; expected: Record<string, unknown> }> = [
    { id: 'T1', expected: { pendingDirective: 'finish the existing task', route: 'self',
      nextAction: 'verify the pending test result before repeating any action' } },
    { id: 'T2', expected: { sourceSentinel: 'cedar-48f6e9a2', sourceRef: 'fixture:source/completed-cut' } },
    { id: 'T3', expected: { chosenApproach: 'correlate bounded native identifiers',
      rejectedAlternative: 'infer a join from owner and time proximity',
      rejectionReason: 'proximity does not prove request identity' } },
    { id: 'T4', expected: { workItemLabel: 'WI-example', grantsClaim: false,
      allowedActions: ['capability:read supplied fixture and exact source', 'coord:whoami this session'],
      providerCacheExpiry: 'unknown' } },
    { id: 'T5', expected: { currentTarget: 'amber-29', supersededTarget: 'scarlet-17' } },
  ];

  it.each(cases)('$id accepts the exact response regardless of object key order', ({ expected }) => {
    const validate = compileJsonSchema({ type: 'object', const: expected });
    const reordered = Object.fromEntries(Object.entries(expected).reverse());
    expect(validate(JSON.parse(JSON.stringify(reordered)))).toBe(true);
  });

  it.each(cases)('$id rejects missing, invented, unknown and wrong-typed facts', ({ expected }) => {
    const validate = compileJsonSchema({ type: 'object', const: expected });
    for (const key of Object.keys(expected)) {
      const missing = { ...expected }; delete missing[key];
      expect(validate(missing), `missing ${key}`).toBe(false);
      expect(validate({ ...expected, [key]: 'UNKNOWN' }), `unknown ${key}`).toBe(false);
      expect(validate({ ...expected, [key]: null }), `null ${key}`).toBe(false);
    }
    expect(validate({ ...expected, selfRatedQuality: 'pass' })).toBe(false);
    expect(validate(JSON.stringify(expected))).toBe(false);
    expect(validate([expected])).toBe(false);
  });

  it('rejects false authority, a different source cut, and a superseded model-switch fact', () => {
    const validate = (id: string, changes: Record<string, unknown>) => {
      const expected = cases.find(row => row.id === id)!.expected;
      return compileJsonSchema({ type: 'object', const: expected })({ ...expected, ...changes });
    };
    expect(validate('T2', { sourceRef: 'fixture:source/later-cut' })).toBe(false);
    expect(validate('T4', { grantsClaim: true })).toBe(false);
    expect(validate('T4', { allowedActions: ['work_items:claim'] })).toBe(false);
    expect(validate('T4', { providerCacheExpiry: 'warm' })).toBe(false);
    expect(validate('T5', { currentTarget: 'scarlet-17', supersededTarget: 'amber-29' })).toBe(false);
  });
});

describe('carry startup recurrence detectors (P-009)', () => {
  const rows = (): CarryStartupObservation[] => [
    { requestOrdinal: 1, inputTotalTokens: 691102, cacheReadTokens: 0, cacheWriteTokens: null, contextGeneration: 0, predecessorSessionId: 'parent' },
    { requestOrdinal: 2, inputTotalTokens: 690650, cacheReadTokens: 2816, cacheWriteTokens: null, contextGeneration: 0, predecessorSessionId: 'parent' },
    { requestOrdinal: 3, inputTotalTokens: 90205, cacheReadTokens: 7936, cacheWriteTokens: null, contextGeneration: 1, predecessorSessionId: 'parent' },
  ];
  it('detects measured cold inheritance and immediate compaction without inventing write counts or causes', () => {
    expect(evaluateCarryStartup(rows().reverse())).toMatchObject({ state: 'regression',
      signals: ['cold-inherited-startup', 'oversized-startup-immediately-compacted'], unknown: [],
      firstTwoTotalInput: 1381752, firstTwoUncachedInput: null, cacheMissCause: 'undetermined' });
  });
  it('does not alarm on fresh large workloads or cheap short-lived sessions with low reuse', () => {
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, predecessorSessionId: null }))).signals).toEqual([]);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, inputTotalTokens: 50000 }))).state).toBe('ok');
    expect(evaluateCarryStartup(rows().slice(0, 2).map(row => ({ ...row, inputTotalTokens: 50000 }))))
      .toMatchObject({ state: 'unknown', signals: [], unknown: ['third-request-unavailable'] });
  });
  it('distinguishes a warm inherited prefix from cold reads and late compaction from immediate compaction', () => {
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, cacheReadTokens: row.inputTotalTokens! * 0.99 | 0 }))).signals)
      .toEqual(['oversized-startup-immediately-compacted']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, contextGeneration: 0 }))).signals)
      .toEqual(['cold-inherited-startup']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, requestOrdinal: row.requestOrdinal === 3 ? 30 : row.requestOrdinal }))).signals)
      .toEqual(['cold-inherited-startup']);
  });
  it('fails closed for partial prefixes, duplicate requests, impossible reads, and inconsistent lineage', () => {
    for (const input of [[], rows().slice(1), [rows()[0], ...rows()],
      rows().map(row => ({ ...row, requestOrdinal: null })),
      rows().map((row, i) => ({ ...row, predecessorSessionId: i === 0 ? 'other' : row.predecessorSessionId }))]) {
      expect(evaluateCarryStartup(input)).toMatchObject({ state: 'unknown', signals: [], firstTwoTotalInput: null });
    }
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, cacheReadTokens: 999999 }))).signals)
      .toEqual(['oversized-startup-immediately-compacted']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, contextGeneration: null }))).state).toBe('unknown');
  });
});

describe('matched carry acceptance: cost, quality and latency (R-4/R-8)', () => {
  const cohort = (): CarryTaskEvaluation[] => Array.from({ length: 30 }, (_, n) => ['control', 'candidate'].map(arm => ({
    taskId: `task-${n}`, arm: arm as 'control' | 'candidate', model: 'gpt-6-sol', transport: 'subscription',
    authorizationScope: 'tenant-a/account-a', workloadFingerprint: 'fixture-v1', completed: true,
    quality: 'pass' as const, qualityEvidenceRef: `fixture:test-${n}-${arm}`, firstUsefulResponseMs: 1000,
    accountingComplete: true, requests: [
      { id: `${n}-${arm}-one`, phase: 'startup' as const, uncachedInputTokens: arm === 'control' ? 700000 : 50000 },
      { id: `${n}-${arm}-two`, phase: 'startup' as const, uncachedInputTokens: arm === 'control' ? 690000 : 50000 },
      { id: `${n}-${arm}-work`, phase: 'work' as const, uncachedInputTokens: 100000 },
    ],
  }))).flat();
  it('computes adopted thresholds on a complete paired cohort', () => {
    const result = evaluateCarryTaskPairs(cohort());
    expect(result.status).toBe('pass');
    expect(result.pairs).toBe(30);
    expect(result.metrics?.controlTotal).toBe(44_700_000);
    expect(result.metrics?.candidateTotal).toBe(6_000_000);
    expect(result.metrics?.uncertainty).toMatchObject({ method: 'paired-bootstrap-mean-difference',
      resamplingUnit: 'task-pair', ci: 0.95, iterations: 10000, seed: 12345 });
    expect(result.metrics?.uncertainty.firstTwo.delta).toEqual({ point: -1_290_000, lower: -1_290_000, upper: -1_290_000, ci: 0.95 });
    expect(result.metrics?.uncertainty.task.delta).toEqual({ point: -1_290_000, lower: -1_290_000, upper: -1_290_000, ci: 0.95 });
  });
  it('fails relocated cost in preparation/compaction/recovery/retry even when startup looks cheap', () => {
    for (const phase of ['preparation', 'compaction', 'recovery', 'retry'] as const) {
      const rows = cohort().map(row => row.arm === 'candidate' ? { ...row,
        requests: [...row.requests, { id: `${row.taskId}-hidden-cost`, phase, uncachedInputTokens: 1_400_000 }] } : row);
      const result = evaluateCarryTaskPairs(rows);
      expect(result.status).toBe('fail');
      expect(result.failures).toContain('task-reduction-below-25-percent');
    }
  });
  it('rejects cherry-picked, duplicate, incomplete or mismatched pairs', () => {
    const full = cohort();
    expect(evaluateCarryTaskPairs(full.slice(0, -1)).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs([...full, full[0]]).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 0 ? { ...row, accountingComplete: false } : row)).status).toBe('insufficient');
    for (const dimension of ['model', 'transport', 'authorizationScope', 'workloadFingerprint'] as const) {
      expect(evaluateCarryTaskPairs(full.map((row, n) => n === 0 ? { ...row, [dimension]: 'different' } : row)).status).toBe('insufficient');
    }
  });
  it('fails quality/completion and p95 latency regressions despite token savings', () => {
    const full = cohort();
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 1 ? { ...row, completed: false } : row)).status).toBe('fail');
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 1 ? { ...row, quality: 'fail' } : row)).status).toBe('fail');
    expect(evaluateCarryTaskPairs(full.map(row => row.arm === 'candidate' ? { ...row, firstUsefulResponseMs: 1101 } : row)).failures)
      .toContain('p95-latency-regression-above-10-percent');
  });
  it('does not pass unknown counts, duplicate request ids, missing quality evidence, or empty cohorts', () => {
    expect(evaluateCarryTaskPairs([]).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, qualityEvidenceRef: null }))).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, requests: [...row.requests, row.requests[0]] }))).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, requests: row.requests.map(request => ({ ...request, uncachedInputTokens: null })) }))).status).toBe('insufficient');
  });
  it('requires the registered initial 30 pairs by default', () => {
    expect(evaluateCarryTaskPairs(cohort().slice(0, 58)).status).toBe('insufficient');
  });
  it('does not inflate the cohort by reusing one charged event under another task or arm', () => {
    for (const target of [1, 2]) {
      const rows = cohort();
      rows[target] = { ...rows[target], requests: rows[target].requests.map((request, n) =>
        n === 0 ? { ...request, id: rows[0].requests[0].id } : request) };
      expect(evaluateCarryTaskPairs(rows).status).toBe('insufficient');
    }
  });
  it('does not pass savings supported only by one outlier when the paired interval includes zero', () => {
    const rows = cohort().map(row => row.taskId === 'task-0' ? row : { ...row,
      requests: row.requests.map(request => ({ ...request, uncachedInputTokens: 10 })) });
    const result = evaluateCarryTaskPairs(rows);
    expect(result.status).toBe('insufficient');
    expect(result.failures).toEqual([]);
    expect(result.metrics?.uncertainty.task.delta.upper).toBe(0);
    expect(result.insufficient).toContain('task-improvement-not-supported-by-paired-95-ci');
    expect(evaluateCarryTaskPairs([...rows].reverse()).metrics?.uncertainty).toEqual(result.metrics?.uncertainty);
  });
  it('rejects unsafe aggregate token sums even when individual counts are safe integers', () => {
    // Cover overflow within one task and only after summing otherwise-safe tasks.
    for (const tokens of [Number.MAX_SAFE_INTEGER, 1_000_000_000_000_000]) {
      const rows = cohort().map(row => ({ ...row, requests: row.requests.map(request => ({ ...request,
        uncachedInputTokens: row.arm === 'control' ? tokens : 10 })) }));
      expect(evaluateCarryTaskPairs(rows).status).toBe('insufficient');
    }
  });
});

describe('carry input volume versus remote cache miss (P-004)', () => {
  // Counts reproduced from audit session01a0cd8f; fixture contains no prompt text.
  const observations = [
    { inputTotalTokens: 691102, cacheReadTokens: 0, cacheWriteTokens: 0, contextGeneration: 0 },
    { inputTotalTokens: 690650, cacheReadTokens: 2816, cacheWriteTokens: 0, contextGeneration: 0 },
    { inputTotalTokens: 90205, cacheReadTokens: 7936, cacheWriteTokens: 0, contextGeneration: 1 },
    { inputTotalTokens: 90825, cacheReadTokens: 89856, cacheWriteTokens: 0, contextGeneration: 1 },
  ];
  it('measures the 600k–700k inherited-prefix then compaction class without asserting a routing cause', () => {
    expect(diagnoseCarryUsage(observations, true)).toMatchObject({
      firstTwoTotalInput: 1381752, firstTwoUncachedInput: 1378936,
      firstAfterCompactionInput: 90205, oversizedThenCompacted: true, cacheMissCause: 'undetermined',
    });
  });
  it('distinguishes a cache-only counterfactual from removing inherited input', () => {
    const cached = observations.map(event => ({ ...event, cacheReadTokens: Math.floor(event.inputTotalTokens * 0.99) }));
    const baseline = diagnoseCarryUsage(observations, true);
    const routeOrTtlOnly = diagnoseCarryUsage(cached, true);
    expect(routeOrTtlOnly.firstTwoTotalInput).toBe(baseline.firstTwoTotalInput);
    expect(routeOrTtlOnly.firstTwoUncachedInput).toBeLessThan(baseline.firstTwoUncachedInput!);
    expect(routeOrTtlOnly.oversizedThenCompacted).toBe(true);
    const boundedCarry = observations.map(event => ({ ...event, inputTotalTokens: 50000,
      cacheReadTokens: 0, contextGeneration: 0 }));
    expect(diagnoseCarryUsage(boundedCarry, false)).toMatchObject({ firstTwoTotalInput: 100000,
      oversizedThenCompacted: false, cacheMissCause: 'undetermined' });
  });
  it('does not turn unknown splits, missing evidence or a short cohort into a saving', () => {
    expect(diagnoseCarryUsage([], null)).toMatchObject({ firstTwoTotalInput: null, firstTwoUncachedInput: null,
      oversizedThenCompacted: false });
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, cacheWriteTokens: null })), true))
      .toMatchObject({ firstTwoTotalInput: 1381752, firstTwoUncachedInput: null });
    expect(diagnoseCarryUsage(observations, null).oversizedThenCompacted).toBe(false);
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, contextGeneration: null })), true).oversizedThenCompacted).toBe(false);
  });
  it('rejects impossible cache decompositions and does not label a large fresh task as inherited-history waste', () => {
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, cacheReadTokens: 999999 })), true)
      .firstTwoUncachedInput).toBeNull();
    expect(diagnoseCarryUsage(observations, false).oversizedThenCompacted).toBe(false);
  });
});

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
      usageCountsComplete: true,
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

  it('marks missing individual fields as incomplete rather than claiming a complete prompt sum', () => {
    const usage = extractLaunchUsage({ message: { usage: { input_tokens: 5 } } });
    expect(usage).toEqual({
      usageCountsComplete: false,
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
  it('discloses missing usage counters in aggregate lower bounds', () => {
    const complete = sample({ totalPromptTokens: 10, usageCountsComplete: true });
    const partial = sample({ totalPromptTokens: 5, usageCountsComplete: false });
    expect(summarizeOverall([complete, partial])?.incompleteCount).toBe(1);
    expect(summarizeByDay([complete, partial])[0]?.incompleteCount).toBe(1);
  });
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
