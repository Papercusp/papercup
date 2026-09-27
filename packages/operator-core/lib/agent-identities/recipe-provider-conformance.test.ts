import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';
import { assertIdentityRecipeClassConformance, inspectIdentityRecipeClassProvider, inspectIdentityRecipeProvider } from './recipe-provider-conformance';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';

const revision = 'a'.repeat(64);
const outputSchema = { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false };
function tool(name: string, over: Partial<ProjectedTool> = {}): ProjectedTool {
  return { pluginName: 'identity-recipe-test', description: 'conformance fixture',
    expose: { mcp: { name } }, capabilities: ['status:read'], effect: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    fn: vi.fn(async () => ({ content: [], structuredContent: { ready: true } })), ...over };
}
const tools = [
  tool('status:read'), tool('status:write', { effect: 'write', capabilities: ['status:write'] }),
  tool('status:unknown', { effect: undefined }),
  tool('status:egress', { capabilities: ['capability:net'] }),
  tool('status:pluginEgress', { capabilities: ['net:fetch'] }),
  tool('tools:invoke', { capabilities: ['tools:invoke'], effect: undefined }),
];
function context(): UnifiedToolContext {
  return {
    workspaceId: 'ws-recipe', harnessSlug: 'papercusp', role: 'su',
    principal: { slug: 'wearer', workspaceId: 'ws-recipe', capabilities: new Set(['*']) },
    signal: new AbortController().signal, runId: 'run-recipe', spawnId: 'spawn-recipe',
    parentSpawnId: null, featureId: null, chunkId: null, uiClientId: null,
    isSuperuser: true, gateBypass: { capability: true, quota: true },
    profile: 'engineer', transport: 'in_process', tx: {} as UnifiedToolContext['tx'],
    log: () => {}, progress: () => {}, emit: () => {},
  };
}
function fixture(source: string) {
  const inspect = vi.fn(async () => ({ ok: true as const,
    recipe: { id: 'recipe-1', script: source },
    continuation: { id: 'recipe-1', revision, authority: { version: 1 as const, revision,
      refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      requiresContext: false, runnable: true } },
  }));
  const recipes = { inspect, run: vi.fn(), search: vi.fn() } as SavedRecipeAdapter;
  const input = {
    recipe: { id: 'recipe-1', revision }, context: context(),
    contract: { inputSchema: {}, outputSchema }, outputSchema,
    declaredNeeds: ['status:read', 'status:write', 'tools:invoke', 'capability:net', 'net:fetch'],
    capabilityCeiling: new Set(['*']),
  };
  return { input, deps: { tools, recipes }, inspect, recipes };
}

describe('identity recipe conformance through the canonical orchestration inspector', () => {
  it('builds immutable per-verb recipe evidence for the existing conformance report', async () => {
    const f = fixture('return tools.status.read({});');
    const capabilityClass = { ref: 'context.status@1.0.0',
      interfaceVerbs: { read: f.input.contract, summary: f.input.contract },
      behavioralSuiteRef: 'suite:context-status' };
    const binding = { recipe: f.input.recipe, outputSchema };
    const input = { capabilityClass, providerPackage: 'context-provider', providerVersion: '1.0.0',
      registryRevision: 'registry-1', recipes: { read: binding, summary: binding },
      context: f.input.context, declaredNeeds: f.input.declaredNeeds, capabilityCeiling: f.input.capabilityCeiling };
    const report = await inspectIdentityRecipeClassProvider(input, f.deps);
    expect(report).toMatchObject({ schemaVersion: 'capability-class-recipe-v1', ok: true,
      providerKind: 'recipe', latencyClass: 'sync', classRef: capabilityClass.ref,
      behavioral: { status: 'not-run', suiteRef: 'suite:context-status' } });
    expect(Object.keys(report.recipes)).toEqual(['read', 'summary']);
    expect(report.recipes.read).toMatchObject({ recipe: f.input.recipe,
      inspectionPin: { recipeRevision: revision }, requiredCapabilities: ['status:read'], outputSchema });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(f.recipes.run).not.toHaveBeenCalled();
    const verbBindings = { read: binding.recipe.id, summary: binding.recipe.id };
    const assert = (value = report) => assertIdentityRecipeClassConformance({ report: value, capabilityClass, verbBindings });
    expect(() => assert()).not.toThrow();
    for (const corrupt of [
      (r: typeof report) => { delete r.recipes.read; },
      (r: typeof report) => { r.recipes.read!.recipe.id = 'wrong-recipe'; },
      (r: typeof report) => { r.recipes.read!.inspectionPin.recipeRevision = 'b'.repeat(64); },
      (r: typeof report) => { r.recipes.read!.inspectionPin.sourceSha256 = 'invalid'; },
      (r: typeof report) => { r.recipes.read!.outputSchema = { type: 'string' }; },
      (r: typeof report) => { r.checks.push(r.checks[0]!); },
      (r: typeof report) => { r.checks[0]!.problems.push('denied'); },
      (r: typeof report) => { r.behavioral.suiteRef = null; },
    ]) {
      const altered = structuredClone(report);
      corrupt(altered);
      expect(() => assert(altered)).toThrow(/recipe conformance/);
    }
    const missing = await inspectIdentityRecipeClassProvider({ ...input, recipes: { read: binding } }, f.deps);
    expect(missing.ok).toBe(false);
    expect(() => assertIdentityRecipeClassConformance({ report: missing, capabilityClass,
      verbBindings: { read: binding.recipe.id } })).not.toThrow();
    expect(missing.checks).toContainEqual({ verb: 'summary', tool: null, ok: false, problems: ['missing provider recipe binding'] });
    const extra = await inspectIdentityRecipeClassProvider({ ...input, recipes: { ...input.recipes, undeclared: binding } }, f.deps);
    expect(extra.ok).toBe(false);
    expect(() => assertIdentityRecipeClassConformance({ report: extra, capabilityClass,
      verbBindings: { ...verbBindings, undeclared: binding.recipe.id } })).not.toThrow();
    expect(extra.recipes).not.toHaveProperty('undeclared');
    expect(extra.checks).toContainEqual({ verb: 'undeclared', tool: null, ok: false,
      problems: ['binding names a verb the class does not declare'] });
    const denied = await inspectIdentityRecipeClassProvider({ ...input, declaredNeeds: [] }, f.deps);
    expect(denied.ok).toBe(false);
    expect(denied.recipes).toEqual({});
    expect(denied.checks.every((check) => check.problems.includes('capability-denied'))).toBe(true);
  });

  it('invalidates earlier verb inspection when class inspection is cancelled', async () => {
    const f = fixture('return tools.status.read({});');
    const controller = new AbortController();
    f.input.context.signal = controller.signal;
    const inspect = f.inspect.getMockImplementation()!;
    let calls = 0;
    f.inspect.mockImplementation(async () => { if (++calls === 2) controller.abort(); return inspect(); });
    const report = await inspectIdentityRecipeClassProvider({
      capabilityClass: { ref: 'context.status@1.0.0', interfaceVerbs: { first: f.input.contract, second: f.input.contract },
        behavioralSuiteRef: null },
      providerPackage: 'context-provider', providerVersion: '1.0.0', registryRevision: 'registry-1',
      recipes: Object.fromEntries(['first', 'second'].map((verb) => [verb, { recipe: f.input.recipe, outputSchema }])),
      context: f.input.context, declaredNeeds: f.input.declaredNeeds, capabilityCeiling: f.input.capabilityCeiling,
    }, f.deps);
    expect(report.ok).toBe(false);
    expect(report.checks.every((check) => !check.ok && check.problems.includes('authority-unavailable'))).toBe(true);
  });

  it('pins source, binding values and exact revision without executing any tool or recipe', async () => {
    const f = fixture('return await tools.status.read({});');
    const result = await inspectIdentityRecipeProvider(f.input, f.deps);
    expect(result).toMatchObject({ ok: true, recipe: { id: 'recipe-1', revision },
      toolNames: ['status:read'], requiredCapabilities: ['status:read'], outputSchema,
      inspectionPin: { recipeRevision: revision, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bindingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(f.recipes.run).not.toHaveBeenCalled();
    for (const t of tools) expect(t.fn).not.toHaveBeenCalled();
  });

  it.each([
    ['return tools.status.write({});', 'effect-not-read'],
    ['return tools.status.unknown({});', 'effect-not-read'],
    ['return tools.status.egress({});', 'egress-capability'],
    ['return tools.status.pluginEgress({});', 'egress-capability'],
    ['return tools.call(inputs.target, {});', 'dynamic-tool-target'],
    ['return tools.status[inputs.target]({});', 'dynamic-tool-target'],
    ['const read = tools.status.read; return read({});', 'dynamic-tool-target'],
    ['const { call } = tools; return call(inputs.target, {});', 'dynamic-tool-target'],
    ['const call = tools.call; return call("status:read", {});', 'dynamic-tool-target'],
    ['const api = tools; return api.status.read({});', 'dynamic-tool-target'],
    ['return (function (api) { return api.status.read({}); })(tools);', 'dynamic-tool-target'],
    ['return eval("tools.status.read({})");', 'dynamic-tool-target'],
    ['return Function("return tools.status.read({})")();', 'dynamic-tool-target'],
    ['return (() => {}).constructor("return 1")();', 'dynamic-tool-target'],
    ['return Reflect.get({}, "constructor");', 'dynamic-tool-target'],
  ])('refuses unsafe or unprovable source: %s', async (source, code) => {
    const f = fixture(source);
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toMatchObject({ ok: false, code });
    expect(f.recipes.run).not.toHaveBeenCalled();
  });

  it('allows direct literal tool access with dynamic data, but refuses dynamic effect classifications', async () => {
    const f = fixture('return tools["status"]["read"]({ subject: inputs.subject });');
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toMatchObject({ ok: true });
    const conditional = tool('status:read', { effectForCall: () => 'read' });
    expect(await inspectIdentityRecipeProvider(f.input, { ...f.deps, tools: [conditional] }))
      .toEqual({ ok: false, code: 'effect-not-read' });
  });

  it('rechecks nested invocation target effects and capabilities', async () => {
    const read = fixture('return tools.tools.invoke({ name: "status:read", args: {} });');
    const result = await inspectIdentityRecipeProvider(read.input, read.deps);
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, toolNames: ['status:read', 'tools:invoke'], requiredCapabilities: ['status:read', 'tools:invoke'],
    });
    for (const [name, code] of [['status:write', 'effect-not-read'], ['status:egress', 'egress-capability']]) {
      const f = fixture(`return tools.tools.invoke({ name: "${name}", args: {} });`);
      expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toEqual({ ok: false, code });
    }
    const nested = fixture('return tools.tools.invoke({ name: "tools:invoke", args: { name: "status:write", args: {} } });');
    expect(await inspectIdentityRecipeProvider(nested.input, nested.deps)).toEqual({ ok: false, code: 'tool-unavailable' });
    const dynamic = fixture('return tools.tools.invoke({ name: inputs.target, args: {} });');
    expect(await inspectIdentityRecipeProvider(dynamic.input, dynamic.deps)).toEqual({ ok: false, code: 'dynamic-tool-target' });
  });

  it('does not upgrade malformed or thrown effect classifiers using static read metadata', async () => {
    const f = fixture('return tools.status.read({});');
    // A malformed plugin can violate the TypeScript contract at runtime.
    const malformed = (() => 'unknown') as unknown as NonNullable<ProjectedTool['effectForCall']>;
    for (const effectForCall of [() => { throw new Error('unavailable'); }, malformed]) {
      expect(await inspectIdentityRecipeProvider(f.input, { ...f.deps, tools: [tool('status:read', { effectForCall })] }))
        .toEqual({ ok: false, code: 'effect-not-read' });
    }
  });

  it('requires the real wearer and intersects declared needs, live grants and ceiling', async () => {
    const f = fixture('return tools.status.read({});');
    expect(await inspectIdentityRecipeProvider({ ...f.input, declaredNeeds: [] }, f.deps))
      .toEqual({ ok: false, code: 'capability-denied' });
    expect(await inspectIdentityRecipeProvider({ ...f.input, capabilityCeiling: new Set() }, f.deps))
      .toEqual({ ok: false, code: 'capability-denied' });
    f.input.context.principal = { ...f.input.context.principal!, capabilities: new Set() };
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toEqual({ ok: false, code: 'capability-denied' });
    f.input.context.principal = undefined;
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toEqual({ ok: false, code: 'authority-unavailable' });
  });

  it('refuses role-ineligible tools and wildcard tool capabilities', async () => {
    const f = fixture('return tools.status.read({});');
    expect(await inspectIdentityRecipeProvider(f.input, { ...f.deps, tools: [tool('status:read', { agentRoles: ['worker'] })] }))
      .toEqual({ ok: false, code: 'inspection-failed' });
    expect(await inspectIdentityRecipeProvider(f.input, { ...f.deps, tools: [tool('status:read', { capabilities: ['*'] })] }))
      .toEqual({ ok: false, code: 'egress-capability' });
  });

  it('keeps general runner doors out of both direct and nested recipe inspection', async () => {
    for (const name of ['code:run', 'orchestrate:run', 'recipes:run']) {
      const runner = tool(name); // Even a read annotation cannot admit a runner.
      const direct = fixture(`return tools.call("${name}", {});`);
      expect(await inspectIdentityRecipeProvider(direct.input, { ...direct.deps, tools: [...tools, runner] }))
        .toEqual({ ok: false, code: 'inspection-failed' });
      const nested = fixture(`return tools.tools.invoke({ name: "${name}", args: {} });`);
      expect(await inspectIdentityRecipeProvider(nested.input, { ...nested.deps, tools: [...tools, runner] }))
        .toEqual({ ok: false, code: 'tool-unavailable' });
    }
  });

  it('requires the exact valid class output schema before inspecting the recipe', async () => {
    const f = fixture('return tools.status.read({});');
    expect(await inspectIdentityRecipeProvider({ ...f.input, outputSchema: { type: 'string' } }, f.deps))
      .toEqual({ ok: false, code: 'output-schema-mismatch' });
    expect(await inspectIdentityRecipeProvider({ ...f.input, contract: { inputSchema: {} } }, f.deps))
      .toEqual({ ok: false, code: 'output-schema-mismatch' });
    const invalid = { type: 'made-up' };
    expect(await inspectIdentityRecipeProvider({ ...f.input, outputSchema: invalid,
      contract: { inputSchema: {}, outputSchema: invalid } }, f.deps))
      .toEqual({ ok: false, code: 'output-schema-mismatch' });
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it('refuses changed source, binding pin or recipe revision, even if still read-only', async () => {
    const f = fixture('return tools.status.read({});');
    const original = await inspectIdentityRecipeProvider(f.input, f.deps);
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error('fixture conformance failed');
    const changed = fixture('return tools.status.read({ subject: "new" });');
    expect(await inspectIdentityRecipeProvider({ ...changed.input, expectedPin: original.inspectionPin }, changed.deps))
      .toEqual({ ok: false, code: 'inspection-pin-stale' });
    expect(await inspectIdentityRecipeProvider({ ...f.input, expectedPin: {
      ...original.inspectionPin, bindingsSha256: 'b'.repeat(64),
    } }, f.deps)).toEqual({ ok: false, code: 'inspection-pin-stale' });
    expect(await inspectIdentityRecipeProvider({ ...f.input, recipe: { id: 'recipe-1', revision: 'b'.repeat(64) } }, f.deps))
      .toEqual({ ok: false, code: 'inspection-pin-stale' });
  });

  it('refuses aborted inspections before and after the asynchronous resolver', async () => {
    const f = fixture('return tools.status.read({});');
    const controller = new AbortController();
    f.input.context.signal = controller.signal;
    const inspect = f.inspect.getMockImplementation()!;
    f.inspect.mockImplementation(async () => { controller.abort(); return inspect(); });
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toEqual({ ok: false, code: 'authority-unavailable' });
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(await inspectIdentityRecipeProvider(f.input, f.deps)).toEqual({ ok: false, code: 'authority-unavailable' });
    expect(f.inspect).toHaveBeenCalledTimes(1);
  });
});
