import { describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelRequest } from './model-port';
import { createOperatorOwnedLoopPort } from './headless-invoke';

describe('createOperatorOwnedLoopPort', () => {
  it.each(['provider-error', 'capture-error', 'capture-abort'])('awaits trusted capture in a headless %s turn and retains failure', async mode => {
    const controller = new AbortController();
    const request = { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-headless' } };
    let pulled = false;
    let closed = false;
    const modelPort: ModelPort = { async *stream() { try {
      yield { type: 'provider_request', request, servedAccount: 'local-account' };
      pulled = true;
      yield { type: 'error', message: 'provider unavailable' };
    } finally { closed = true; } } };
    const capture = vi.fn(async () => {
      if (mode !== 'provider-error') {
        if (mode === 'capture-abort') controller.abort();
        throw new Error('durable capture unavailable');
      }
    });
    const flushTelemetry = vi.fn(async () => {});
    const events: unknown[] = [];
    const outcome = await createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry,
      onProviderRequest: capture }).invoke({ role: 'worker', prompt: 'do work', model: 'openrouter:vendor/model',
      runId: 'run-capture', featureId: null, chunkId: null, workspaceId: 'ws', harnessSlug: 'papercusp',
      projectDir: '/repo', stateDir: '/repo/.papercusp', cwd: '/repo', signal: controller.signal,
      emit: event => events.push(event) });
    expect(capture).toHaveBeenCalledExactlyOnceWith({ stepIndex: 0, request, servedAccount: 'local-account' },
      { runId: 'run-capture', workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain(mode === 'provider-error' ? 'provider unavailable' : 'durable capture unavailable');
    expect(pulled).toBe(mode === 'provider-error');
    expect(closed).toBe(true);
    expect(events.some(event => (event as { type: string }).type === 'step_end')).toBe(false);
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });
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
    const flushTelemetry = vi.fn(async () => {});
    const port = createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry });
    const events: unknown[] = [];

    const outcome = await port.invoke({
      role: 'worker',
      prompt: '# WORKER\n\nImplement the chunk.',
      model: 'claude-sonnet-4-6',
      runId: 'run-010',
      featureId: 'F-010',
      chunkId: 'ck-010',
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
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });

  it('maps an in-loop error to a non-zero one-shot outcome', async () => {
    const modelPort: ModelPort = {
      async *stream() {
        yield { type: 'error', message: 'provider unavailable' };
      },
    };
    const events: unknown[] = [];
    const flushTelemetry = vi.fn(async () => {});
    const outcome = await createOperatorOwnedLoopPort({ modelPort, tools: [], flushTelemetry }).invoke({
      role: 'worker',
      prompt: 'do work',
      model: 'claude-sonnet-4-6',
      runId: 'run-error',
      featureId: null,
      chunkId: null,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      projectDir: '/repo',
      stateDir: '/repo/.papercusp',
      cwd: '/repo',
      emit: (event) => events.push(event),
    });

    expect(outcome).toEqual({ exitCode: 1, stderr: 'provider unavailable' });
    expect(events.some((event) => (event as { type?: string }).type === 'error')).toBe(true);
    expect(flushTelemetry).toHaveBeenCalledTimes(1);
  });
});
