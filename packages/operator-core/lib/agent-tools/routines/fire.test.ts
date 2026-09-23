import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, enqueueMock, workspaceMock, homeMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  enqueueMock: vi.fn(),
  workspaceMock: vi.fn(() => 'workspace-1'),
  homeMock: vi.fn(() => 'home'),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: workspaceMock }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: homeMock }));
vi.mock('../../dbos/routines-workflow', () => ({ enqueueRoutineFire: enqueueMock }));

const tool = (await import('./fire')).default;

const row = {
  id: 'rt_home_git_sync',
  workspaceId: 'workspace-1',
  installSlug: 'home',
  name: 'git-sync',
  targetRole: 'system:git-sync',
  triggerConfig: { cron: '*/3 * * * * *' },
  payloadTemplate: null,
  rescheduleIntervalSec: null,
  targetOwnerId: null,
};

function body(value: unknown): Record<string, unknown> {
  const result = value as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([row]);
  enqueueMock.mockResolvedValue({
    ok: true,
    status: 'enqueued',
    routineId: row.id,
    deduplicationId: `routine:${row.id}`,
    queueName: 'routines-critical',
    timeoutMs: 7_200_000,
  });
});

describe('routines:fire', () => {
  it('looks up the live workspace row and delegates its full dispatch payload', async () => {
    const result = await tool.handler({ name: 'git-sync', installSlug: 'home', reason: 'verify recovery' } as never, {
      role: 'operator',
      metadata: vi.fn(),
    } as never);

    expect(workspaceMock).toHaveBeenCalledOnce();
    expect(sqlMock).toHaveBeenCalledOnce();
    expect(enqueueMock).toHaveBeenCalledWith(row);
    expect(body(result)).toMatchObject({ ok: true, status: 'enqueued', routine: 'home/git-sync' });
  });

  it('supports exact row-id lookup and preserves a deduplicated result', async () => {
    enqueueMock.mockResolvedValue({
      ok: true,
      status: 'deduplicated',
      routineId: row.id,
      deduplicationId: `routine:${row.id}`,
      queueName: 'routines-critical',
      timeoutMs: 7_200_000,
    });
    const result = await tool.handler({ id: row.id } as never, { role: 'operator' } as never);
    expect(enqueueMock).toHaveBeenCalledWith(row);
    expect(body(result)).toMatchObject({ ok: true, status: 'deduplicated' });
  });

  it('explains DBOS-primary unavailability and keeps release promotion on release:deploy', async () => {
    enqueueMock.mockResolvedValue({
      ok: false,
      status: 'unavailable',
      reason: 'dbos-not-started',
      routineId: row.id,
      deduplicationId: `routine:${row.id}`,
      queueName: 'routines-critical',
      timeoutMs: 7_200_000,
    });

    const result = await tool.handler({ name: 'release-trigger', installSlug: 'home' } as never, {
      role: 'operator',
    } as never);

    expect(body(result)).toMatchObject({
      status: 'unavailable',
      reason: 'dbos-not-started',
      nextStep: expect.stringContaining('background-worker MCP host'),
    });
    expect(tool.guidance?.notWhen).toContain('request-only operator host');
    expect(tool.guidance?.notWhen).toContain('release:deploy');
  });

  it('returns a truthful not-found error without enqueueing', async () => {
    sqlMock.mockResolvedValue([]);
    const result = await tool.handler({ name: 'missing', installSlug: 'home' } as never, { role: 'operator' } as never);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(body(result)).toMatchObject({ ok: false, error: 'not_found' });
  });
});
