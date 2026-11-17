/**
 * plan-efficiency.test.ts — the pure halves of the per-plan efficiency read
 * (review-system-rework-reduction-2026-09-23 P-032): the purpose categorizer and the fold of
 * grouped call rows. The SQL half is pinned against real Postgres in
 * plan-efficiency.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_EFFICIENCY_CATEGORIES, categorizePlanToolCall, foldPlanCallGroups,
  summarizeWorkflowStepUsage, unionWorkflowStepIntervals, type WorkflowStepSource,
  type WorkflowStepUsageRow } from './plan-efficiency';

describe('categorizePlanToolCall', () => {
  it.each([
    ['capability:bash', 'generic-exec'],
    ['code:run', 'generic-exec'],
    ['tools:invoke', 'generic-exec'],
    ['coord:send', 'coordination-carry'],
    ['loop:checkpoint', 'coordination-carry'],
    ['work_items:checkpoint', 'coordination-carry'],
    ['scheduler:get_next', 'coordination-carry'],
    ['plans:get', 'read-orient'],
    ['work_items:get', 'read-orient'],
    ['dev:pg_query', 'read-orient'],
    ['rubrics:amend', 'acceptance-ceremony'],
    ['scorecards:emit', 'acceptance-ceremony'],
    ['plans:set-plan-status', 'acceptance-ceremony'],
    ['plans:bind-spec-evidence', 'acceptance-ceremony'],
    ['release:checkpoint-run', 'gate-pipeline'],
    ['dev:pipeline_position', 'gate-pipeline'],
    ['testing:run', 'implementation-test'],
    ['capability:edit', 'implementation-test'],
    ['consult:get_feedback', 'other'],
  ] as const)('%s -> %s', (tool, category) => {
    expect(categorizePlanToolCall(tool)).toBe(category);
  });

  it('lets an exact name override its prefix', () => {
    // plans:* reads are read-orient, but the ship verb is acceptance ceremony;
    // work_items:* reads are read-orient, but checkpoints are carry.
    expect(categorizePlanToolCall('plans:items')).toBe('read-orient');
    expect(categorizePlanToolCall('plans:set-plan-status')).toBe('acceptance-ceremony');
    expect(categorizePlanToolCall('work_items:list')).toBe('read-orient');
    expect(categorizePlanToolCall('work_items:complete')).toBe('coordination-carry');
  });
});

describe('foldPlanCallGroups', () => {
  it('tallies categories, failures by class and dropped-item calls from grouped rows', () => {
    const folded = foldPlanCallGroups([
      { tool_name: 'capability:bash', status: 'ok', error_code: null, on_dropped: false, n: '5' },
      { tool_name: 'coord:send', status: 'ok', error_code: null, on_dropped: true, n: 2 },
      { tool_name: 'rubrics:amend', status: 'invalid-input', error_code: 'invalid_input', on_dropped: false, n: 3 },
      { tool_name: 'rubrics:amend', status: 'error', error_code: null, on_dropped: true, n: 1 },
      { tool_name: 'work_items:complete', status: 'replayed', error_code: null, on_dropped: false, n: 1 },
    ]);

    expect(folded.total).toBe(12);
    expect(folded.byCategory['generic-exec']).toBe(5);
    expect(folded.byCategory['coordination-carry']).toBe(3);
    expect(folded.byCategory['acceptance-ceremony']).toBe(4);
    expect(Object.keys(folded.byCategory).sort()).toEqual([...PLAN_EFFICIENCY_CATEGORIES].sort());
    // A replay is not a failure; a failure without an error code is classed by its status.
    expect(folded.failedTotal).toBe(4);
    expect(folded.failedByClass).toEqual({ invalid_input: 3, error: 1 });
    expect(folded.droppedCalls).toBe(3);
  });
});

describe('selected-step usage population (not a causal spend claim)', () => {
  const start = Date.parse('2026-10-21T10:00:00Z');
  const source: WorkflowStepSource = {
    workspaceId: 'ws', harnessSlug: 'papercusp',
    subject: { kind: 'work-item', ref: 'WI-step', windowStart: new Date(start).toISOString(),
      windowEnd: new Date(start + 60_000).toISOString() },
    workItemIds: ['WI-step'], nativeSessionIds: ['native'], ownerIds: ['owner'], sharedSessionIds: [],
    predicate: 'canonical fixture source predicate', fingerprint: 'a'.repeat(64), complete: true,
    expectedRequests: { state: 'known', keys: ['request-a'], sourceRef: 'closed-native-fixture' },
  };
  const row = (patch: Partial<WorkflowStepUsageRow> = {}): WorkflowStepUsageRow => ({
    id: 'row-a', workspace_id: 'ws', harness_slug: 'papercusp', session_id: 'native', run_id: null,
    usage_event_key: 'request-a', event_ts: start + 1000,
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 10, cache_creation_tokens: 0,
    cost_usd: 0.25, cost_source: 'estimated', usage_provenance: { grain: 'request' }, ...patch,
  });
  const measure = (rows: WorkflowStepUsageRow[], patch: Partial<WorkflowStepSource> = {},
    ledger = { totalRecords: rows.length as number | null, limit: 100, complete: true }) =>
    summarizeWorkflowStepUsage({ source: { ...source, ...patch }, rows, ledger });

  it('measures request deltas and keeps observed zero, unknowns, estimates and attribution distinct', () => {
    const result = measure([row(), row({ id: 'provider', usage_event_key: 'provider', cost_usd: 0,
      input_tokens: null, output_tokens: 0, cost_source: 'provider' })]);
    expect(result.totals.inputTokens).toEqual({ value: 100, observedRecords: 1, missingRecords: 1 });
    expect(result.totals.providerReportedUsd.value).toBe(0);
    expect(result.totals.estimatedListUsd.value).toBe(0.25);
    expect(result.totals.outputTokens.value).toBe(20);
    expect(result.population.selectedUniqueRequests).toBe(2);
    expect(result.partitions['unallocated-shared']).toHaveLength(2);
    expect(result.partitions.included).toHaveLength(0);
    expect(result).toMatchObject({ exactStepSpendUsd: null, exactStepSpendKnown: false,
      efficiency: 'unknown', intrinsicStepValue: 'not-inferred' });
    expect(measure([]).totals.estimatedListUsd.value).toBeNull();
    expect(measure([row({ input_tokens: null })]).totals.inputTokens.value).toBeNull();
  });

  it.each([
    ['foreign-workspace', { workspace_id: 'elsewhere' }],
    ['foreign-or-missing-harness', { harness_slug: 'elsewhere' }],
    ['foreign-or-missing-harness', { harness_slug: null }],
    ['foreign-session', { session_id: 'foreign' }],
    ['outside-event-window', { event_ts: start - 1 }],
    ['outside-event-window', { event_ts: start + 60_000 }],
  ] as const)('excludes %s before additive facts: %j', (reason, patch) => {
    const result = measure([row(patch)]);
    expect(result.partitions.excluded[0].reason).toBe(reason);
    expect(result.totals.estimatedListUsd.value).toBeNull();
    expect(result.population.missingExpectedRequestKeys).toEqual(['request-a']);
  });

  it('retains shared and unallocated observations without calling them step spend', () => {
    const result = measure([row()], { sharedSessionIds: ['native'] });
    expect(result.partitions['unallocated-shared'][0].reason).toBe('shared-native-context');
    expect(result.totals.estimatedListUsd.value).toBe(0.25);
    expect(result.exactStepSpendKnown).toBe(false);
    const ownerOnly = measure([row({ session_id: null, usage_provenance: { grain: 'request', sessionOwnerId: 'owner' } })]);
    expect(ownerOnly.population.selectedUniqueRequests).toBe(1);
    expect(ownerOnly.partitions['unallocated-shared'][0].reason).toContain('unavailable');
  });

  it('does not sum duplicate events or pick a favorable conflicting observation', () => {
    const duplicate = row({ id: 'copy' });
    const result = measure([row(), duplicate]);
    expect(result.partitions.duplicate.map(r => r.rowId)).toEqual(['row-a']);
    expect(result.population).toMatchObject({ observedRecords: 2, observedUniqueKeys: 1, selectedUniqueRequests: 1 });
    expect(result.totals.inputTokens.value).toBe(100);
    const conflict = row({ id: 'conflict', input_tokens: 101 });
    for (const rows of [[row(), conflict], [conflict, row()]]) {
      const bad = measure(rows);
      expect(bad.partitions.conflicting).toHaveLength(2);
      expect(bad.totals.inputTokens.value).toBeNull();
      expect(bad.population.missingExpectedRequestKeys).toEqual(['request-a']);
      expect(bad.gaps).toContain('conflicting-request-observations');
    }
  });

  it.each([
    { event_ts: null }, { event_ts: 'not-time' }, { usage_event_key: null },
    { usage_provenance: { grain: 'cumulative' } }, { usage_provenance: { grain: 'file-model-delta' } },
    { usage_provenance: {} },
  ])('never treats missing original time or cumulative/unknown grain as request deltas: %j', patch => {
    const result = measure([row(patch)]);
    expect(result.partitions['missing-time-unknown-grain']).toHaveLength(1);
    expect(result.totals.inputTokens.value).toBeNull();
    expect(result.exactStepSpendKnown).toBe(false);
  });

  it.each([
    { scenario: 'duplicate-missing-time', patch: { event_ts: null }, primary: 'missing-time-unknown-grain', flags: ['duplicate-observation', 'missing-original-event-time'] },
    { scenario: 'unknown-grain-duplicate', patch: { usage_provenance: { grain: 'cumulative' } }, primary: 'missing-time-unknown-grain', flags: ['duplicate-observation', 'non-request-or-unknown-grain'] },
    { scenario: 'foreign-duplicate', patch: { workspace_id: 'foreign' }, primary: 'excluded', flags: ['duplicate-observation', 'foreign-workspace'] },
  ] as const)('retains combined diagnostics under primary precedence: $scenario', ({ patch, primary, flags }) => {
    const rows = [row({ ...patch, id: '2' }), row({ ...patch, id: '10' })];
    const forward = measure(rows), reversed = measure([...rows].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.partitions[primary]).toHaveLength(2);
    expect(Object.values(forward.partitions).flat()).toHaveLength(2);
    for (const diagnostic of forward.diagnostics) expect(diagnostic.flags).toEqual(expect.arrayContaining([...flags]));
  });

  it('retains conflicting/shared flags and distinguishes absent from unusable expected keys', () => {
    const result = measure([row({ id: '2' }), row({ id: '10', input_tokens: 101 })], {
      sharedSessionIds: ['native'], expectedRequests: { state: 'known', keys: ['request-a', 'absent'], sourceRef: 'source' },
    });
    expect(result.partitions.conflicting).toHaveLength(2);
    for (const diagnostic of result.diagnostics) expect(diagnostic.flags).toEqual(expect.arrayContaining([
      'conflicting-request-observations', 'shared-native-context',
    ]));
    expect(result.population.missingLedgerRequestKeys).toEqual(['absent']);
    expect(result.population.unusableExpectedRequestKeys).toEqual(['request-a']);
  });

  it('selects the lowest canonical row identity independent of permutation and provenance object order', () => {
    const rows = [row({ id: '10', usage_provenance: { grain: 'request', costBound: 'exact' } }),
      row({ id: '2', usage_provenance: { costBound: 'exact', grain: 'request' } })];
    const result = measure(rows);
    expect(result).toEqual(measure([...rows].reverse()));
    expect(result.partitions['unallocated-shared'].map(entry => entry.rowId)).toEqual(['2']);
    expect(result.partitions.duplicate.map(entry => entry.rowId)).toEqual(['10']);
    expect(result.totals.inputTokens.value).toBe(100);
    expect(measure([row({ id: '2' }), row({ id: '10', usage_provenance: { grain: 'request', priceTableVersion: 'changed' } })])
      .partitions.conflicting).toHaveLength(2);
  });

  it('retains provider and estimate lower bounds and failed-call cost as incurred', () => {
    const result = measure([row({ usage_provenance: { grain: 'request', outcome: 'failed', costBound: 'lower' } }),
      row({ id: 'p', usage_event_key: 'p', cost_source: 'provider', cost_usd: 0.5 })]);
    expect(result.totals).toMatchObject({ failedRequestRecords: 1, lowerBoundCostRecords: 1,
      providerReportedUsd: { value: 0.5 }, estimatedListUsd: { value: 0.25 } });
    expect(result.intrinsicStepValue).toBe('not-inferred');
    expect(result.gaps).toContain('complete-provider-charge-census-unavailable');
  });

  it('partitions every observed row once and keeps missing expected requests and overflow separate', () => {
    const rows = [row(), row({ id: 'copy' }), row({ id: 'foreign', session_id: 'foreign' }),
      row({ id: 'unknown', usage_event_key: 'unknown', event_ts: null })];
    const result = measure(rows, { expectedRequests: { state: 'known', keys: ['request-a', 'missing'], sourceRef: 'source' } },
      { totalRecords: 10, limit: 4, complete: false });
    expect(Object.values(result.partitions).flat().map(r => r.rowId).sort()).toEqual(rows.map(r => r.id).sort());
    expect(result.population.missingExpectedRequestKeys).toEqual(['missing']);
    expect(result.population.truncatedResidueRecords).toBe(6);
    expect(result.population.query.complete).toBe(false);
    expect(result.gaps).toContain('ledger-read-incomplete');
    expect(measure([row()], {}, { totalRecords: 1000, limit: 1, complete: true }).population.query.complete).toBe(false);
  });

  it('preserves failed reads, unknown denominator and invalid numeric data without invented zero', () => {
    const result = summarizeWorkflowStepUsage({ source: { ...source, complete: false,
      expectedRequests: { state: 'unknown', reason: 'native frontier unavailable' } }, rows: [],
      ledger: { totalRecords: null, limit: 10, complete: false, error: 'read failed' } });
    expect(result.population).toMatchObject({ expectedUniqueRequests: null, truncatedResidueRecords: null });
    expect(result.gaps).toContain('ledger-read-failed');
    expect(result.totals.inputTokens.value).toBeNull();
    for (const value of [-1, Infinity, 'NaN', '', ' ', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
      expect(measure([row({ input_tokens: value })]).totals.inputTokens.value).toBeNull();
    }
    const overflow = measure([row({ input_tokens: Number.MAX_SAFE_INTEGER }),
      row({ id: 'overflow', usage_event_key: 'another', input_tokens: 1 })]);
    expect(overflow.totals.inputTokens.value).toBeNull();
    expect(overflow.gaps).toContain('token-sum-overflow');
    expect(measure([row({ input_tokens: Infinity })]).observations).toMatchObject([
      { input_tokens: { nonFiniteNumber: 'Infinity' } },
    ]);
  });

  it.each([1, 2, 3])('reconciles %i observations across fixed-size pages without increasing the page limit', count => {
    const rows = Array.from({ length: count }, (_, i) => row({ id: String(i), usage_event_key: `key-${i}`, input_tokens: i + 1 }));
    const result = summarizeWorkflowStepUsage({ source, rows,
      ledger: { totalRecords: count, limit: 2, pages: Math.ceil(count / 2), complete: true } });
    expect(result.population.query).toMatchObject({ complete: true, limit: 2 });
    expect(result.population.observedRecords).toBe(count);
    expect(result.population.truncatedResidueRecords).toBe(0);
    expect(result.totals.inputTokens.value).toBe(count * (count + 1) / 2);
    if (count > 2) expect(summarizeWorkflowStepUsage({ source, rows,
      ledger: { totalRecords: count, limit: 2, pages: 1, complete: true } }).population.query.complete).toBe(false);
    expect(result.exactStepSpendKnown).toBe(false);
  });

  it('groups equal keys across page boundaries and restart permutations before choosing representatives', () => {
    const pages = [[row({ id: '2' }), row({ id: '3', usage_event_key: 'conflict', input_tokens: 1 })],
      [row({ id: '10' }), row({ id: '11', usage_event_key: 'conflict', input_tokens: 2 })]];
    const collect = (rows: WorkflowStepUsageRow[]) => summarizeWorkflowStepUsage({ source, rows,
      ledger: { totalRecords: 4, limit: 2, pages: 2, complete: true } });
    const expected = collect(pages.flat());
    const reversed = JSON.parse(JSON.stringify([...pages[1], ...pages[0]]));
    expect(collect(reversed)).toEqual(expected);
    expect(expected.partitions.duplicate.map(row => row.rowId)).toEqual(['10']);
    expect(expected.partitions.conflicting.map(row => row.rowId)).toEqual(['3', '11']);
    expect(Object.values(expected.partitions).flat()).toHaveLength(4);
  });

  it('unions overlapping tool intervals while other time categories remain unknown', () => {
    expect(unionWorkflowStepIntervals([[0, 100], [50, 200], [300, 350]])).toBe(250);
    expect(unionWorkflowStepIntervals([[100, 100]])).toBe(0);
    expect(unionWorkflowStepIntervals([])).toBeNull();
    expect(unionWorkflowStepIntervals([[2, 1]])).toBeNull();
    const result = summarizeWorkflowStepUsage({ source, rows: [row()],
      ledger: { totalRecords: 1, limit: 10, complete: true }, toolIntervals: [[0, 100], [50, 200]] });
    expect(result.time).toMatchObject({ observedToolIntervalUnionMs: 200, activeEffortMs: null,
      queueingMs: null, ownerPauseMs: null, attributableElapsedMs: null });
    expect(result.efficiency).toBe('unknown');
  });
});
