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
import { getTask } from '../../task-manager/store';

type Result = {
  content: Array<{ text: string }>;
  _meta?: { shellExecution?: Record<string, unknown> };
};
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<Result> };
const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
const bashKill = bashKillTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-yield-integration-'));

function ctx(signal = new AbortController().signal) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    signal,
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
    const barrier = join(STATE, `reference-barrier-${crypto.randomUUID()}`);
    const launch = payload(await bash.handler(
      {
        command: `printf REFERENCE-PREFIX; while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
          'printf REFERENCE-COMPLETE',
        timeout: 10_000,
        yield_after_ms: 25,
      },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      expect(launch.log_path).toEqual(expect.any(String));
      expect(launch.log_path).toBe(job?.logPath);
      expect(existsSync(String(launch.log_path))).toBe(true);
      // The reference must exist on return, while an unfinished credential-like
      // token may legitimately remain in the redactor until command completion.
      writeFileSync(barrier, 'release');
      await expect.poll(() => readFileSync(String(launch.log_path), 'utf8'), { timeout: 5_000 })
        .toContain('REFERENCE-PREFIXREFERENCE-COMPLETE');
    } finally {
      writeFileSync(barrier, 'release');
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

  it('reports the execution deadline separately from a response-window yield', async () => {
    const controller = new AbortController();
    const result = await bash.handler(
      { command: 'exec sleep 30', timeout: 300, yield_after_ms: 5_000 },
      ctx(controller.signal),
    );
    const job = getJob(String(result._meta?.shellExecution?.bash_id));
    try {
      expect(result._meta?.shellExecution).toMatchObject({
        status: 'timed_out', running: false, yielded: false,
      });
      expect(job).toBeDefined();
      expect(job?.status).toBe('timed_out');
      expect(job?.endedAt).not.toBeNull();
      expect(result.content[0]?.text).toContain('execution deadline reached');
      expect(job?.killReason).toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
    } finally {
      if (job) killJob(job);
    }
  });

  it('reports caller abort separately from execution and response deadlines', async () => {
    const ready = join(STATE, `abort-ready-${crypto.randomUUID()}`);
    const controller = new AbortController();
    const response = bash.handler(
      {
        command: `printf ready > ${JSON.stringify(ready)}; exec sleep 30`,
        timeout: 30_000,
        yield_after_ms: 10_000,
      },
      ctx(controller.signal),
    );
    try {
      // Abort only after the command itself ran: a preflight cancellation
      // cannot masquerade as stopping the admitted, running command.
      await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
      controller.abort();
      const result = await response;
      expect(result._meta?.shellExecution).toMatchObject({
        status: 'killed', running: false, yielded: false,
      });
      const job = getJob(String(result._meta?.shellExecution?.bash_id));
      expect(job).toBeDefined();
      expect(job?.killReason).toBe('caller aborted the response request');
      expect(job?.deadlineReason).toBeUndefined();
      expect(job?.endedAt).not.toBeNull();
    } finally {
      controller.abort();
      await response;
    }
  }, 20_000);

  it('reports explicit kill separately from execution deadline and caller abort', async () => {
    const controller = new AbortController();
    const launch = payload(await bash.handler(
      { command: 'exec sleep 30', timeout: 30_000, yield_after_ms: 25 },
      ctx(controller.signal),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      expect(job).toBeDefined();
      const killed = payload(await bashKill.handler({ bash_id: launch.bash_id }, ctx()));
      expect(killed).toMatchObject({ ok: true, status: 'killed' });
      await expect.poll(() => job?.endedAt, { timeout: 5_000 }).not.toBeNull();
      const terminal = payload(await bashOutput.handler({ bash_id: launch.bash_id }, ctx()));
      expect(terminal.status).toBe('killed');
      expect(job?.killReason).toBe('capability:bash_kill requested termination');
      expect(job?.deadlineReason).toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
    } finally {
      if (job) killJob(job);
    }
  });

  it.each([0, 7, 37])('preserves observed exit %i through the command handler', async (exitCode) => {
    const result = await bash.handler(
      { command: `printf EXIT-TRUTH; exit ${exitCode}`, timeout: 10_000, yield_after_ms: 25 },
      ctx(),
    );
    let terminal = result._meta?.shellExecution;
    let output = result.content[0]?.text ?? '';
    let job: ReturnType<typeof getJob>;
    try {
      // Exit truth is independent of response timing. Follow only an actual
      // yielded handle; keep refusals visible instead of treating them as jobs.
      if (!terminal) {
        const launch = payload(result);
        expect(launch, JSON.stringify(result)).toMatchObject({
          yielded: true,
          bash_id: expect.any(String),
          task_id: expect.any(String),
        });
        job = getJob(String(launch.bash_id));
        expect(job, JSON.stringify(launch)).toMatchObject({
          id: launch.bash_id, taskId: launch.task_id,
        });
        output = String(launch.output ?? '');
        await expect.poll(async () => {
          terminal = payload(await bashOutput.handler(
            { bash_id: launch.bash_id, task_id: launch.task_id }, ctx(),
          ));
          output += String(terminal.output ?? '');
          return terminal.status;
        }, { timeout: 5_000 }).not.toBe('running');
      }
      expect(terminal, JSON.stringify(terminal)).toMatchObject({
        status: exitCode === 0 ? 'completed' : 'failed',
        exit_code: exitCode,
        running: false,
      });
      expect(output).toContain('EXIT-TRUTH');
    } finally {
      if (job) killJob(job);
    }
  }, 20_000);

  it('kills the running command descendant through the managed kill handler', async () => {
    const barrier = join(STATE, `descendant-barrier-${crypto.randomUUID()}`);
    const killedMarker = join(STATE, `killed-descendant-${crypto.randomUUID()}`);
    const controlMarker = join(STATE, `control-descendant-${crypto.randomUUID()}`);
    const jobs: Array<NonNullable<ReturnType<typeof getJob>>> = [];
    const launchDescendant = async (marker: string) => {
      const ready = `${marker}.ready`;
      const launch = payload(await bash.handler(
        {
          command: `( printf ready > ${JSON.stringify(ready)}; ` +
            `while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
            `printf survived > ${JSON.stringify(marker)} ) & wait`,
          timeout: 10_000,
          yield_after_ms: 25,
        },
        ctx(),
      ));
      const job = getJob(String(launch.bash_id));
      if (job) jobs.push(job);
      expect(job).toBeDefined();
      await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
      return { launch, job: job! };
    };
    try {
      const { launch, job } = await launchDescendant(killedMarker);
      await launchDescendant(controlMarker);
      const killed = payload(await bashKill.handler({ bash_id: launch.bash_id }, ctx()));
      expect(killed).toMatchObject({ ok: true, status: 'killed' });
      // Kill intent alone is insufficient. Wait for the launching process to
      // close, then release both descendants through the same filesystem gate.
      // A parent-only kill leaves its orphan able to write the forbidden marker.
      await expect.poll(() => job.endedAt, { timeout: 5_000 }).not.toBeNull();
      writeFileSync(barrier, 'release');
      await expect.poll(() => existsSync(controlMarker), { timeout: 5_000 }).toBe(true);
      const until = Date.now() + 1_000;
      while (Date.now() < until) {
        expect(existsSync(killedMarker)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      // Namespace-local PIDs are never interpreted or signalled by the host.
      // Release first so even a regressed orphan can terminate naturally.
      writeFileSync(barrier, 'release');
      for (const job of jobs) killJob(job);
    }
  }, 20_000);

  it('retrieves the original command from a fresh caller context using only its durable task handle', async () => {
    const barrier = join(STATE, `carry-barrier-${crypto.randomUUID()}`);
    const marker = `${barrier}.invocations`;
    const previous = new AbortController();
    const launch = payload(await bash.handler(
      {
        command: `printf 'entered\\n' >> ${JSON.stringify(marker)}; ` +
          `while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
          `printf 'finished\\n' >> ${JSON.stringify(marker)}; printf CARRIED-COMPLETION`,
        timeout: 15_000,
        yield_after_ms: 25,
      },
      ctx(previous.signal),
    ));
    const originalJob = getJob(String(launch.bash_id));
    try {
      expect(launch).toMatchObject({ status: 'running', yielded: true, task_id: expect.any(String) });
      expect(originalJob).toBeDefined();
      // Carry only the serialized durable handle into a new request context.
      // This is a handler boundary, not a claimed live-session carry drill.
      const carried = JSON.parse(JSON.stringify({ task_id: launch.task_id }));
      previous.abort();
      expect(payload(await bashOutput.handler(carried, ctx()))).toMatchObject({
        bash_id: launch.bash_id, task_id: launch.task_id, status: 'running',
      });
      writeFileSync(barrier, 'release');
      await expect.poll(async () => payload(await bashOutput.handler(carried, ctx())), { timeout: 5_000 })
        .toMatchObject({ status: 'completed', exit_code: 0 });
      expect(getJob(String(launch.bash_id))).toBe(originalJob);
      expect(readFileSync(String(launch.log_path), 'utf8')).toContain('CARRIED-COMPLETION');
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['entered', 'finished']);
    } finally {
      writeFileSync(barrier, 'release');
      if (originalJob) killJob(originalJob);
    }
  }, 20_000);

  it('recovers the original terminal command after the process-local job registry is cleared', async () => {
    const barrier = join(STATE, `registry-barrier-${crypto.randomUUID()}`);
    const marker = `${barrier}.invocations`;
    const launch = payload(await bash.handler(
      {
        command: `printf 'entered\\n' >> ${JSON.stringify(marker)}; ` +
          `while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
          'printf REGISTRY-RECOVERED',
        timeout: 15_000,
        yield_after_ms: 25,
      },
      ctx(),
    ));
    const originalJob = getJob(String(launch.bash_id));
    try {
      expect(originalJob).toBeDefined();
      writeFileSync(barrier, 'release');
      await expect.poll(() => originalJob?.endedAt, { timeout: 5_000 }).not.toBeNull();
      await expect.poll(async () => (await getTask(String(launch.task_id)))?.state, { timeout: 5_000 })
        .toBe('exited');
      // Clear only after real child close and the durable exit have been observed.
      // Recovery must now read the ledger/log, with no live job to reuse.
      __resetBashJobs();
      expect(getJob(String(launch.bash_id))).toBeUndefined();
      const recovered = payload(await bashOutput.handler({ task_id: launch.task_id }, ctx()));
      expect(recovered).toMatchObject({
        bash_id: launch.bash_id, task_id: launch.task_id, status: 'completed', exit_code: 0,
      });
      expect(String(recovered.output)).toContain('REGISTRY-RECOVERED');
      expect(getJob(String(launch.bash_id))).toBeUndefined();
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['entered']);
    } finally {
      writeFileSync(barrier, 'release');
      if (originalJob) killJob(originalJob);
    }
  }, 20_000);

  it('keeps the command running until its owned background descendant completes', async () => {
    const barrier = join(STATE, `terminal-descendant-${crypto.randomUUID()}`);
    const ready = `${barrier}.ready`;
    const finished = `${barrier}.finished`;
    const launch = payload(await bash.handler(
      {
        command: `( printf ready > ${JSON.stringify(ready)}; ` +
          `while [ ! -e ${JSON.stringify(barrier)} ]; do sleep 0.02; done; ` +
          `printf finished > ${JSON.stringify(finished)} ) & wait; printf DESCENDANT-COMPLETE`,
        timeout: 15_000,
        yield_after_ms: 25,
      },
      ctx(),
    ));
    const job = getJob(String(launch.bash_id));
    try {
      expect(job).toBeDefined();
      await expect.poll(() => existsSync(ready), { timeout: 5_000 }).toBe(true);
      expect(existsSync(finished)).toBe(false);
      expect(payload(await bashOutput.handler({ task_id: launch.task_id }, ctx())))
        .toMatchObject({ status: 'running' });
      writeFileSync(barrier, 'release');
      await expect.poll(async () => payload(await bashOutput.handler({ task_id: launch.task_id }, ctx())),
        { timeout: 5_000 }).toMatchObject({ status: 'completed', exit_code: 0 });
      expect(readFileSync(finished, 'utf8')).toBe('finished');
      expect(readFileSync(String(launch.log_path), 'utf8')).toContain('DESCENDANT-COMPLETE');
      expect(job?.endedAt).not.toBeNull();
    } finally {
      writeFileSync(barrier, 'release');
      if (job) killJob(job);
    }
  }, 20_000);

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
