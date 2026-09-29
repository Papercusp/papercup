/** P-013 (D-009, D-017, D-019): the read-only recipe provider runtime. */
import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, WrapDispatch } from '@papercusp/tooldef';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';
import type { IdentityClassProviderResolution } from './class-provider';
import { inspectIdentityRecipeProvider } from './recipe-provider-conformance';
import { createIdentityRecipeProducer, type IdentityRecipeRuntimeDeps } from './recipe-provider-runtime';
import { evaluateSinkInvocation, type SinkContributionRequest } from './sink-evaluator';

const revision = 'a'.repeat(64);
const outputSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false };
const contract = { inputSchema: {}, outputSchema };
type ToolFn = ProjectedTool['fn'];

function tool(name: string, over: Partial<ProjectedTool> = {}): ProjectedTool {
  return { pluginName: 'identity-recipe-runtime-test', description: 'runtime fixture',
    expose: { mcp: { name } }, capabilities: ['status:read'], effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    fn: vi.fn(async () => ({ content: [], structuredContent: { ready: true } })), ...over };
}
function context(signal = new AbortController().signal): UnifiedToolContext {
  return {
    workspaceId: 'ws-recipe', harnessSlug: 'papercusp', role: 'su',
    principal: { slug: 'wearer', workspaceId: 'ws-recipe', capabilities: new Set(['*']) },
    signal, runId: 'run-recipe', spawnId: 'spawn-recipe',
    parentSpawnId: null, featureId: null, chunkId: null, uiClientId: null,
    isSuperuser: true, gateBypass: { capability: true, quota: true },
    profile: 'engineer', transport: 'in_process', tx: {} as UnifiedToolContext['tx'],
    log: () => {}, progress: () => {}, emit: () => {},
  };
}
function recipes(source: string): SavedRecipeAdapter {
  const inspect = vi.fn(async () => ({ ok: true as const,
    recipe: { id: 'recipe-1', script: source },
    continuation: { id: 'recipe-1', revision, authority: { version: 1 as const, revision,
      refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      requiresContext: false, runnable: true } },
  }));
  return { inspect, run: vi.fn(), search: vi.fn() } as SavedRecipeAdapter;
}
const declaredNeeds = ['status:read', 'tools:invoke'];
/** Binding-time evidence from the canonical inspector, over the given tools. */
async function bind(source: string, tools: readonly ProjectedTool[]) {
  const evidence = await inspectIdentityRecipeProvider({ recipe: { id: 'recipe-1', revision }, contract,
    outputSchema, declaredNeeds, capabilityCeiling: new Set(['*']), context: context() },
  { tools, recipes: recipes(source) });
  if (!evidence.ok) throw new Error(`fixture binding failed: ${evidence.code}`);
  const resolution: Extract<IdentityClassProviderResolution, { ok: true }> = {
    ok: true, requestedClassRef: 'context.status@1', classRef: 'context.status@1.0.0', verb: 'read',
    contract, provider: {
      classRef: 'context.status@1.0.0', providerPackage: 'status-recipes', providerVersion: '1.0.0',
      verbBindings: { read: 'recipe-1' }, conformanceRunId: 'run-1', conformanceStatus: 'passed',
      behavioralStatus: 'not-required', behavioralRunRef: null, registryRevision: 'registry-1',
      status: 'active', updatedAt: '2026-09-29T00:00:00.000Z', potSlug: 'pot-1', boundBy: null,
      boundAt: '2026-09-29T00:00:00.000Z', providerKind: 'recipe', latencyClass: 'sync',
      recipeInspections: { read: evidence },
    },
  };
  return { evidence, resolution };
}
const passThrough: WrapDispatch = (_tool, _name, _args, ctx, next) => next(ctx);

function harness(source: string, tools: readonly ProjectedTool[], over: {
  ceiling?: Set<string>; wrap?: WrapDispatch; runtimeTools?: readonly ProjectedTool[];
} = {}) {
  const resolveWearer = vi.fn(async () => ({ ownerId: 'owner-1', context: context(),
    capabilityCeiling: over.ceiling ?? new Set(['*']) }));
  const deps: IdentityRecipeRuntimeDeps = { tools: over.runtimeTools ?? tools, recipes: recipes(source),
    dispatchDeps: {}, wrapDispatch: over.wrap ?? passThrough };
  const produce = createIdentityRecipeProducer({ resolveWearer, declaredNeeds }, deps);
  return { produce, resolveWearer };
}
const call = (resolution: Extract<IdentityClassProviderResolution, { ok: true }>, over: {
  signal?: AbortSignal; deadlineAt?: number; maxBytes?: number;
} = {}) => ({ resolution, identityRef: 'identity:status', signal: over.signal ?? new AbortController().signal,
  deadlineAt: over.deadlineAt ?? Date.now() + 5_000, maxBytes: over.maxBytes ?? 4_096 });

describe('read-only recipe provider runtime (portable-identity P-013, D-019)', () => {
  it('runs the pinned recipe on a narrowed principal and returns a provenance-fenced value', async () => {
    const read = tool('status:read');
    const { resolution } = await bind('return await tools.status.read({});', [read]);
    const seen: UnifiedToolContext[] = [];
    const wrap: WrapDispatch = (_tool, _name, _args, ctx, next) => { seen.push(ctx); return next(ctx); };
    const { produce, resolveWearer } = harness('return await tools.status.read({});', [read],
      { ceiling: new Set(['status:read']), wrap });
    const result = await produce(call(resolution));
    expect(result).toMatchObject({ status: 'value', value: { ready: true }, dispatchCount: 1 });
    if (result.status !== 'value') throw new Error('unreachable');
    expect(JSON.parse(result.text)).toMatchObject({ provenance: { author: 'status-recipes',
      identityRef: 'identity:status', providerRef: 'status-recipes@1.0.0', classRef: 'context.status@1.0.0' },
    value: { ready: true } });
    expect(seen).toHaveLength(1);
    expect([...seen[0]!.principal!.capabilities]).toEqual(['status:read']);
    expect(seen[0]!.isSuperuser).toBe(false);
    expect(seen[0]!.gateBypass).toBeUndefined();
    await produce(call(resolution));
    // Grants are resolved again for every call, never pinned by the closure.
    expect(resolveWearer).toHaveBeenCalledTimes(2);
  });

  it('refuses a provider without inspected evidence for the verb', async () => {
    const read = tool('status:read');
    const { resolution } = await bind('return await tools.status.read({});', [read]);
    const { produce } = harness('return await tools.status.read({});', [read]);
    const bare = { ...resolution, provider: { ...resolution.provider, recipeInspections: undefined } };
    expect(await produce(call(bare))).toEqual({ status: 'refused', code: 'recipe-unavailable' });
    const rebound = { ...resolution, provider: { ...resolution.provider, verbBindings: { read: 'recipe-2' } } };
    expect(await produce(call(rebound))).toEqual({ status: 'refused', code: 'recipe-unavailable' });
    expect(read.fn).not.toHaveBeenCalled();
  });

  it('refuses a stale pin: changed source or bindings since the conformance run', async () => {
    const read = tool('status:read');
    const { resolution } = await bind('return await tools.status.read({});', [read]);
    const { produce } = harness('return await tools.status.read({ subject: "new" });', [read]);
    expect(await produce(call(resolution))).toEqual({ status: 'refused', code: 'inspection-pin-stale' });
    const same = harness('return await tools.status.read({});', [read]);
    const evidence = resolution.provider.recipeInspections!.read!;
    const tampered = { ...resolution, provider: { ...resolution.provider, recipeInspections: { read: {
      ...evidence, inspectionPin: { ...evidence.inspectionPin, bindingsSha256: 'b'.repeat(64) } } } } };
    expect(await same.produce(call(tampered))).toEqual({ status: 'refused', code: 'inspection-pin-stale' });
    expect(read.fn).not.toHaveBeenCalled();
  });

  it('refuses a tool whose effect or egress changed after binding, before any dispatch', async () => {
    const read = tool('status:read');
    const { resolution } = await bind('return await tools.status.read({});', [read]);
    const writer = tool('status:read', { effect: 'write' });
    expect(await harness('return await tools.status.read({});', [read], { runtimeTools: [writer] })
      .produce(call(resolution))).toEqual({ status: 'refused', code: 'effect-not-read' });
    const egress = tool('status:read', { capabilities: ['capability:net'] });
    expect(await harness('return await tools.status.read({});', [read], { runtimeTools: [egress] })
      .produce(call(resolution))).toEqual({ status: 'refused', code: 'egress-capability' });
    expect(writer.fn).not.toHaveBeenCalled();
    expect(egress.fn).not.toHaveBeenCalled();
  });

  it('gates every call at runtime and voids the output even when the script catches the refusal', async () => {
    // Read at every inspection (binding AND the runtime's re-inspection), write
    // only when the runtime gate classifies the call as actually made.
    const shifty = tool('status:read', {
      effectForCall: () => (new Error().stack?.includes('assertReadOnly') ? 'write' : 'read'),
    });
    const source = 'try { return await tools.status.read({}); } catch { return { ready: true }; }';
    const { resolution } = await bind(source, [shifty]);
    const result = await harness(source, [shifty]).produce(call(resolution));
    expect(result).toEqual({ status: 'refused', code: 'effect-not-read' });
    expect(shifty.fn).not.toHaveBeenCalled();
  });

  it('omits output that fails the class schema or the size bound', async () => {
    const wrong = tool('status:read', { fn: vi.fn(async () => ({ content: [], structuredContent: { ready: 'yes' } })) });
    const { resolution } = await bind('return await tools.status.read({});', [wrong]);
    expect(await harness('return await tools.status.read({});', [wrong]).produce(call(resolution)))
      .toEqual({ status: 'omitted', reason: 'schema-mismatch' });
    const read = tool('status:read');
    expect(await harness('return await tools.status.read({});', [read]).produce(call(resolution, { maxBytes: 16 })))
      .toEqual({ status: 'omitted', reason: 'output-too-large' });
  });

  it('times out visibly at the deadline and starts nothing after it', async () => {
    const fn = vi.fn<ToolFn>((_args, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve({ content: [], structuredContent: { ready: true } }), { once: true });
    }));
    const slow = tool('status:read', { fn });
    const source = 'await tools.status.read({}); return await tools.status.read({});';
    const { resolution } = await bind(source, [slow]);
    const result = await harness(source, [slow]).produce(call(resolution, { deadlineAt: Date.now() + 200 }));
    expect(result).toEqual({ status: 'refused', code: 'deadline' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops at detach while a call is in flight and discards its late result', async () => {
    const controller = new AbortController();
    const fn = vi.fn<ToolFn>((_args, ctx) => new Promise((resolve) => {
      controller.abort();
      ctx.signal.addEventListener('abort', () => resolve({ content: [], structuredContent: { ready: true } }), { once: true });
      if (ctx.signal.aborted) resolve({ content: [], structuredContent: { ready: true } });
    }));
    const slow = tool('status:read', { fn });
    const source = 'await tools.status.read({}); return await tools.status.read({});';
    const { resolution } = await bind(source, [slow]);
    const result = await harness(source, [slow]).produce(call(resolution, { signal: controller.signal }));
    expect(result).toEqual({ status: 'refused', code: 'cancelled' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not settle while a non-cooperative call is still running (D-017)', async () => {
    let settledAt = 0;
    const fn = vi.fn<ToolFn>(() => new Promise((resolve) => setTimeout(() => {
      settledAt = Date.now();
      resolve({ content: [], structuredContent: { ready: true } });
    }, 400)));
    const stubborn = tool('status:read', { fn });
    const { resolution } = await bind('return await tools.status.read({});', [stubborn]);
    const result = await harness('return await tools.status.read({});', [stubborn])
      .produce(call(resolution, { deadlineAt: Date.now() + 100 }));
    const returnedAt = Date.now();
    expect(result).toEqual({ status: 'refused', code: 'deadline' });
    expect(settledAt).toBeGreaterThan(0);
    expect(returnedAt).toBeGreaterThanOrEqual(settledAt);
  });

  it('keeps several slow providers inside one sink invocation deadline', async () => {
    const fn = vi.fn<ToolFn>((_args, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve({ content: [], structuredContent: { ready: true } }), { once: true });
    }));
    const slow = tool('status:read', { fn });
    const { resolution } = await bind('return await tools.status.read({});', [slow]);
    const { produce } = harness('return await tools.status.read({});', [slow]);
    const contributions: SinkContributionRequest[] = ['a', 'b', 'c'].map((identityId) => ({
      identityId, contributionId: 'ctx',
      injection: { sinks: ['turn-start'], trigger: 'every-turn', tokenBudget: 50, priority: 50, overBudget: 'truncate' },
      produce: async (sinkCall) => {
        const result = await produce(call(resolution, { signal: sinkCall.signal, deadlineAt: sinkCall.deadlineAt }));
        if (result.status !== 'value') throw new Error(`recipe:${result.status}`);
        return result.text;
      },
    }));
    const startedAt = Date.now();
    const result = await evaluateSinkInvocation({
      invocation: { sessionId: 's-1', turnId: 't-1', invocationId: 'i-1', sink: 'turn-start', attachmentRevision: 'r-1' },
      contributions,
      limits: { sinkBudget: { tokens: 400, wallClockMs: 250 }, turnCeiling: { tokens: 800, wallClockMs: 1_500 },
        perSessionConcurrency: 2 },
      currentAttachmentRevision: () => 'r-1',
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.deliveries).toEqual([]);
    expect(result.omissions.map((row) => row.reason).sort()).toEqual(['deadline', 'deadline', 'queued-past-deadline']);
    // The third provider was never admitted, so it started no tool call.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
