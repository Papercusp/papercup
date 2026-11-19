/**
 * P-002: universal-batch timing contracts that need full timer control.
 *
 * These two cases moved out of universal-batch.integration.test.ts because they fake
 * setTimeout. Integration tests may not do that (scripts/check-fake-timers-in-integration-tests.mjs,
 * EI-18697393226276295): a faked scheduler stops real infra timers and the suite hangs silently.
 * Every dependency here is in-memory — the tool catalog, the projected MCP dispatcher and the
 * handlers below — so the unit layer, where fake timers are allowed, is the right home. The
 * `vi.useFakeTimers(` marker routes this file to the isolated stateful lane (libs/test-config
 * lane-split.ts), so resetting the shared catalog here cannot leak into co-resident files.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  _resetCatalogForTests, _resetProjectionRegistryForTests, clearEntityResolvers, defineTool, lookupByMcpName,
  type BatchResult, type DispatchProjectedDeps, type UnifiedToolContext,
} from '@papercusp/tooldef';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';

afterEach(() => {
  vi.useRealTimers();
  _resetCatalogForTests();
  _resetProjectionRegistryForTests();
  clearEntityResolvers();
});

const name = 'universal_batch_deadline_fixture:operate';
const operation = z.strictObject({ key: z.string() });
const item = (key: string, itemId?: string) => ({ args: { key }, ...(itemId ? { itemId } : {}) });
const context = (): UnifiedToolContext => ({
  log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
  workspaceId: 'universal-batch-fixture', role: 'operator', runId: 'batch-parent', requestedStructured: true,
});

async function call(input: unknown, options: { deps?: DispatchProjectedDeps; ctx?: Partial<UnifiedToolContext> } = {}) {
  const tool = lookupByMcpName(name);
  expect(tool).toBeDefined();
  return dispatchProjectedToolToMcp(tool!, name, input, { ...context(), ...options.ctx }, options.deps ?? {},
    { 'papercusp/batchResponseVersion': 'batch-v1' });
}

function data(result: Awaited<ReturnType<typeof call>>): BatchResult {
  expect(result.structuredContent).toMatchObject({ results: expect.any(Array), counts: expect.any(Object) });
  return result.structuredContent as unknown as BatchResult;
}

describe('universal batching deadlines and concurrency (fake timers)', () => {
  it('caps active child deadlines at the parent deadline and leaves expired siblings unstarted', async () => {
    vi.useFakeTimers();
    const deadlineAtMs = Date.now() + 30;
    const entered: string[] = [];
    const signals: AbortSignal[] = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:read', effect: 'read', args: operation,
      timeoutSec: 60, handler: async (value, ctx) => {
        entered.push(value.key);
        signals.push(ctx.signal);
        expect(ctx.deadlineAtMs).toBe(deadlineAtMs);
        return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort',
          () => reject(new Error('parent deadline reached')), { once: true }));
      } });
    const pending = call({ _batch: 1, items: [item('active', 'active'), item('later', 'later')] }, {
      ctx: { deadlineAtMs },
    });
    await vi.advanceTimersByTimeAsync(30);
    const result = data(await pending);
    expect(entered).toEqual(['active']);
    expect(signals.map(signal => signal.aborted)).toEqual([true]);
    expect(result.results).toMatchObject([
      { itemId: 'active', ok: false, error: { code: 'timeout' } },
      { itemId: 'later', ok: false, status: 'not-started' },
    ]);
  });

  it('enforces the declared single-child concurrency ceiling across awaited effects', async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    defineTool({ name, requirePrincipal: false, capability: 'test:write', effect: 'write', args: operation,
      batch: { maxConcurrency: 1 }, handler: async value => {
        peak = Math.max(peak, ++active);
        started.push(value.key);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return { data: value };
      } });
    const pending = call({ _batch: 1, items: ['a', 'b', 'c'].map(key => item(key, key)) });
    await vi.advanceTimersByTimeAsync(20);
    expect(data(await pending).counts).toEqual({ ok: 3, failed: 0 });
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(started).toEqual(['a', 'b', 'c']);
  });
});
