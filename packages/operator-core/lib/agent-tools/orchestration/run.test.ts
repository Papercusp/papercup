import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS } from '../../output-envelope';
import orchestrateRunTool, { runServerScriptAdapter, serverScriptRunArgsSchema, type ServerScriptRunDeps } from './run';

function codeResult(payload: Record<string, unknown>, media: ToolResult['content'] = []): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }, ...media],
  } as ToolResult;
}

function envelope(result: ToolResult) {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing text envelope');
  return JSON.parse(text.text);
}

describe('orchestrate:run server-script adapter', () => {
  it('registers the server-only public shape', () => {
    expect(orchestrateRunTool.name).toBe('orchestrate:run');
    expect(
      serverScriptRunArgsSchema.parse({
        script: { source: 'return "ok";' },
        execution: { mode: 'server', lifecycle: 'foreground' },
        capture: { mode: 'auto' },
      }),
    ).toMatchObject({ script: { source: 'return "ok";' } });
    expect(() =>
      serverScriptRunArgsSchema.parse({
        script: { source: 'return "ok";' },
        execution: { mode: 'client' },
      }),
    ).toThrow();
  });

  it('delegates to code:run and emits the P-006 envelope without copying its payload', async () => {
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>().mockResolvedValue(
      codeResult({
        ok: true,
        summary: { count: 2, kept: true },
        dispatchCount: 2,
        intermediateBytes: 9_000,
        plannedMutations: [],
      }),
    );
    const metadata = vi.fn();
    const result = await runServerScriptAdapter(
      {
        script: { source: 'return { count: 2, kept: true };', title: 'script title' },
        capture: { mode: 'never', title: 'capture title' },
        execution: { mode: 'auto' },
        timeoutSec: 120,
      },
      { metadata } as unknown as UnifiedToolContext,
      { runCode },
    );

    expect(runCode).toHaveBeenCalledWith(
      {
        script: 'return { count: 2, kept: true };',
        title: 'capture title',
        timeoutSec: 120,
      },
      expect.any(Object),
      'never',
    );
    expect(envelope(result)).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '{"count":2,"kept":true}',
      summaryProvenance: 'authored',
      content: [],
      state: 'complete',
      metrics: {
        backend: 'server',
        toolCalls: 3,
        intermediateBytes: 9_000,
        requestedTimeoutSec: 120,
        requestedExecutionMode: 'auto',
        executionMode: 'server',
        executionModeDeprecated: true,
        captureMode: 'never',
      },
    });
    expect(envelope(result)).not.toHaveProperty('logs');
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ backend: 'server' }));
  });

  it('preserves explicitly returned image/audio blocks outside the JSON envelope', async () => {
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    const result = await runServerScriptAdapter({ script: { source: 'return media;' } }, {} as UnifiedToolContext, {
      runCode: async () => codeResult({ ok: true, summary: 'rendered' }, [image]),
    });

    expect(envelope(result).summary).toBe('rendered');
    expect(result.content[1]).toEqual(image);
  });

  it('rejects background lifecycle before invoking code:run', async () => {
    const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
    const result = await runServerScriptAdapter(
      {
        script: { source: 'return "no";' },
        execution: { lifecycle: 'background' },
      },
      {} as UnifiedToolContext,
      { runCode },
    );

    expect(runCode).not.toHaveBeenCalled();
    expect(envelope(result)).toMatchObject({
      state: 'error',
      error: { code: 'lifecycle_unavailable' },
      metrics: { phase: 'preflight', executed: false },
    });
  });

  it('rejects an oversized authored summary without truncating or auto-summarizing it', async () => {
    const summary = 'x'.repeat(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS + 1);
    const result = await runServerScriptAdapter({ script: { source: 'return tooLarge;' } }, {} as UnifiedToolContext, {
      runCode: async () => codeResult({ ok: true, summary }),
    });
    const body = envelope(result);

    expect(body).toMatchObject({
      summary: '',
      state: 'error',
      error: { code: 'summary_budget_exceeded' },
      metrics: { phase: 'execution', executed: true },
    });
    expect(JSON.stringify(body)).not.toContain(summary);
  });

  it('maps child failures to an explicit incomplete state', async () => {
    const result = await runServerScriptAdapter({ script: { source: 'return "partial";' } }, {} as UnifiedToolContext, {
      runCode: async () =>
        codeResult({
          ok: true,
          summary: 'partial',
          childFailures: [{ tool: 'x:y', kind: 'semantic' }],
        }),
    });

    expect(envelope(result)).toMatchObject({
      summary: 'partial',
      state: 'incomplete',
      incomplete: { reason: 'partial_execution' },
      metrics: { childFailureCount: 1 },
    });
  });
});
