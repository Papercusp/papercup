import { describe, expect, it, vi } from 'vitest';
import scorecardEmitTool, { cleanupAcceptanceGraderTasks } from './emit';
import { COORD_ROLES } from '../coordination/roles';

const task = (taskId: string, label: string, headless = true) => ({
  taskId,
  workspaceId: 'ws-test',
  rootTaskId: taskId,
  class: 'agent-session',
  title: label,
  argv: [],
  launchedBy: 'su-implementer',
  confined: true,
  state: 'running',
  startedAt: '2026-08-14T00:00:00.000Z',
  lastSeenAt: '2026-08-14T00:00:00.000Z',
  detail: { label, headless },
}) as never;

describe('dedicated acceptance judge lifecycle', () => {
  it('admits judge only on scorecards:emit, without widening the shared coordination role set', () => {
    expect(scorecardEmitTool.agentRoles).toContain('judge');
    expect(COORD_ROLES).not.toContain('judge');
  });

  it('kills every live headless task for the exact acceptance-rubric label prefix', async () => {
    const list = vi.fn(async () => [
      task('task-a', 'acceptance-grader:rubric-a:abc123'),
      task('task-b', 'acceptance-grader:rubric-a:def456'),
      task('task-visible', 'acceptance-grader:rubric-a:ghi789', false),
      task('task-other', 'acceptance-grader:rubric-b:abc123'),
    ]);
    const kill = vi.fn(async (taskId: string) => ({ ok: true, taskId, action: 'kill' as const }));

    const result = await cleanupAcceptanceGraderTasks(
      'rubric-a',
      { workspaceId: 'ws-test' },
      { list: list as never, kill: kill as never },
    );

    expect(list).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      classes: ['agent-session'],
      limit: 2_000,
    });
    expect(result).toMatchObject({ matched: 2, prefix: 'acceptance-grader:rubric-a:' });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith('task-a', { includeSubtree: true });
    expect(kill).toHaveBeenCalledWith('task-b', { includeSubtree: true });
  });
});
