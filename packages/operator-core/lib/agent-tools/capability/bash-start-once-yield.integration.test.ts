/**
 * Integration-layer acceptance for CAP-CONTRACT-P002-YIELD-SAME-JOB@1.
 *
 * This crosses the real capability handler → durable bash-job registry → later
 * bash_output handler boundary. It deliberately keeps the execution sandbox off;
 * sandbox correctness has its own real-wrapper integration suite, while this test
 * owns job identity and response-lifecycle continuity.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'start-once-yield-integration' },
  })),
}));

import bashTool from './bash';
import bashOutputTool from './bash_output';
import bashKillTool from './bash_kill';
import { __resetBashJobs, getJob, killJob } from './bash-jobs';

type Result = {
  content: Array<{ text: string }>;
  _meta?: { shellExecution?: Record<string, unknown> };
};
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<Result> };
const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
const bashKill = bashKillTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-yield-integration-'));

function ctx() {
  return {
    projectDir: STATE,
    stateDir: STATE,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    signal: new AbortController().signal,
    emit: () => {},
    role: 'operator',
  } as never;
}

function payload(result: Result): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

afterEach(() => __resetBashJobs());

describe('capability:bash start-once response yield — integration', () => {
  it('returns terminal output for a command completing within its response window', async () => {
    const result = await bash.handler(
      {
        command: 'printf FAST-TERMINAL',
        timeout: 10_000,
        yield_after_ms: 5_000,
      },
      ctx(),
    );

    expect(result._meta?.shellExecution).toMatchObject({
      status: 'completed', exit_code: 0, running: false, yielded: false,
    });
    expect(result.content[0]?.text).toContain('FAST-TERMINAL');
  });

  it('returns the running job identity when its response window expires', async () => {
    const launch = payload(await bash.handler(
      { command: 'exec sleep 30', timeout: 60_000, yield_after_ms: 25 },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      expect(launch).toMatchObject({ status: 'running', yielded: true });
      expect(launch.bash_id).toEqual(expect.any(String));
      expect(launch.task_id).toEqual(expect.any(String));
      expect(job).toMatchObject({
        id: launch.bash_id,
        taskId: launch.task_id,
        status: 'running',
      });
    } finally {
      if (job) killJob(job);
    }
  });

  it('returns a usable full-output reference when its response window expires', async () => {
    const launch = payload(await bash.handler(
      { command: 'printf REFERENCE-PREFIX; exec sleep 30', timeout: 60_000, yield_after_ms: 25 },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      expect(launch.log_path).toEqual(expect.any(String));
      await expect.poll(() => readFileSync(String(launch.log_path), 'utf8'), { timeout: 5_000 })
        .toContain('REFERENCE-PREFIX');
    } finally {
      if (job) killJob(job);
    }
  });

  it('keeps the command alive after returning a response-window yield', async () => {
    const barrier = join(STATE, `yield-barrier-${crypto.randomUUID()}`);
    const marker = join(STATE, `yield-survived-${crypto.randomUUID()}`);
    const launch = payload(await bash.handler(
      {
        command: `while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
          `printf survived > ${JSON.stringify(marker)}`,
        timeout: 10_000,
        yield_after_ms: 25,
      },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      // Release only after the handler has returned: the write cannot be a
      // pre-yield effect masquerading as survival of the response deadline.
      expect(existsSync(marker)).toBe(false);
      writeFileSync(barrier, 'release');
      await expect.poll(() => existsSync(marker) ? readFileSync(marker, 'utf8') : '', { timeout: 5_000 })
        .toBe('survived');
    } finally {
      if (job) killJob(job);
    }
  });

  it('kills the running command descendant through the managed kill handler', async () => {
    const pidFile = join(STATE, `kill-descendant-${crypto.randomUUID()}`);
    const launch = payload(await bash.handler(
      {
        command: `sleep 30 & printf '%s' "$!" > ${JSON.stringify(pidFile)}; wait`,
        timeout: 60_000,
        yield_after_ms: 25,
      },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    let descendant: { pid: number; started: string } | undefined;
    const identity = (pid: number) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { state: fields[0], started: fields[19] };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    try {
      await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), { timeout: 5_000 })
        .toMatch(/^[1-9][0-9]*$/);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const before = identity(pid);
      expect(before).toBeDefined();
      expect(['Z', 'X']).not.toContain(before!.state);
      descendant = { pid, started: before!.started! };

      const killed = payload(await bashKill.handler({ bash_id: launch.bash_id }, ctx()));
      expect(killed).toMatchObject({ ok: true, status: 'killed' });
      // A ledger status is kill intent. Observe the actual owned descendant;
      // killing only the parent leaves this sleep alive and fails the test.
      await expect.poll(() => {
        const current = identity(pid);
        return !current || current.started !== descendant!.started || ['Z', 'X'].includes(current.state!);
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      if (job) killJob(job);
      // A regressed parent-only kill must not strand the test's child. Pin its
      // lifetime before cleanup so a reused PID can never target another task.
      if (descendant && identity(descendant.pid)?.started === descendant.started) {
        try { process.kill(descendant.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  });

  it('completes later through the yielded task without running the marker body twice', async () => {
    const marker = join(STATE, `integration-marker-${crypto.randomUUID()}.txt`);
    const launch = payload(
      await bash.handler(
        {
          command:
            `printf 'entered\\n' >> ${JSON.stringify(marker)}; sleep 0.35; ` +
            `printf 'finished\\n' >> ${JSON.stringify(marker)}; printf INTEGRATION-DONE`,
          timeout: 5_000,
          yield_after_ms: 25,
        },
        ctx(),
      ),
    );

    expect(launch).toMatchObject({ status: 'running', yielded: true, timeout_ms: 5_000 });
    const bashId = String(launch.bash_id);
    const taskId = String(launch.task_id);
    const originalJob = getJob(bashId);
    expect(originalJob?.taskId).toBe(taskId);

    let terminal: Record<string, unknown> | null = null;
    let output = String(launch.output ?? '');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const next = payload(await bashOutput.handler({ task_id: taskId, bash_id: bashId }, ctx()));
      output += String(next.output ?? '');
      if (next.status !== 'running') {
        terminal = next;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(terminal).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(getJob(bashId)).toBe(originalJob);
    expect(output).toContain('INTEGRATION-DONE');
    expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['entered', 'finished']);
    expect(readFileSync(String(launch.log_path), 'utf8')).toContain('INTEGRATION-DONE');
  });
});
