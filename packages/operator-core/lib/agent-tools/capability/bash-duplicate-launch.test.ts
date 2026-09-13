/**
 * Regression coverage for carry-safe background launches (EI-21910156647461981).
 *
 * A successor can receive a durable task id in one carry surface while another
 * surface tells it to re-run the same command. Before launching arbitrary work,
 * capability:bash must recognize a live task with the exact command + cwd and
 * point the caller at reattachment. An explicit override remains available for
 * commands that are intentionally duplicated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../../task-manager/types';

const store = vi.hoisted(() => ({
  listLiveTasks: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  startBackground: vi.fn(),
  waitForJobResponse: vi.fn(async () => 'terminal' as const),
  snapshotJobResult: vi.fn(() => ({
    status: 'completed' as const,
    exitCode: 0,
    output: 'ordinary-ok',
    totalBytes: 11,
    truncated: false,
    logPath: '/tmp/bash-new.log',
    durationMs: 1,
  })),
}));

vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  listLiveTasks: store.listLiveTasks,
}));
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: jobs.startBackground,
  waitForJobResponse: jobs.waitForJobResponse,
  snapshotJobResult: jobs.snapshotJobResult,
}));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool from './bash';

type ToolResult = {
  content: Array<{ text: string }>;
  isError?: boolean;
};
type Tool = {
  handler: (args: unknown, ctx: unknown) => Promise<ToolResult>;
};

const bash = bashTool as unknown as Tool;
const CWD = '/tmp';
const COMMAND = 'npm run test:affected -- --paths packages/operator-core';

function liveTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-existing-21910156647461981',
    workspaceId: 'ws-current',
    rootTaskId: 'task-existing-21910156647461981',
    class: 'bash-job',
    title: COMMAND,
    argv: ['bash', '-o', 'pipefail', '-c', COMMAND],
    cwd: CWD,
    launchedBy: 'su-existing',
    state: 'running',
    confined: true,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    endedAt: null,
    detail: { bashJobId: 'bash-existing-21910156647461981' },
    ...overrides,
  };
}

function ctx() {
  return {
    workspaceId: 'ws-current',
    projectDir: CWD,
    stateDir: CWD,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listLiveTasks.mockResolvedValue([liveTask()]);
  jobs.startBackground.mockReturnValue({
    id: 'bash-new',
    taskId: 'task-new',
    status: 'running',
    cwd: CWD,
    logPath: '/tmp/bash-new.log',
    timeoutMs: 10_000,
    deadlineAt: Date.now() + 10_000,
  });
});

describe('capability:bash — duplicate live background launch guard', () => {
  it('refuses an exact live command + cwd match and returns a reattach handle', async () => {
    const result = await bash.handler({ command: COMMAND, cwd: CWD, run_in_background: true }, ctx());
    const seen = payload(result);

    expect(result.isError).toBe(true);
    expect(seen).toMatchObject({
      ok: false,
      reason: 'duplicate_live_task',
      task_id: 'task-existing-21910156647461981',
      bash_id: 'bash-existing-21910156647461981',
      cwd: CWD,
    });
    expect(String(seen.advice)).toContain('capability:bash_output');
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('does not treat a different cwd as a duplicate', async () => {
    const otherCwd = '/var/tmp';
    const result = await bash.handler({ command: COMMAND, cwd: otherCwd, run_in_background: true }, ctx());

    expect(payload(result)).toMatchObject({ ok: true, status: 'running', cwd: otherCwd });
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('does not treat a different command as a duplicate', async () => {
    const otherCommand = `${COMMAND} --changed`;
    const result = await bash.handler({ command: otherCommand, cwd: CWD, run_in_background: true }, ctx());

    expect(payload(result)).toMatchObject({ ok: true, status: 'running', cwd: CWD });
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('allows an explicit duplicate override', async () => {
    const result = await bash.handler(
      { command: COMMAND, cwd: CWD, run_in_background: true, allow_duplicate: true },
      ctx(),
    );

    expect(payload(result)).toMatchObject({ ok: true, status: 'running', cwd: CWD });
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('does not cross-reject an ordinary call merely because an identical detached task is live', async () => {
    const result = await bash.handler({ command: COMMAND, cwd: CWD }, ctx());

    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('ordinary-ok');
    expect(jobs.startBackground).toHaveBeenCalledOnce();
    expect(store.listLiveTasks).not.toHaveBeenCalled();
  });
});
