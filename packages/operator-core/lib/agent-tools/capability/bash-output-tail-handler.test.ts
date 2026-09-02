/**
 * capability:bash_output `tail` (EI-22068327735595657) — end-to-end through the
 * real tool `.handler()`, exercising the running-job happy path (the branch every
 * caller hits on an ordinary poll). Confirms `tail` composes with `filter` and
 * that the read cursor still advances past the FULL chunk regardless of `tail`
 * (matching the documented `filter` contract). Mirrors the mocking pattern of
 * bash-output-task-reattach.test.ts, trimmed to the bash_id-only path (no
 * task_id attachment, so the task-manager store is never touched).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BashJob } from './bash-jobs';

const jobs = vi.hoisted(() => ({
  getJob: vi.fn(),
  readJobOutput: vi.fn(),
}));

vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  getJob: jobs.getJob,
  readJobOutput: jobs.readJobOutput,
}));

import bashOutputTool from './bash_output';

type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
type Tool = {
  args: { safeParse(value: unknown): { success: boolean } };
  handler: (args: unknown, ctx: unknown) => Promise<ToolResultish>;
};
const bashOutput = bashOutputTool as unknown as Tool;

function liveJob(overrides: Partial<BashJob> = {}): BashJob {
  return {
    id: 'bash-tail-1',
    // `BashJob.taskId` is `?: string` (bash-jobs.ts), not nullable — an
    // unenrolled job simply has no task id. `null` typechecks nowhere.
    taskId: undefined,
    command: 'echo multi-line',
    cwd: '/repo',
    child: {} as BashJob['child'],
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    buffer: 'line1\nline2\nline3\nline4\nline5',
    totalBytes: 29,
    // A nonexistent log path is fine: readJobLogForVerdict catches the stat/read
    // failure and falls back to job.buffer.
    logPath: '/tmp/bash-output-tail-test-nonexistent.log',
    readCursor: 0,
    logStream: null,
    ...overrides,
  };
}

function ctx(stateDir = '/tmp/bash-output-tail-test-state') {
  return {
    workspaceId: 'ws-tail-test',
    stateDir,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('capability:bash_output — tail (EI-22068327735595657)', () => {
  it('schema accepts `tail` (previously an undeclared-key rejection)', () => {
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1', tail: 5 }).success).toBe(true);
  });

  it('rejects a non-positive tail (0 and negative), same as an over-long filter would be a caller mistake', () => {
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1', tail: 0 }).success).toBe(false);
    expect(bashOutput.args.safeParse({ bash_id: 'bash-1', tail: -1 }).success).toBe(false);
  });

  it('returns only the last N lines of a running job’s output', async () => {
    const job = liveJob();
    jobs.getJob.mockReturnValue(job);
    jobs.readJobOutput.mockReturnValue(job.buffer);

    const result = await bashOutput.handler({ bash_id: 'bash-tail-1', tail: 2 }, ctx());
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('running');
    expect(parsed.output).toBe('line4\nline5');
  });

  it('composes with `filter`: filter narrows to matching lines, THEN tail keeps the last N of what remains', async () => {
    const job = liveJob({ buffer: 'keep-1\nnoise\nkeep-2\nnoise\nkeep-3' });
    jobs.getJob.mockReturnValue(job);
    jobs.readJobOutput.mockReturnValue(job.buffer);

    const result = await bashOutput.handler({ bash_id: 'bash-tail-1', filter: '^keep', tail: 2 }, ctx());
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.output).toBe('keep-2\nkeep-3');
  });

  it('omitting tail leaves the full chunk untouched (no regression to the existing contract)', async () => {
    const job = liveJob();
    jobs.getJob.mockReturnValue(job);
    jobs.readJobOutput.mockReturnValue(job.buffer);

    const result = await bashOutput.handler({ bash_id: 'bash-tail-1' }, ctx());
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.output).toBe('line1\nline2\nline3\nline4\nline5');
  });

  it('the read cursor still advances past the FULL chunk regardless of tail (readJobOutput is called with peek=false, unaffected by tail)', async () => {
    const job = liveJob();
    jobs.getJob.mockReturnValue(job);
    jobs.readJobOutput.mockReturnValue(job.buffer);

    await bashOutput.handler({ bash_id: 'bash-tail-1', tail: 1 }, ctx());

    expect(jobs.readJobOutput).toHaveBeenCalledWith(job, false);
  });
});
