import { describe, expect, it, vi } from 'vitest';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { GOAL_WRITE_ACTION } from '@papercusp/agent-mcp';
import { appendGoalWriteAudit } from './write-audit';

function sqlThatCaptures(calls: Array<{ params: unknown[] }>): GoalSqlTag {
  return ((strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ params });
    return Promise.resolve([]);
  }) as GoalSqlTag;
}

describe('appendGoalWriteAudit', () => {
  it('uses the shared goal history seam with semantic actor provenance', async () => {
    const calls: Array<{ params: unknown[] }> = [];
    await appendGoalWriteAudit(sqlThatCaptures(calls), {
      workspaceId: 'ws-test',
      goalId: 'goal-test',
      author: 'goal-holder-respawner',
      writeKind: 'holder-respawn-reserve',
      actorClass: 'holder-agent-respawner',
      detail: 'reserved',
      atMs: 1234,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[3]).toBe(GOAL_WRITE_ACTION);
    expect(JSON.parse(String(calls[0]!.params[5]))).toMatchObject({
      kind: 'write',
      writeKind: 'holder-respawn-reserve',
      actorClass: 'holder-agent-respawner',
      detail: 'reserved',
    });
  });

  it('silently tolerates a missing audit_log in lightweight fixtures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missingAuditLog = Object.assign(new Error('relation "harness_shared.audit_log" does not exist'), {
      code: '42P01',
    });
    const sql = (() => Promise.reject(missingAuditLog)) as unknown as GoalSqlTag;

    await expect(appendGoalWriteAudit(sql, {
      workspaceId: 'ws-test',
      goalId: 'goal-test',
      author: 'goal-holder-respawner',
      writeKind: 'holder-respawn-reserve',
      actorClass: 'holder-agent-respawner',
    })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates real audit failures for the caller to report', async () => {
    const failure = new Error('connection terminated');
    const sql = (() => Promise.reject(failure)) as unknown as GoalSqlTag;
    await expect(appendGoalWriteAudit(sql, {
      workspaceId: 'ws-test',
      goalId: 'goal-test',
      author: 'goal-holder-respawner',
      writeKind: 'holder-respawn-reserve',
      actorClass: 'holder-agent-respawner',
    })).rejects.toBe(failure);
  });
});
