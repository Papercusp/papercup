/**
 * P-003: tool-execution timing contracts that need full timer control.
 *
 * These cases moved out of tool-execution.integration.test.ts because they fake setTimeout.
 * Integration tests may not do that (scripts/check-fake-timers-in-integration-tests.mjs): a faked
 * scheduler stops real infra timers and the suite hangs silently. Every dependency here is
 * in-memory: the tool catalog, the projected dispatcher, the DBOS client double in
 * ./_tool-execution-fixture and the request handler below. So the unit layer, where fake timers
 * are allowed, is the right home. Test names are unchanged. The Date-only cases
 * (`toFake: ['Date']`) stayed in the integration file because they schedule nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool, dispatchProjectedTool, _resetCatalogForTests, _resetProjectionRegistryForTests, lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/tooldef';
import { effectiveMcpDeadlineMs, raceDeadline } from '../endpoint-route/routes/transport/_mcp-host';
import { durableFixture } from './_tool-execution-fixture';

vi.mock('../dbos/bootstrap', () => ({ dbosStarted: () => false, withDbosIdleTxGrace: (value: string) => value }));
afterEach(() => { vi.useRealTimers(); _resetCatalogForTests(); _resetProjectionRegistryForTests(); });

describe('unified execution', () => {
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
    // Single-operation assertions: negotiate operation-v0 exactly as PROJECTED_DEPS does
    // (canonical dispatch defaults singleton shorthand to the batch-v1 envelope).
  }, { batchResponseVersion: 'operation-v0' });
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
