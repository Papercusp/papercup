import { beforeEach, describe, expect, it } from 'vitest';
import type { GoalSqlTag } from './_core';
import {
  GOAL_AMENDMENT_ACTION,
  GOAL_EVIDENCE_ACTION,
  GOAL_WRITE_ACTION,
  GOAL_HISTORY_OMITTED_REF_LIMIT,
  addGoalFieldChange,
  appendGoalHistory,
  readGoalHistory,
  readGoalHistoryEntriesByIds,
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
      omittedEntryIds: ['a1'],
      omittedEntryIdsTruncated: false,
    });
    expect(calls[0]!.sql).toContain('FROM harness_shared.audit_log');
    expect(calls[0]!.params).toContain('papercusp-workspace');
    expect(calls[0]!.params).toContain('goal-1');
    expect(calls[0]!.params).toContain(2 + GOAL_HISTORY_OMITTED_REF_LIMIT + 1);
  });

  it('recovers exact omitted history ids without depending on their page rank', async () => {
    selectedRows = [
      {
        id: 'a-old',
        ts: 1000,
        actor: 'blender',
        action: GOAL_EVIDENCE_ACTION,
        details: { kind: 'evidence', summary: 'old but still addressable' },
      },
    ];
    const entries = await readGoalHistoryEntriesByIds(makeSql(), {
      workspaceId: 'ws',
      goalId: 'goal-1',
      ids: ['a-old'],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a-old', summary: 'old but still addressable' });
    expect(calls[0]!.sql).toContain('id = ANY');
    expect(calls[0]!.params).toContainEqual(['a-old']);
  });

  it('records and projects a system goal:write with actor class', async () => {
    const entry = await appendGoalHistory(makeSql(), {
      id: 'goal-write-1',
      atMs: 1_755_000_000_100,
      workspaceId: 'papercusp-workspace',
      goalId: 'goal-1',
      author: 'goal-holder-respawner',
      detail: { kind: 'write', writeKind: 'holder-respawn-reserve', actorClass: 'holder-agent-respawner' },
    });
    expect(entry).toMatchObject({
      id: 'goal-write-1',
      kind: 'write',
      author: 'goal-holder-respawner',
      writeKind: 'holder-respawn-reserve',
      actorClass: 'holder-agent-respawner',
    });
    expect(calls[0]!.params[3]).toBe(GOAL_WRITE_ACTION);
  });

  it('includes goal:write rows in the bounded history read', async () => {
    selectedRows = [{
      id: 'w1', ts: 4000, actor: 'goal-holder-respawner', action: GOAL_WRITE_ACTION,
      details: { kind: 'write', writeKind: 'holder-respawn-pause', actorClass: 'holder-agent-respawner' },
    }];
    const history = await readGoalHistory(makeSql(), { workspaceId: 'ws', goalId: 'goal-1' });
    expect(history.entries[0]).toMatchObject({ kind: 'write', writeKind: 'holder-respawn-pause', actorClass: 'holder-agent-respawner' });
    expect(history.omittedEntryIds).toEqual([]);
    expect(history.omittedEntryIdsTruncated).toBe(false);
    expect(calls[0]!.params[2]).toContain(GOAL_WRITE_ACTION);
  });
});
