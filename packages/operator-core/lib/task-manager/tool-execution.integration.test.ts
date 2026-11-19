import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool, _resetCatalogForTests, _resetProjectionRegistryForTests, type ToolExecutionAdmission,
} from '@papercusp/tooldef';
import { getDurableOrchestrationStatus, type DurableOrchestrationInput } from '../dbos/durable-orchestration-workflow';
import { effectiveMcpDeadlineMs } from '../endpoint-route/routes/transport/_mcp-host';
import * as sensitiveText from '../sensitive-text';
// Shared with tool-execution-timers.test.ts, which holds the cases that fake setTimeout.
import { durableFixture } from './_tool-execution-fixture';

vi.mock('../dbos/bootstrap', () => ({ dbosStarted: () => false, withDbosIdleTxGrace: (value: string) => value }));
afterEach(() => { vi.useRealTimers(); _resetCatalogForTests(); _resetProjectionRegistryForTests(); });

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
    // The timer-driven R-23 cases fake setTimeout, so they live in tool-execution-timers.test.ts.
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

// The timer-driven R-23/R-26 request cases and their requestFixture live in tool-execution-timers.test.ts.
for (const requirement of ['R-23', 'R-26']) describe('unified execution > ' + requirement + ' > P-003', () => {
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
});
