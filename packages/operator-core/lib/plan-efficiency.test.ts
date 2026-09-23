/**
 * plan-efficiency.test.ts — the pure halves of the per-plan efficiency read
 * (review-system-rework-reduction-2026-09-23 P-032): the purpose categorizer and the fold of
 * grouped call rows. The SQL half is pinned against real Postgres in
 * plan-efficiency.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_EFFICIENCY_CATEGORIES, categorizePlanToolCall, foldPlanCallGroups } from './plan-efficiency';

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
