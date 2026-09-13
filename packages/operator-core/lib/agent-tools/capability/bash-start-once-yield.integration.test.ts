/**
 * Integration-layer acceptance for CAP-CONTRACT-P002-YIELD-SAME-JOB@1.
 *
 * This crosses the real capability handler → durable bash-job registry → later
 * bash_output handler boundary. It deliberately keeps the execution sandbox off;
 * sandbox correctness has its own real-wrapper integration suite, while this test
 * owns job identity and response-lifecycle continuity.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
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
import { __resetBashJobs, getJob } from './bash-jobs';

type Result = { content: Array<{ text: string }> };
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<Result> };
const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
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
