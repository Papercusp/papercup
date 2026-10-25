import { describe, expect, it, vi } from 'vitest';
import type { ToolResult, UnifiedToolContext } from '@papercusp/tooldef';
import { runDurableCode } from './durable-run';
import { inspectOrchestration } from '../orchestration/inspect';
import { runOrchestration, type ServerScriptRunDeps } from '../orchestration/run';
import { MAX_ORCHESTRATION_SCRIPT_CHARS, orchestrationScriptSourceSchema } from '../orchestration/public-contract';
import codeRunTool from './run';

const ctx = { workspaceId: 'ws-code', harnessSlug: 'papercusp', role: 'su', uiClientId: 'su-code',
  idempotencyKey: 'original-request' } as UnifiedToolContext;
const execution = { lifecycle: 'background', durability: 'durable', timeoutSec: 180 } as const;
const workflowId = 'orchestrate-durable:ws-code:original';
function payload(result: ToolResult) {
  const text = result.content.find(item => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing result');
  return JSON.parse(text.text);
}
function admission() {
  const startDurable = vi.fn().mockResolvedValue({ workflowId });
  const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
  return { startDurable, runCode, deps: { inspect: inspectOrchestration,
    run: (args: Parameters<typeof runOrchestration>[0], caller: UnifiedToolContext) =>
      runOrchestration(args, caller, { server: { startDurable, runCode } }) } };
}

describe('code:run durable adapter uses the existing orchestration lifecycle', () => {
  it('admits the exact large script, inputs, attribution and independent deadline once', async () => {
    const { deps, startDurable, runCode } = admission();
    const script = '/*' + 'large script '.repeat(2500) + '*/ return inputs.answer;';
    expect(script.length).toBeGreaterThan(20_000);
    expect(codeRunTool.args.safeParse({ script, execution }).success).toBe(true);
    expect(orchestrationScriptSourceSchema.safeParse({ source: script }).success).toBe(true);
    const result = payload(await runDurableCode({ script, execution, inputs: { answer: 42 }, work_item_id: 'WI-1' }, ctx, deps));
    expect(result.state, JSON.stringify(result)).toBe('complete');
    expect(JSON.parse(result.summary)).toEqual({ durableRun: { workflowId, status: 'admitted' } });
    expect(startDurable).toHaveBeenCalledTimes(1);
    expect(startDurable).toHaveBeenCalledWith(expect.objectContaining({
      script, inputs: { answer: 42 }, timeoutSec: 180, link: { workItemId: 'WI-1' },
      caller: { ownerId: 'su-code', workspaceId: 'ws-code', harnessSlug: 'papercusp', role: 'su' },
      pin: { sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bindingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }));
    expect(runCode).not.toHaveBeenCalled();
  });

  it.each(['return Date.now();', 'return Math.random();', 'await sleep(120000);'])('refuses replay-unsafe source before enqueue: %s', async script => {
    const { deps, startDurable, runCode } = admission();
    const result = payload(await runDurableCode({ script, execution }, ctx, deps));
    expect(result).toMatchObject({ state: 'error', error: { code: 'durable_replay_unsafe' } });
    expect(startDurable).not.toHaveBeenCalled();
    expect(runCode).not.toHaveBeenCalled();
  });

  it('refuses unknown tools before enqueue', async () => {
    const { deps, startDurable } = admission();
    const result = payload(await runDurableCode({ script: 'return await tools.no_such_tool.read({});', execution }, ctx, deps));
    expect(result.ok).toBe(false);
    expect(startDurable).not.toHaveBeenCalled();
  });

  it('reads the same terminal output without starting another workflow', async () => {
    const status = { workflowId, status: 'SUCCESS', outcome: { status: 'succeeded', summary: { answer: 42 }, steps: [] }, steps: [] };
    const durableStatus = vi.fn().mockResolvedValue(status);
    const run = vi.fn();
    const result = payload(await runDurableCode({ durableRun: { workflowId } }, ctx, {
      inspect: (args, caller) => inspectOrchestration(args, caller, { durableStatus }), run,
    }));
    expect(result).toEqual({ ok: true, durableRun: status });
    expect(durableStatus).toHaveBeenCalledExactlyOnceWith(workflowId);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses foreign-workspace reads and cancellation before touching DBOS', async () => {
    const foreign = 'orchestrate-durable:other:run';
    const durableStatus = vi.fn();
    const durableControl = vi.fn();
    const deps = { inspect: (args: Parameters<typeof inspectOrchestration>[0], caller: UnifiedToolContext) =>
      inspectOrchestration(args, caller, { durableStatus }),
    run: (args: Parameters<typeof runOrchestration>[0], caller: UnifiedToolContext) =>
      runOrchestration(args, caller, { durableControl }) };
    const read = payload(await runDurableCode({ durableRun: { workflowId: foreign } }, ctx, deps));
    const cancel = payload(await runDurableCode({ durableControl: { workflowId: foreign, action: 'cancel' } }, ctx, deps));
    expect(read).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
    expect(cancel).toMatchObject({ state: 'error', error: { code: 'capability_denied' } });
    expect(durableStatus).not.toHaveBeenCalled();
    expect(durableControl).not.toHaveBeenCalled();
  });

  it('cancels the existing workflow without executing source', async () => {
    const durableControl = vi.fn().mockResolvedValue(undefined);
    const result = payload(await runDurableCode({ durableControl: { workflowId, action: 'cancel' } }, ctx, {
      inspect: inspectOrchestration,
      run: (args, caller) => runOrchestration(args, caller, { durableControl }),
    }));
    expect(result.state).toBe('complete');
    expect(durableControl).toHaveBeenCalledExactlyOnceWith({ workflowId, action: 'cancel' });
  });

  it('rejects ambiguous selectors and foreground-only options without any adapter calls', async () => {
    const inspect = vi.fn(); const run = vi.fn();
    for (const extra of [{ kernel: {} }, { dryRun: true }, { timeoutSec: 10 }, { durableRun: { workflowId } }]) {
      expect(payload(await runDurableCode({ script: 'return 1;', execution, ...extra }, ctx, { inspect, run })))
        .toMatchObject({ ok: false, executed: false, error: 'durable_execution_args_invalid' });
    }
    expect(inspect).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it('bounds source size at the same limit on both public doors', () => {
    const script = 'x'.repeat(MAX_ORCHESTRATION_SCRIPT_CHARS + 1);
    expect(codeRunTool.args.safeParse({ script }).success).toBe(false);
    expect(orchestrationScriptSourceSchema.safeParse({ source: script }).success).toBe(false);
  });
});
