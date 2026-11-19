import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool, dispatchProjectedTool, _resetCatalogForTests, _resetProjectionRegistryForTests, lookupByMcpName,
  type ToolExecutionRequest, type UnifiedToolContext, type ToolExecutionAdmission,
} from '@papercusp/tooldef';
import {
  startDurableOrchestration, getDurableOrchestrationStatus, bindDurableOrchestrationExecution,
  DURABLE_ORCHESTRATION_EXECUTION_ADAPTER,
  type DurableOrchestrationClient, type DurableOrchestrationInput, type DurableOrchestrationOutcome,
} from '../dbos/durable-orchestration-workflow';
import { effectiveMcpDeadlineMs, raceDeadline } from '../endpoint-route/routes/transport/_mcp-host';
import * as sensitiveText from '../sensitive-text';

vi.mock('../dbos/bootstrap', () => ({ dbosStarted: () => false, withDbosIdleTxGrace: (value: string) => value }));
afterEach(() => { vi.useRealTimers(); _resetCatalogForTests(); _resetProjectionRegistryForTests(); });

/** The existing request-side DBOS client boundary. Records survive dispatcher/module recreation. */
function durableFixture(options: {
  terminal?: boolean; persist?: boolean; requestBound?: boolean; settleAfterMs?: number;
  yieldReplacement?: boolean; yieldAfterMs?: number; liveInteraction?: boolean;
} = {}) {
  const records = new Map<string, { status: string; input?: [DurableOrchestrationInput]; output?: DurableOrchestrationOutcome; error?: unknown }>();
  const outcome: DurableOrchestrationOutcome = { status: 'succeeded', summary: 'original business result', steps: [] };
  const enqueue = vi.fn<DurableOrchestrationClient['enqueue']>(async (admission, input) => {
    if (options.persist !== false) records.set(admission.workflowID, {
      status: options.terminal ? 'SUCCESS' : 'PENDING', input: [structuredClone(input)],
      ...(options.terminal ? { output: structuredClone(outcome) } : {}),
    });
    if (options.settleAfterMs !== undefined) setTimeout(() => {
      const row = records.get(admission.workflowID)!;
      row.status = 'SUCCESS'; row.output = structuredClone(outcome);
    }, options.settleAfterMs);
    return { workflowID: admission.workflowID };
  });
  const client: DurableOrchestrationClient = { enqueue,
    getWorkflow: async handle => records.get(handle), listWorkflowSteps: async () => [],
    cancelWorkflow: async () => {}, send: async () => {},
  };
  const deps = { client: async () => client };
  const handler = vi.fn(async (_args: { value: number }, ctx: UnifiedToolContext) => {
    const admitted = await startDurableOrchestration({ runKey: 'original-operation', script: 'return 7',
      caller: { ownerId: ctx.uiClientId!, workspaceId: ctx.workspaceId!, role: ctx.role!,
        ...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),
        ...(ctx.principal ? { principal: { kind: ctx.principal.kind, slug: ctx.principal.slug,
          workspaceId: ctx.principal.workspaceId } } : {}),
      },
      pin: { sourceSha256: 'original-source', bindingsSha256: 'original-bindings' }, timeoutSec: 60,
    }, deps);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ durableRun: admitted }) }],
      structuredContent: admitted };
  });
  const definition = defineTool({ name: 'execution_contract:dbos_probe', description: 'Existing DBOS contract fixture',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'],
    args: z.object({ value: z.number() }), handler,
    ...(options.requestBound ? { execution: { liveInteraction: options.liveInteraction === true } } : { execution: { lifecycle: 'independent' as const,
      adapter: DURABLE_ORCHESTRATION_EXECUTION_ADAPTER } }),
  });
  const tool = lookupByMcpName(definition.name)!;
  const dispatch = (request: ToolExecutionRequest = {}, extra: Partial<UnifiedToolContext> = {},
    dispatcher = dispatchProjectedTool) => dispatcher(tool, definition.name, { value: 7 }, {
      log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
      workspaceId: 'p003-runtime', role: 'operator', uiClientId: 'original-owner',
      toolExecution: request, executionDeadlineAtMs: Date.now() + 60000,
      transportResponseDeadlineAtMs: Date.now() + 55000, ...extra,
    }, { executionAdapter: request => {
      const bound = bindDurableOrchestrationExecution(request, deps);
      if (options.yieldAfterMs !== undefined) return { ...bound,
        dispatch: selection => bound.dispatch({ ...selection, autoYieldAfterMs: options.yieldAfterMs! }),
      };
      if (!options.yieldReplacement) return bound;
      // Single injected defect: yielding creates a replacement DBOS job.
      return { ...bound, dispatch: async selection => {
        const admitted = await bound.dispatch(selection);
        const original = records.get(admitted.admission.handle)!.input![0];
        await startDurableOrchestration({ ...original, runKey: 'replacement-operation' }, deps);
        return admitted;
      } };
    } });
  return { records, outcome, enqueue, handler, tool, dispatch, deps };
}

describe('DBOS original harness scope', () => {
  it.each([
    ['original-harness', 'foreign-harness'],
    ['original-harness', undefined],
    ['original-harness', '*'],
    [undefined, 'foreign-harness'],
  ])('refuses original scope %s readback from %s without releasing result bytes', async (originalHarness, foreignHarness) => {
    const runtime = durableFixture({ terminal: true });
    const original = { harnessSlug: originalHarness };
    const admitted = await runtime.dispatch({ mode: 'sync' }, original);
    expect(admitted).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    const persisted = structuredClone(runtime.records.get(handle));
    const foreign = await runtime.dispatch({ mode: 'sync', handle }, { harnessSlug: foreignHarness });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    expect(JSON.stringify(foreign)).not.toContain('original business result');
    expect(runtime.records.get(handle)).toEqual(persisted);
    const recovered = await runtime.dispatch({ mode: 'sync', handle }, original);
    expect(recovered).toMatchObject({ ok: true, result: { _meta: { toolExecution: { handle } } } });
    expect(recovered.ok && JSON.stringify(recovered.result)).toContain('original business result');
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it('refuses a lost persisted harness join and recovers the unchanged original result when repaired', async () => {
    const runtime = durableFixture({ terminal: true });
    const original = { harnessSlug: 'original-harness' };
    expect(await runtime.dispatch({ mode: 'sync' }, original)).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    const caller = runtime.records.get(handle)!.input![0].caller;
    delete caller.harnessSlug;
    const orphaned = await runtime.dispatch({ mode: 'sync', handle }, original);
    expect(orphaned).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    expect(JSON.stringify(orphaned)).not.toContain('original business result');
    caller.harnessSlug = original.harnessSlug;
    const repaired = await runtime.dispatch({ mode: 'sync', handle }, original);
    expect(repaired.ok && JSON.stringify(repaired.result)).toContain('original business result');
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it('uses canonical unscoped normalization for an original workspace-level run', async () => {
    const runtime = durableFixture({ terminal: true });
    expect(await runtime.dispatch({ mode: 'sync' })).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    expect(await runtime.dispatch({ mode: 'sync', handle }, { harnessSlug: '*' })).toMatchObject({ ok: true });
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });
});

describe('DBOS original caller identity', () => {
  const principal = { kind: 'system' as const, slug: 'original-principal', workspaceId: 'p003-runtime',
    authMethod: 'process-internal' as const, trust: 'trusted' as const, capabilities: new Set(['tasks:read']) };

  it.each([
    { ...principal, slug: 'foreign-principal' },
    { ...principal, workspaceId: 'foreign-workspace' },
    { ...principal, kind: 'service' as const },
    undefined,
  ])('refuses a different or missing principal before releasing the original result (%j)', async foreignPrincipal => {
    const runtime = durableFixture({ terminal: true });
    expect(await runtime.dispatch({ mode: 'sync' }, { principal })).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    const persisted = structuredClone(runtime.records.get(handle));
    const foreign = await runtime.dispatch({ mode: 'sync', handle }, { principal: foreignPrincipal });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    expect(JSON.stringify(foreign)).not.toContain('original business result');
    expect(runtime.records.get(handle)).toEqual(persisted);
    const freshDispatcher = (await import('@papercusp/tooldef')).dispatchProjectedTool;
    const recovered = await runtime.dispatch({ mode: 'sync', handle }, { principal }, freshDispatcher);
    expect(recovered.ok && JSON.stringify(recovered.result)).toContain('original business result');
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it.each(['principal', 'role'] as const)('refuses a lost or changed persisted %s join and recovers after repair', async field => {
    const runtime = durableFixture({ terminal: true });
    expect(await runtime.dispatch({ mode: 'sync' }, { principal })).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    const caller = runtime.records.get(handle)!.input![0].caller;
    const original = structuredClone(caller);
    if (field === 'principal') delete caller.principal;
    else caller.role = 'worker';
    const orphaned = await runtime.dispatch({ mode: 'sync', handle }, { principal });
    expect(orphaned).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    expect(JSON.stringify(orphaned)).not.toContain('original business result');
    Object.assign(caller, original);
    const repaired = await runtime.dispatch({ mode: 'sync', handle }, { principal });
    expect(repaired.ok && JSON.stringify(repaired.result)).toContain('original business result');
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it('does not grant a new principal access to a historical admission without a principal join', async () => {
    const runtime = durableFixture({ terminal: true });
    expect(await runtime.dispatch({ mode: 'sync' })).toMatchObject({ ok: true });
    const handle = [...runtime.records.keys()][0]!;
    const foreign = await runtime.dispatch({ mode: 'sync', handle }, { principal });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    expect(JSON.stringify(foreign)).not.toContain('original business result');
    expect((await runtime.dispatch({ mode: 'sync', handle })).ok).toBe(true);
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });
});

describe('DBOS execution result redaction', () => {
  const secret = 'p003-sample-result-secret-917a6e42';
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function seededRuntime() {
    vi.stubEnv('P003_RESULT_SECRET', secret);
    const runtime = durableFixture({ terminal: true });
    if (runtime.outcome.status !== 'succeeded') throw new Error('Expected succeeded fixture');
    runtime.outcome.summary = {
      text: 'child result ' + secret,
      accessToken: 'sample-key-directed-value',
      credentialRef: 'credential:original-reference',
      detail: 'x'.repeat(2001) + ':decisive-tail',
    };
    return runtime;
  }

  function assertProtected(result: Awaited<ReturnType<ReturnType<typeof seededRuntime>['dispatch']>>) {
    expect(result.ok).toBe(true);
    const bytes = JSON.stringify(result);
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('sample-key-directed-value');
    expect(bytes).toContain('[redacted]');
    expect(bytes).toContain('credential:original-reference');
    expect(bytes).toContain('x'.repeat(2001) + ':decisive-tail');
  }

  it('redacts initial result and fresh-adapter readback without changing the original record or admission', async () => {
    const runtime = seededRuntime();
    assertProtected(await runtime.dispatch({ mode: 'sync' }));
    const handle = [...runtime.records.keys()][0]!;
    expect(JSON.stringify(runtime.records.get(handle)!.output)).toContain(secret);
    const freshDispatcher = (await import('@papercusp/tooldef')).dispatchProjectedTool;
    assertProtected(await runtime.dispatch({ mode: 'sync', handle }, {}, freshDispatcher));
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it('detects bypass of only the adapter redactor and passes the repaired readback on the same handle', async () => {
    const runtime = seededRuntime();
    assertProtected(await runtime.dispatch({ mode: 'sync' }));
    const handle = [...runtime.records.keys()][0]!;
    const bypass = vi.spyOn(sensitiveText, 'redactStructuredSensitiveValue').mockImplementation(value => value);
    const exposed = await runtime.dispatch({ mode: 'sync', handle });
    expect(bypass).toHaveBeenCalled();
    expect(JSON.stringify(exposed)).toContain(secret);
    expect(() => assertProtected(exposed)).toThrow();
    bypass.mockRestore();
    assertProtected(await runtime.dispatch({ mode: 'sync', handle }));
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });

  it('redacts a detached runtime error on lookup while preserving the original runtime record', async () => {
    vi.stubEnv('P003_RESULT_SECRET', secret);
    const runtime = durableFixture();
    const admitted = await runtime.dispatch({ mode: 'async' });
    expect(admitted).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: false } } } });
    const handle = [...runtime.records.keys()][0]!;
    const row = runtime.records.get(handle)!;
    row.status = 'ERROR'; row.error = 'child failed with ' + secret;
    const result = await runtime.dispatch({ mode: 'sync', handle });
    expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: { state: 'failed', terminal: true } } } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[redacted]');
    expect(row.error).toContain(secret);
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });
});

describe('unified execution', () => {
  describe('R-22 > P-003', () => {
    it('control', async () => {
      const runtime = durableFixture();
      const result = await runtime.dispatch({ mode: 'async' });
      expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        handle: 'orchestrate-durable:p003-runtime:original-operation', ownerId: 'original-owner',
        state: 'running', terminal: false, mode: 'async',
      } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.handler).toHaveBeenCalledOnce();
      const persisted = [...runtime.records.values()][0]!.input![0];
      expect(persisted.caller).toEqual({ ownerId: 'original-owner', workspaceId: 'p003-runtime', role: 'operator' });
    });
    it('counterexample', async () => {
      const runtime = durableFixture({ persist: false });
      expect(await runtime.dispatch({ mode: 'async' })).toMatchObject({ ok: false,
        error: { code: 'execution_receipt_invalid' } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.records.size).toBe(0);
    });
  });
  describe('R-23 > P-003', () => {
    it('control', async () => {
      vi.useFakeTimers();
      const runtime = durableFixture();
      let settled = false;
      const pending = runtime.dispatch({ mode: 'auto' }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        handle: 'orchestrate-durable:p003-runtime:original-operation',
        terminal: false, state: 'running', mode: 'auto', responseWindowMs: 5000,
      } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      const row = [...runtime.records.values()][0]!;
      row.status = 'SUCCESS'; row.output = structuredClone(runtime.outcome);
      const recovered = await runtime.dispatch({ mode: 'sync', handle: 'orchestrate-durable:p003-runtime:original-operation' });
      expect(recovered.ok && JSON.parse((recovered.result!.content[0] as { text: string }).text)).toEqual(runtime.outcome);
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.handler).toHaveBeenCalledOnce();
    });
    it('counterexample', async () => {
      vi.useFakeTimers();
      const runtime = durableFixture({ yieldReplacement: true });
      const pending = runtime.dispatch({ mode: 'auto' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: false } } } });
      // The original-id/count detector must reject this adapter mutation.
      expect(() => expect(runtime.enqueue).toHaveBeenCalledOnce()).toThrow();
      expect([...runtime.records.keys()]).toEqual([
        'orchestrate-durable:p003-runtime:original-operation', 'orchestrate-durable:p003-runtime:replacement-operation',
      ]);
    });
    it('D013 default window control', async () => {
      vi.useFakeTimers();
      const runtime = durableFixture({ settleAfterMs: 5001 });
      let settled = false;
      const pending = runtime.dispatch().then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: false, state: 'running' } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect([...runtime.records.values()][0]!.status).toBe('PENDING');
      await vi.advanceTimersByTimeAsync(1);
      const recovered = await runtime.dispatch({ mode: 'sync', handle: 'orchestrate-durable:p003-runtime:original-operation' });
      expect(recovered.ok && JSON.parse((recovered.result!.content[0] as { text: string }).text)).toEqual(runtime.outcome);
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
    it('D013 default window drift counterexample', async () => {
      vi.useFakeTimers(); vi.setSystemTime(1000);
      const runtime = durableFixture({ settleAfterMs: 5001, yieldAfterMs: 4999 });
      // Change only the adapter's default; the 5000ms yield detector catches the drift.
      const startedAt = Date.now();
      const pending = runtime.dispatch();
      await vi.advanceTimersByTimeAsync(4999);
      expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: false } } } });
      expect(() => expect(Date.now() - startedAt).toBe(5000)).toThrow();
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
    it('D013 original deadline control', async () => {
      vi.useFakeTimers(); vi.setSystemTime(1000);
      const runtime = durableFixture();
      const pending = runtime.dispatch();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: { executionDeadlineMs: 61000 } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
    it('D013 changed deadline counterexample', async () => {
      vi.useFakeTimers(); vi.setSystemTime(1000);
      const runtime = durableFixture();
      const pending = runtime.dispatch();
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      if (!result.ok) throw new Error('Original admission refused');
      const receipt = result.result!._meta!.toolExecution as Record<string, unknown>;
      expect(() => expect({ ...receipt, executionDeadlineMs: 66000 }).toMatchObject({ executionDeadlineMs: 61000 })).toThrow();
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
    it('returns a fast existing-runtime business result inline', async () => {
      const runtime = durableFixture({ terminal: true });
      const result = await runtime.dispatch();
      expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: true, state: 'succeeded' } } } });
      expect(result.ok && JSON.parse((result.result!.content[0] as { text: string }).text)).toEqual(runtime.outcome);
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
    it('does not relabel a business reconciliation wait as failure or termination', async () => {
      const runtime = durableFixture({ terminal: true });
      const admitted = await runtime.dispatch({ mode: 'async' });
      if (!admitted.ok) throw new Error('Original DBOS admission refused: ' + admitted.error?.message);
      const receipt = admitted.result?._meta?.toolExecution as ToolExecutionAdmission;
      runtime.records.get(receipt.handle)!.output = { status: 'needs-reconciliation', steps: [],
        reconciliation: { ordinal: 1, tool: 'probe:write', reason: 'original outcome unknown' } };
      expect(await runtime.dispatch({ mode: 'async', handle: receipt.handle })).toMatchObject({ ok: true,
        result: { _meta: { toolExecution: { state: 'running', terminal: false } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
    });
  });
  describe('R-27 > P-003', () => {
    it('control', async () => {
      const runtime = durableFixture();
      const admitted = await runtime.dispatch({ mode: 'async' });
      if (!admitted.ok) throw new Error('Original DBOS admission refused: ' + admitted.error?.message);
      const receipt = admitted.result?._meta?.toolExecution as ToolExecutionAdmission;
      expect(receipt.handle).toBe('orchestrate-durable:p003-runtime:original-operation');
      const row = runtime.records.get(receipt.handle)!;
      row.status = 'SUCCESS'; row.output = structuredClone(runtime.outcome);
      // Drop ALL module-local dispatch state; keep only the existing runtime records/handle.
      vi.resetModules();
      const restarted = (await import('@papercusp/tooldef')).dispatchProjectedTool;
      expect(restarted).not.toBe(dispatchProjectedTool);
      const recovered = await runtime.dispatch({ mode: 'sync', handle: receipt.handle }, {}, restarted);
      expect(recovered).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        handle: receipt.handle, ownerId: receipt.ownerId, terminal: true, state: 'succeeded',
      } } } });
      expect(recovered.ok && JSON.parse((recovered.result!.content[0] as { text: string }).text)).toEqual(runtime.outcome);
      expect(await runtime.dispatch({ mode: 'sync', handle: receipt.handle }, { uiClientId: 'foreign-owner' }, restarted))
        .toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.handler).toHaveBeenCalledOnce();
    });
    it('counterexample', async () => {
      const runtime = durableFixture({ terminal: true });
      const admitted = await runtime.dispatch({ mode: 'async' });
      if (!admitted.ok) throw new Error('Original DBOS admission refused: ' + admitted.error?.message);
      const receipt = admitted.result?._meta?.toolExecution as ToolExecutionAdmission;
      const row = runtime.records.get(receipt.handle)!;
      delete (row.input![0] as Partial<DurableOrchestrationInput>).caller;
      // Delete ONLY the persisted ownership join; retain the original script, handle and result.
      expect(await getDurableOrchestrationStatus(receipt.handle, runtime.deps))
        .toMatchObject({ workflowId: receipt.handle, status: 'SUCCESS', outcome: runtime.outcome });
      vi.resetModules();
      const restarted = (await import('@papercusp/tooldef')).dispatchProjectedTool;
      expect(await runtime.dispatch({ mode: 'sync', handle: receipt.handle }, {}, restarted))
        .toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.handler).toHaveBeenCalledOnce();
      expect(runtime.records.get(receipt.handle)!.output).toEqual(runtime.outcome);
    });
  });
});

describe('unified execution > R-2 > P-003', () => {
  it('control', async () => {
    vi.useFakeTimers();
    const runtime = durableFixture({ settleAfterMs: 4999 });
    const pending = runtime.dispatch();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: { terminal: true, state: 'succeeded' } } } });
    expect(result.ok && JSON.parse((result.result!.content[0] as { text: string }).text)).toEqual(runtime.outcome);
    expect(runtime.enqueue).toHaveBeenCalledOnce();
    expect(runtime.handler).toHaveBeenCalledOnce();
  });
  it('counterexample', async () => {
    vi.useFakeTimers();
    const runtime = durableFixture({ settleAfterMs: 5001 });
    const pending = runtime.dispatch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
      handle: 'orchestrate-durable:p003-runtime:original-operation', terminal: false, state: 'running',
    } } } });
    expect(runtime.enqueue).toHaveBeenCalledOnce();
    expect([...runtime.records.values()][0]!.output).toBeUndefined();
  });
});

describe('unified execution > R-24 > P-003', () => {
  for (const corrupt of [false, true]) it(corrupt ? 'counterexample' : 'control', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
    const runtime = durableFixture({ terminal: true });
    const result = await runtime.dispatch({ responseWindowMs: 5000 });
    if (!result.ok) throw new Error('Original admission refused');
    const receipt = result.result!._meta!.toolExecution as Record<string, unknown>;
    const observed = corrupt ? { ...receipt, responseWindowMs: receipt.executionDeadlineMs, executionDeadlineMs: receipt.responseWindowMs } : receipt;
    const verify = () => expect(observed).toMatchObject({ responseWindowMs: 5000, executionDeadlineMs: 61000 });
    if (corrupt) expect(verify).toThrow(); else verify();
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });
});

describe('unified execution > R-28 > P-003', () => {
  it('control', async () => {
    const runtime = durableFixture();
    expect(await runtime.dispatch({ mode: 'async' })).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
      handle: 'orchestrate-durable:p003-runtime:original-operation', ownerId: 'original-owner', terminal: false,
    } } } });
    expect(runtime.enqueue).toHaveBeenCalledOnce();
  });
  it('counterexample', async () => {
    const runtime = durableFixture({ requestBound: true, liveInteraction: true });
    expect(await runtime.dispatch({ mode: 'async' })).toMatchObject({ ok: false, error: { code: 'unsupported_execution_mode' } });
    expect(runtime.handler).not.toHaveBeenCalled();
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
});

describe('unified execution > R-26 > P-003', () => {
  for (const title of ['control', 'D013 safe ceiling control', 'D013 loaded cap derivation control']) it(title, async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
    const runtime = durableFixture({ terminal: true });
    const result = await runtime.dispatch({ mode: 'sync', responseWindowMs: 55000 });
    expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
      responseWindowMs: 55000, executionDeadlineMs: 61000, state: 'succeeded', terminal: true,
    } } } });
    expect(runtime.enqueue).toHaveBeenCalledOnce();
    expect(runtime.handler).toHaveBeenCalledOnce();
  });
  for (const title of ['counterexample', 'D013 above ceiling counterexample', 'D013 stale ceiling counterexample']) it(title, async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
    const runtime = durableFixture({ terminal: true });
    expect(await runtime.dispatch({ mode: 'sync', responseWindowMs: 55001 }))
      .toMatchObject({ ok: false, error: { code: 'execution_budget_exceeded' } });
    expect(runtime.enqueue).not.toHaveBeenCalled();
    expect(runtime.handler).not.toHaveBeenCalled();
  });
});

/** A transaction-free request handler, through real dispatch and the real MCP response race. */
function requestFixture(options: { base: number; finiteCapMutation?: boolean; originalMs?: number; settleMs?: number; cooperativeAbort?: boolean }) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const effectiveDeadlineMs = effectiveMcpDeadlineMs(120, options.base);
  const safeBudgetMs = options.finiteCapMutation ? 45000 : effectiveDeadlineMs > 0 ? effectiveDeadlineMs - 5000 : null;
  let effectCount = 0;
  let settled = false;
  let handlerContext: UnifiedToolContext | undefined;
  const handler = vi.fn(async (_args: Record<string, never>, ctx: UnifiedToolContext) => {
    handlerContext = ctx;
    effectCount++;
    // The external effect can finish after response loss. Abort is not rollback.
    const completion = new Promise<'settled'>(resolve => setTimeout(() => {
      settled = true; resolve('settled');
    }, options.settleMs ?? 80000));
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>(resolve => {
      if (!options.cooperativeAbort) return;
      onAbort = () => resolve('aborted');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();
    });
    try {
      if (await Promise.race([completion, aborted]) === 'aborted') return {
        isError: true, structuredContent: { ok: false, aborted: true },
        content: [{ type: 'text' as const, text: 'Original handler observed its abort; external outcome remains unknown' }],
      };
      return { content: [{ type: 'text' as const, text: 'original request result' }] };
    } finally {
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    }
  });
  const definition = defineTool({ name: 'execution_contract:request_probe', description: 'Request lifetime fixture',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'], timeoutSec: 120,
    args: z.object({}), handler,
  });
  const tool = lookupByMcpName(definition.name)!;
  const originalDeadline = startedAt + (options.originalMs ?? 120000);
  const pending = dispatchProjectedTool(tool, definition.name, {}, {
    log: () => {}, progress: () => {}, emit: () => {}, signal: controller.signal,
    workspaceId: 'p003-runtime', role: 'operator', uiClientId: 'original-owner', toolExecution: {},
    executionDeadlineAtMs: originalDeadline,
    transportResponseDeadlineAtMs: safeBudgetMs === null ? null : startedAt + safeBudgetMs,
  }, {});
  let response: Awaited<typeof pending> | { responseExpired: true } | undefined;
  const responsePending = raceDeadline<Awaited<typeof pending> | { responseExpired: true }>(
    safeBudgetMs ?? 0, () => pending, () => ({ responseExpired: true as const }))
    .then(value => { response = value; return value; });
  return { handler, controller, pending, responsePending, originalDeadline, effectiveDeadlineMs, safeBudgetMs,
    get response() { return response; }, get effectCount() { return effectCount; },
    get settled() { return settled; }, get handlerContext() { return handlerContext; } };
}

for (const requirement of ['R-23', 'R-26']) describe('unified execution > ' + requirement + ' > P-003', () => {
  const longRequest = async (disabled: boolean, corrupt: boolean) => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const runtime = requestFixture({ base: disabled ? 0 : 55000, finiteCapMutation: corrupt });
    await vi.advanceTimersByTimeAsync(45001);
    const assertRequestLive = () => {
      expect(runtime.response).toBeUndefined();
      expect(runtime.settled).toBe(false);
      expect(runtime.handlerContext?.signal.aborted).toBe(false);
      expect(runtime.handlerContext?.executionDeadlineAtMs).toBe(121000);
      expect(runtime.handler).toHaveBeenCalledOnce();
      expect(runtime.effectCount).toBe(1);
    };
    if (corrupt) {
      expect(runtime.response).toEqual({ responseExpired: true });
      expect(assertRequestLive).toThrow();
      // Premature response expiry certifies neither termination nor effect reversal.
      expect(runtime.settled).toBe(false);
      expect(runtime.handlerContext?.signal.aborted).toBe(false);
    } else assertRequestLive();
    await vi.advanceTimersByTimeAsync(34999);
    expect(await runtime.pending).toMatchObject({ ok: true, result: { content: [{ text: 'original request result' }] } });
    await runtime.responsePending;
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.effectCount).toBe(1);
    expect(runtime.settled).toBe(true);
    expect(runtime.effectiveDeadlineMs).toBe(disabled ? 0 : 125000);
  };
  it('D013 long declared timeout control', async () => { await longRequest(false, false); });
  it('D013 fixed ceiling counterexample', async () => {
    await longRequest(false, true);
    await longRequest(false, false);
  });
  it('D013 strict sync supported budget control', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
    for (const requested of [119999, 120000]) {
      const runtime = durableFixture({ terminal: true });
      runtime.tool.timeoutSec = 120;
      const safeBudget = effectiveMcpDeadlineMs(120, 55000) - 5000;
      expect(await runtime.dispatch({ mode: 'sync', responseWindowMs: requested }, {
        executionDeadlineAtMs: 121000, transportResponseDeadlineAtMs: 1000 + safeBudget,
      })).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        responseWindowMs: requested, executionDeadlineMs: 121000, terminal: true,
      } } } });
      expect(runtime.enqueue).toHaveBeenCalledOnce();
      expect(runtime.handler).toHaveBeenCalledOnce();
    }
  });
  it('D013 strict sync over-budget counterexample', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000);
    for (const [transportBudget, originalBudget] of [[120000, 130000], [130000, 120000]]) {
      const runtime = durableFixture({ terminal: true });
      runtime.tool.timeoutSec = 130;
      expect(await runtime.dispatch({ mode: 'sync', responseWindowMs: 120001 }, {
        executionDeadlineAtMs: 1000 + originalBudget!, transportResponseDeadlineAtMs: 1000 + transportBudget!,
      })).toMatchObject({ ok: false, error: { code: 'execution_budget_exceeded' } });
      expect(runtime.enqueue).not.toHaveBeenCalled();
      expect(runtime.handler).not.toHaveBeenCalled();
    }
  });
  it('D013 disabled transport deadline control', async () => {
    await longRequest(true, false);
    // The same disabled transport retains BOTH original execution expiry and caller abort.
    for (const abortByCaller of [false, true]) {
      vi.useFakeTimers(); vi.setSystemTime(1000);
      const runtime = requestFixture({ base: 0, originalMs: abortByCaller ? 120000 : 50000, cooperativeAbort: true });
      await vi.advanceTimersByTimeAsync(45001);
      expect(runtime.response).toBeUndefined();
      if (abortByCaller) runtime.controller.abort();
      else await vi.advanceTimersByTimeAsync(4999);
      expect(await runtime.responsePending).toMatchObject({ ok: true, result: { isError: true,
        structuredContent: { ok: false, aborted: true } } });
      expect(runtime.handlerContext?.signal.aborted).toBe(true);
      expect(runtime.handler).toHaveBeenCalledOnce();
      expect(runtime.effectCount).toBe(1);
      expect(runtime.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(abortByCaller ? 34999 : 30000);
      expect(runtime.settled).toBe(true);
    }
  });
  it('D013 disabled cap counterexample', async () => {
    await longRequest(true, true);
    await longRequest(true, false);
  });
});

describe('unified execution > R-23 > P-003', () => {
  for (const duration of [4999, 5001]) it('request-bound ' + duration + ' inline control', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const runtime = requestFixture({ base: 55000, settleMs: duration });
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(runtime.response).toBeUndefined();
    expect(runtime.handlerContext?.signal.aborted).toBe(false);
    expect(runtime.handler).toHaveBeenCalledOnce();
    expect(runtime.effectCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await runtime.responsePending).toMatchObject({ ok: true, result: { content: [{ text: 'original request result' }] } });
    expect(runtime.handler).toHaveBeenCalledOnce();
  });
});
