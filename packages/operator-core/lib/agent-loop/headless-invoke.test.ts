import { describe, expect, it } from 'vitest';
import type { ModelPort, ModelRequest } from './model-port';
import { createOperatorOwnedLoopPort } from './headless-invoke';

describe('createOperatorOwnedLoopPort', () => {
  it('runs one prompt through the owned ModelPort and emits bounded native events', async () => {
    const requests: ModelRequest[] = [];
    const modelPort: ModelPort = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'headless result' };
        yield {
          type: 'stop',
          reason: 'end_turn',
          usage: { inputTokens: 14, outputTokens: 4, costUsd: 0.002 },
        };
      },
    };
    const port = createOperatorOwnedLoopPort({ modelPort, tools: [] });
    const events: unknown[] = [];

    const outcome = await port.invoke({
      role: 'worker',
      prompt: '# WORKER\n\nImplement the chunk.',
      model: 'claude-sonnet-4-6',
      runId: 'run-010',
      featureId: 'F-010',
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      projectDir: '/repo',
      stateDir: '/repo/.papercusp',
      cwd: '/repo/.papercusp/worktrees/F-010',
      emit: (event) => events.push(event),
    });

    expect(outcome).toEqual({ exitCode: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      system: '',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '# WORKER\n\nImplement the chunk.' }],
      }],
    });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'step_start',
      'text_delta',
      'step_end',
      'done',
    ]);
    const done = events.at(-1) as Record<string, unknown>;
    expect(done).toMatchObject({
      type: 'done',
      finalText: 'headless result',
      usage: { inputTokens: 14, outputTokens: 4, costUsd: 0.002 },
      stepCount: 1,
    });
    expect(done.messages).toBeUndefined();
  });

  it('maps an in-loop error to a non-zero one-shot outcome', async () => {
    const modelPort: ModelPort = {
      async *stream() {
        yield { type: 'error', message: 'provider unavailable' };
      },
    };
    const events: unknown[] = [];
    const outcome = await createOperatorOwnedLoopPort({ modelPort, tools: [] }).invoke({
      role: 'worker',
      prompt: 'do work',
      model: 'claude-sonnet-4-6',
      runId: 'run-error',
      featureId: null,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      projectDir: '/repo',
      stateDir: '/repo/.papercusp',
      cwd: '/repo',
      emit: (event) => events.push(event),
    });

    expect(outcome).toEqual({ exitCode: 1, stderr: 'provider unavailable' });
    expect(events.some((event) => (event as { type?: string }).type === 'error')).toBe(true);
  });
});
