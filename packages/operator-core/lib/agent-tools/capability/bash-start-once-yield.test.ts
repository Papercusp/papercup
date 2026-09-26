/**
 * CAP-CONTRACT-P002-YIELD-SAME-JOB@1 — capability:bash ordinary calls start one
 * durable job, wait for fast completion, and yield that same job at the bounded
 * response window without killing or relaunching it.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unwrapToolResult } from '@papercusp/tooldef';

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'start-once-yield-test' },
  })),
}));

import bashTool from './bash';
import bashOutputTool from './bash_output';
import { __resetBashJobs, getJob } from './bash-jobs';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './foreground-transport-cap';

type ToolResult = {
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<ToolResult> };
type ArgsSchema = { safeParse: (value: unknown) => { success: boolean } };

const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-start-once-'));

function makeCtx(options: { signal?: AbortSignal; codeMode?: boolean; emitted?: string[] } = {}) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    signal: options.signal ?? new AbortController().signal,
    emit: (event: string, chunk: string) => {
      if (event === 'output') options.emitted?.push(chunk);
    },
    role: 'operator',
    ...(options.codeMode ? { codeMode: true } : {}),
  } as never;
}

function jsonPayload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function readUntilTerminal(bashId: string): Promise<{ payload: Record<string, unknown>; output: string }> {
  let output = '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await bashOutput.handler({ bash_id: bashId }, makeCtx());
    const payload = jsonPayload(result);
    output += String(payload.output ?? '');
    if (payload.status !== 'running') return { payload, output };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${bashId} did not reach a terminal status`);
}

afterEach(() => {
  __resetBashJobs();
});

describe('capability:bash — start once and yield the same durable job (P-002)', () => {
  it('warns that an empty process table cannot prove a host process is gone', async () => {
    const result = await bash.handler(
      { command: 'ps -eo pid --no-headers', timeout: 5_000 },
      makeCtx({ codeMode: true }),
    );
    expect(result.content[0]!.text).toContain('NOTICE: Process-table output may be limited');
    expect(result.structuredContent?.process_table_notice).toContain('does not prove a host process is gone');
    expect(result.content[0]!.text).toContain('processes:list');
  });

  it('publishes a separate bounded response-window argument', () => {
    const args = (bashTool as unknown as { args: ArgsSchema }).args;
    expect(args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: 10 }).success).toBe(true);
    expect(
      args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: FOREGROUND_TIMEOUT_CEILING_MS }).success,
    ).toBe(true);
    expect(
      args.safeParse({ command: 'true', timeout: 60_000, yield_after_ms: FOREGROUND_TIMEOUT_CEILING_MS + 1 }).success,
    ).toBe(false);
  });

  it('refuses an unjoined shell child for ordinary calls before creating a durable task', async () => {
    const result = await bash.handler(
      { command: 'sleep 30 & echo detached', timeout: 5_000, yield_after_ms: 50 },
      makeCtx({ codeMode: true }),
    );
    const seen = jsonPayload(result);

    expect(result.isError).toBe(true);
    expect(seen).toMatchObject({ ok: false, reason: 'untracked_shell_background' });
    expect(String(seen.message)).toContain('without joining it');
    expect(seen.task_id).toBeUndefined();
  });

  it('returns fast completion as a terminal direct result with a complete-output reference', async () => {
    const emitted: string[] = [];
    const result = await bash.handler(
      { command: 'printf FAST-TERMINAL', timeout: 5_000, yield_after_ms: 2_000 },
      makeCtx({ emitted }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('exit 0');
    expect(result.content[0]!.text).toContain('FAST-TERMINAL');
    expect(result.content[0]!.text).toContain('full output →');
    expect(emitted.join('')).toContain('FAST-TERMINAL');
  });

  it('yields one still-running job, then recovers later output and one execution through the same id', async () => {
    const marker = join(STATE, `start-once-marker-${crypto.randomUUID()}.txt`);
    const emitted: string[] = [];
    const result = await bash.handler(
      {
        command:
          `printf 'start\\n' >> ${JSON.stringify(marker)}; printf 'EARLY\\n'; ` +
          `sleep 0.5; printf 'LATE\\n'; printf 'done\\n' >> ${JSON.stringify(marker)}`,
        timeout: 5_000,
        yield_after_ms: 50,
      },
      makeCtx({ emitted, codeMode: true }),
    );
    const yielded = jsonPayload(result);

    expect(yielded).toMatchObject({
      ok: true,
      status: 'running',
      running: true,
      yielded: true,
      response_window_ms: 50,
      timeout_ms: 5_000,
    });
    expect(result.structuredContent).toEqual(yielded);
    expect(typeof yielded.bash_id).toBe('string');
    expect(typeof yielded.task_id).toBe('string');
    expect(typeof yielded.log_path).toBe('string');

    const bashId = String(yielded.bash_id);
    const originalJob = getJob(bashId);
    const originalPid = originalJob?.child.pid;
    const emittedAtYield = emitted.join('');
    expect(originalJob?.taskId).toBe(yielded.task_id);
    expect(originalPid).toBeTypeOf('number');

    const later = await readUntilTerminal(bashId);
    const sameJob = getJob(bashId);
    const combinedOutput = String(yielded.output ?? '') + later.output;
    expect(later.payload).toMatchObject({ status: 'completed', exit_code: 0, running: false });
    expect(sameJob).toBe(originalJob);
    expect(sameJob?.child.pid).toBe(originalPid);
    expect(combinedOutput).toContain('EARLY');
    expect(combinedOutput).toContain('LATE');
    expect(emitted.join('')).toBe(emittedAtYield);
    expect(emitted.join('')).not.toContain('LATE');
    expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'done']);
    expect(readFileSync(String(yielded.log_path), 'utf8')).toContain('LATE');
  });

  it('keeps timeout as the independent execution deadline', async () => {
    const result = await bash.handler(
      { command: 'printf BEFORE-TIMEOUT; sleep 10', timeout: 1_000, yield_after_ms: 2_000 },
      makeCtx({ codeMode: true }),
    );
    const seen = unwrapToolResult(result as never) as Record<string, unknown>;

    expect(seen).toMatchObject({
      ok: false,
      status: 'timed_out',
      running: false,
      yielded: false,
      timeout_ms: 1_000,
      response_window_ms: 2_000,
    });
    expect(String(seen.output)).toContain('BEFORE-TIMEOUT');
    expect(String(seen.log_path)).toContain('bash-');
  });

  it('treats caller abort as cancellation of that same whole process tree', async () => {
    const orphanMarker = join(STATE, `abort-orphan-${crypto.randomUUID()}.txt`);
    const controller = new AbortController();
    const resultPromise = bash.handler(
      {
        command: `(sleep 0.8; printf orphan > ${JSON.stringify(orphanMarker)}) & wait`,
        timeout: 5_000,
        yield_after_ms: 2_000,
      },
      makeCtx({ signal: controller.signal, codeMode: true }),
    );
    setTimeout(() => controller.abort(), 100);

    const result = await resultPromise;
    const seen = unwrapToolResult(result as never) as Record<string, unknown>;
    expect(seen.status).toBe('killed');
    expect(seen.running).toBe(false);
    expect(typeof seen.bash_id).toBe('string');
    expect(getJob(String(seen.bash_id))?.status).toBe('killed');

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(orphanMarker)).toBe(false);
  });
});
