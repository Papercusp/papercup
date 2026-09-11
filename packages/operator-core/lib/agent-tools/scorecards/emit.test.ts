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
  it('admits judge on scorecards:emit without widening the shared coordination role set', () => {
    expect(scorecardEmitTool.agentRoles).toContain('judge');
    expect(COORD_ROLES).not.toContain('judge');
  });

  it('documents that the persisted acceptance card still carries complete ratings, adopted by reference', () => {
    // P-003 (review-verification-efficiency-2026-09-09) removed the
    // TRANSCRIPTION, not the PERSISTENCE. The card filed for an acceptance
    // verdict must still be schema-complete: plan-acceptance-gate drops
    // incomplete cards from its `complete` filter, and the verdict then reads as
    // `acceptance_not_recorded`. The old wording ("ratings field remains
    // schema-required") is gone; the property it protected is not, so this
    // guard follows the property instead of being deleted with the wording.
    const args = scorecardEmitTool.args as {
      shape?: { acceptance?: { description?: string }; acceptanceOf?: { description?: string } };
    };
    expect(args.shape?.acceptance?.description ?? '').toMatch(/always carries complete ratings/i);
    expect(args.shape?.acceptanceOf?.description ?? '').toMatch(/adopts its ratings verbatim/i);
    expect(String(scorecardEmitTool.description)).toMatch(/Every emit persists complete ratings/i);
    expect(JSON.stringify(scorecardEmitTool.guidance)).toMatch(/acceptance adopts ratings via acceptanceOf/i);
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
    expect(kill).toHaveBeenCalledWith('task-a', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(kill).toHaveBeenCalledWith('task-b', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it('escalates grader cleanup to SIGKILL on a bounded grace instead of leaving survivors live (EI-21390074563933948)', async () => {
    // The filed incident: a bare-SIGTERM cleanup returned incomplete with 28
    // processes still alive because the grader tree ignored TERM. These are the
    // rubric's OWN throwaway graders, so cleanup must always arm the escalation
    // window — a regression that drops escalateAfterMs fails here.
    const list = vi.fn(async () => [task('task-a', 'acceptance-grader:rubric-a:abc123')]);
    const kill = vi.fn(async (taskId: string) => ({ ok: true, taskId, action: 'kill' as const }));

    await cleanupAcceptanceGraderTasks('rubric-a', { workspaceId: 'ws-test' }, { list: list as never, kill: kill as never });

    const [, opts] = kill.mock.calls[0] as unknown as [string, { includeSubtree?: boolean; escalateAfterMs?: number }];
    expect(opts.includeSubtree).toBe(true);
    expect(opts.escalateAfterMs).toBeGreaterThan(0);
    expect(opts.escalateAfterMs).toBeLessThanOrEqual(10_000);
  });
});
