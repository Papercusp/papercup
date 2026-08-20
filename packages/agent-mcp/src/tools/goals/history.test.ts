import { beforeEach, describe, expect, it } from 'vitest';
import type { GoalSqlTag } from './_core';
import {
  GOAL_AMENDMENT_ACTION,
  GOAL_EVIDENCE_ACTION,
  addGoalFieldChange,
  appendGoalHistory,
  readGoalHistory,
  type GoalFieldChange,
} from './history';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let selectedRows: unknown[] = [];

function makeSql(): GoalSqlTag {
  return ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    return Promise.resolve(/^\s*SELECT/.test(sql) ? selectedRows : []);
  }) as GoalSqlTag;
}

beforeEach(() => {
  calls = [];
  selectedRows = [];
});

describe('goal history — field-level semantic changes', () => {
  it('records before/after only when the persisted value really moved', () => {
    const changes: GoalFieldChange[] = [];
    addGoalFieldChange(changes, 'title', 'Old', 'New');
    addGoalFieldChange(changes, 'parentId', undefined, null);
    addGoalFieldChange(changes, 'settings', { maxAgents: 2, holder: null }, { holder: null, maxAgents: 2 });

    expect(changes).toEqual([{ field: 'title', before: 'Old', after: 'New' }]);
  });

  it('treats array order as semantic and normalizes absent values to null', () => {
    const changes: GoalFieldChange[] = [];
    addGoalFieldChange(changes, 'blockedBy', ['a', 'b'], ['b', 'a']);
    addGoalFieldChange(changes, 'killCriterion', undefined, 'stop at $500');

    expect(changes).toEqual([
      { field: 'blockedBy', before: ['a', 'b'], after: ['b', 'a'] },
      { field: 'killCriterion', before: null, after: 'stop at $500' },
    ]);
  });
});

describe('goal history — append-only audit store', () => {
  it('writes one amendment record with goal/workspace attribution', async () => {
    const entry = await appendGoalHistory(makeSql(), {
      id: 'goal-history-1',
      atMs: 1_755_000_000_000,
      workspaceId: 'papercusp-workspace',
      goalId: 'goal-1',
      author: 'su-goal-executor',
      detail: {
        kind: 'amendment',
        reason: 'new measurement changed the ceiling',
        reasonSource: 'caller',
        changes: [{ field: 'budgetCents', before: 50000, after: 75000 }],
      },
    });

    expect(entry).toMatchObject({
      id: 'goal-history-1',
      kind: 'amendment',
      author: 'su-goal-executor',
      reason: 'new measurement changed the ceiling',
      changes: [{ field: 'budgetCents', before: 50000, after: 75000 }],
    });
    expect(entry.at).toBe(new Date(1_755_000_000_000).toISOString());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('INSERT INTO harness_shared.audit_log');
    expect(calls[0]!.params[3]).toBe(GOAL_AMENDMENT_ACTION);
    expect(calls[0]!.params[4]).toBe('goal-1');
    expect(calls[0]!.params[6]).toBe('papercusp-workspace');
  });

  it('reads only goal history actions, newest-first, with a hard bounded envelope', async () => {
    selectedRows = [
      {
        id: 'a3',
        ts: 3000,
        actor: 'blender',
        action: GOAL_EVIDENCE_ACTION,
        details: { kind: 'finding', summary: 'conversion fell', refs: ['WI-1'] },
      },
      {
        id: 'a2',
        ts: 2000,
        actor: 'su-a',
        action: GOAL_AMENDMENT_ACTION,
        details: JSON.stringify({
          kind: 'amendment',
          reason: 'measured result',
          reasonSource: 'caller',
          changes: [{ field: 'title', before: 'A', after: 'B' }],
        }),
      },
      {
        id: 'a1',
        ts: 1000,
        actor: 'blender',
        action: GOAL_EVIDENCE_ACTION,
        details: { kind: 'evidence', summary: 'older evidence' },
      },
    ];

    const history = await readGoalHistory(makeSql(), {
      workspaceId: 'papercusp-workspace',
      goalId: 'goal-1',
      limit: 2,
    });

    expect(history).toEqual({
      entries: [
        {
          id: 'a3',
          kind: 'finding',
          author: 'blender',
          at: new Date(3000).toISOString(),
          summary: 'conversion fell',
          refs: ['WI-1'],
        },
        {
          id: 'a2',
          kind: 'amendment',
          author: 'su-a',
          at: new Date(2000).toISOString(),
          reason: 'measured result',
          reasonSource: 'caller',
          changes: [{ field: 'title', before: 'A', after: 'B' }],
        },
      ],
      truncated: true,
      limit: 2,
    });
    expect(calls[0]!.sql).toContain('FROM harness_shared.audit_log');
    expect(calls[0]!.params).toContain('papercusp-workspace');
    expect(calls[0]!.params).toContain('goal-1');
    expect(calls[0]!.params).toContain(3);
  });
});
