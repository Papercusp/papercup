/**
 * WI-38433 / P-002 — carry-safe attachment to a managed capability:bash job.
 *
 * A cold successor retains the durable task_id but not the launching worker's
 * process-local bash_id. Attachment must resolve the existing ledger identity,
 * reuse the existing BashOutput path, and never turn a miss into a second job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../../task-manager/types';
import type { BashJob } from './bash-jobs';

const store = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskByBashJobId: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  readJobOutput: vi.fn(),
  startBackground: vi.fn(),
}));

vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  getTask: store.getTask,
  getTaskByBashJobId: store.getTaskByBashJobId,
}));
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  getJob: jobs.getJob,
  readJobOutput: jobs.readJobOutput,
  // The assertion below is the recurrence guard: the attachment module has no
  // reason to call the launch seam, even when resolution fails.
  startBackground: jobs.startBackground,
}));
vi.mock('../../process-identity', () => ({
  readProcessIdentity: vi.fn(() => 'linux:boot-test:4242'),
}));
vi.mock('../../task-manager/cgroup-read', () => ({
  readProcessCgroupPath: vi.fn(() => '/papercusp.slice/pc-task-carry-1.scope'),
  readProcessCmdline: vi.fn(() => 'bash -o pipefail -c sleep 60'),
}));

import bashOutputTool from './bash_output';

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = {
  args: { safeParse(value: unknown): { success: boolean } };
  handler: (args: unknown, ctx: unknown) => Promise<ToolResultish>;
};
const bashOutput = bashOutputTool as unknown as Tool;

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-carry-1',
    workspaceId: 'ws-current',
    rootTaskId: 'task-carry-1',
    class: 'bash-job',
    title: 'long verification',
    argv: ['bash', '-o', 'pipefail', '-c', 'sleep 60'],
    confined: true,
    scopeUnit: 'pc-task-carry-1.scope',
    cgroupPath: '/papercusp.slice/pc-task-carry-1.scope',
    state: 'running',
    startedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    launchedBy: 'su-test',
    logPath: '/tmp/bash-carry-1.log',
    detail: { bashJobId: 'bash-carry-1' },
    pid: 4242,
    processIdentity: 'linux:boot-test:4242',
    ...overrides,
  };
}

function liveJob(): BashJob {
  return {
    id: 'bash-carry-1',
    taskId: 'task-carry-1',
    command: 'sleep 60',
    cwd: '/repo',
    child: {} as BashJob['child'],
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    buffer: 'still working\n',
    totalBytes: 14,
    logPath: '/tmp/bash-carry-1.log',
    readCursor: 0,
    logStream: null,
  };
}

function ctx(workspaceId = 'ws-current') {
  return {
    workspaceId,
    stateDir: '/tmp/task-reattach-state',
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getTask.mockResolvedValue(taskRow());
  store.getTaskByBashJobId.mockResolvedValue(null);
  jobs.getJob.mockReturnValue(liveJob());
  jobs.readJobOutput.mockReturnValue('still working\n');
});

describe('capability:bash_output — durable task attachment', () => {
  it('requires exactly one process-local or durable handle', () => {
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1' }).success).toBe(true);
    expect(bashOutput.args.safeParse({ task_id: 'task-1' }).success).toBe(true);
    expect(bashOutput.args.safeParse({}).success).toBe(false);
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1', task_id: 'task-1' }).success).toBe(false);
  });

  it('reattaches by task_id to the existing job and never launches a duplicate', async () => {
    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(store.getTask).toHaveBeenCalledWith('task-carry-1');
    expect(jobs.getJob).toHaveBeenCalledWith('bash-carry-1');
    expect(store.getTaskByBashJobId).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'running',
      running: true,
      output: 'still working\n',
    });
  });

  it('returns a normal running recovery when the registry misses but the ledger proves the process alive', async () => {
    jobs.getJob.mockReturnValue(null);

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      ok: true,
      bash_id: 'bash-carry-1',
      task_id: 'task-carry-1',
      status: 'running',
      running: true,
      recovered_from_ledger: true,
      tracking_lost: true,
      output_is_tail: true,
      output: '',
    });
    expect(payload).not.toHaveProperty('reason', 'tracking_lost_process_alive');
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('hides a cross-workspace task as unknown and does not touch the job registry', async () => {
    store.getTask.mockResolvedValue(taskRow({ workspaceId: 'ws-other' }));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('unknown_task_id');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('refuses non-bash ledger rows without creating a replacement', async () => {
    store.getTask.mockResolvedValue(taskRow({ class: 'agent', detail: {} }));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_not_attachable');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('reports ledger failure as unknown, never as a healthy miss or a restart', async () => {
    store.getTask.mockRejectedValue(new Error('db unavailable'));

    const result = await bashOutput.handler({ task_id: 'task-carry-1' }, ctx());
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.reason).toBe('task_ledger_unavailable');
    expect(String(payload.advice)).toContain('NOT restarted');
    expect(jobs.getJob).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });
});
