/**
 * agent-tools.test.ts — the agent-facing `coord:ask-owner` TOOL's args schema
 * (EI-18682693723293580 recurrence guard).
 *
 * Bug: calling `coord:ask-owner` from inside `code:run` (foreground, ~55s hard
 * cap) ALWAYS script_timeout'd, because the exposed tool inherited the
 * internal `coord:ask` op's `timeout_s: 120` default and blocked in a 2s poll
 * loop — the write (open thread + escalate) had already landed by the time
 * the caller's script budget ran out, leaving a live double-post risk with no
 * cheap way to check what landed.
 *
 * Fix: the exposed tool (agent-tools.ts) declares its own `askOwnerArgs`
 * schema, identical to the op's except `timeout_s` defaults to 0 — return
 * immediately once the question is opened. This test pins that schema
 * default; `coord-ops/__tests__/compose.test.ts` pins the companion op-level
 * fix (timeout_s<=0 skips the poll loop entirely, not "one 2s poll").
 *
 * The tool itself registers into the PROJECTED tool registry (role-gated,
 * `requirePrincipal: false`), whose `handler` is wrapped behind payload-tier
 * shaping + StandardSchema validation + a UnifiedToolContext — no cheap unit
 * seam. `askOwnerArgs` is exported for exactly this reason: it is the one
 * piece of the wrapper a unit test can assert on directly without standing
 * up that machinery.
 *
 * Run: cd packages/operator-core && npx vitest run lib/coord-ops/agent-tools.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import { askOwnerArgs } from './agent-tools';
import { askOp } from './ops/compose';
import type { CoordOpCaps, CoordOpCtx } from './types';
import * as orgDb from '@papercusp/db-org';
import * as names from '../plan-items/agent-names';
import * as federation from '../hive-federation';
import * as blueprints from '../blueprint/project-to-pg';
import { makeHarnessOpProxy } from '../harness-ops/proxy';
import { getCoordOp, registerCoordOp } from './registry';

describe('oddsmith:analyze confined agent surface', () => {
  // The app's own contracts/worker suite covers Micros and Signal semantics;
  // these manifest fixtures isolate the platform's identity/validation boundary.
  const schema = { type: 'object', additionalProperties: false,
    properties: { requestKey: { type: 'string', minLength: 1 }, mode: { const: 'paper' } },
    required: ['requestKey', 'mode'] };
  const resultSchema = { type: 'object', additionalProperties: false,
    properties: { requestKey: { type: 'string' }, analysis: { type: 'array', maxItems: 1, items: { type: 'number' } } },
    required: ['requestKey', 'analysis'] };
  const manifest = { name: 'oddsmith:analyze', argsSchema: schema, resultSchema };
  const input = { requestKey: 'source-immutable-id', mode: 'paper' };
  const dispatchHarness = vi.fn();
  const context = (overrides = {}) => ({
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: 'workspace-a', role: 'oddsmith-analyst', harnessSlug: 'oddsmith',
    runId: 'analysis-contract', uiClientId: 's-analyst-1', sigVerifiedSpawn: true,
    ...overrides,
  }) as unknown as Parameters<typeof dispatchProjectedTool>[3];
  const call = (args: Record<string, unknown> = { input }, overrides = {}) =>
    dispatchProjectedTool(lookupByMcpName('oddsmith:analyze')!, 'oddsmith:analyze', args, context(overrides), {});
  let previous: ReturnType<typeof getCoordOp>;

  beforeEach(() => {
    previous = getCoordOp('oddsmith:analyze');
    dispatchHarness.mockReset().mockResolvedValue({ requestKey: input.requestKey, analysis: [] });
    registerCoordOp(makeHarnessOpProxy(manifest, dispatchHarness));
    mockOrgPgSql(vi.spyOn(orgDb, 'getOrgPg'), vi.fn(() => { throw new Error('Unexpected SQL in confined tool unit test'); }));
    vi.spyOn(names, 'resolveAdoptedName').mockResolvedValue('oddsmith-analyst');
    vi.spyOn(federation, 'canonicalHiveHomeSlug').mockImplementation(async (_workspace, harness) =>
      ['oddsmith', 'local-oddsmith'].includes(harness) ? 'oddsmith-hive' : 'foreign-hive');
    vi.spyOn(blueprints, 'getEffectiveBlueprint').mockResolvedValue(BlueprintSchema.parse({
      id: 'oddsmith', workItem: { kind: 'analysis' }, spine: {}, ops: [manifest],
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previous) registerCoordOp(previous);
  });

  it('forwards only the fixed op with host workspace/owner and resolves a local home alias', async () => {
    const result = await call({ input }, { harnessSlug: 'local-oddsmith' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(dispatchHarness).toHaveBeenCalledOnce();
    expect(dispatchHarness).toHaveBeenCalledWith('oddsmith', 'oddsmith:analyze', input, {
      workspaceId: 'workspace-a', ctx: expect.objectContaining({
        workspaceId: 'workspace-a', harnessSlug: 'oddsmith', ownerId: 's-analyst-1',
      }),
    });
    expect(names.resolveAdoptedName).toHaveBeenCalledWith('workspace-a', 's-analyst-1');
    expect(blueprints.getEffectiveBlueprint).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace-a', harnessSlug: 'oddsmith',
    });
  });

  it.each([
    { role: 'operator' }, { harnessSlug: 'foreign-app' }, { workspaceId: undefined },
    { workspaceId: 'default' }, { harnessSlug: undefined },
  ])('refuses a foreign or missing host identity %j before dispatch', async overrides => {
    expect((await call({ input }, overrides)).ok).toBe(false);
    expect(dispatchHarness).not.toHaveBeenCalled();
  });
  it('refuses the same stable name in a foreign workspace/pot', async () => {
    vi.mocked(federation.canonicalHiveHomeSlug).mockImplementation(async workspace =>
      workspace === 'workspace-a' ? 'oddsmith-hive' : 'foreign-hive');
    expect((await call({ input }, { workspaceId: 'workspace-b' })).ok).toBe(false);
    expect(dispatchHarness).not.toHaveBeenCalled();
  });
  it('refuses an unadopted or substituted stable name', async () => {
    for (const name of [null, 'other-analyst']) {
      vi.mocked(names.resolveAdoptedName).mockResolvedValue(name);
      expect((await call()).ok).toBe(false);
    }
    expect(dispatchHarness).not.toHaveBeenCalled();
  });
  it.each(['op', 'harness', 'workspaceId', 'role', 'agentName', 'order', 'capital', 'policy'])(
    'rejects caller-selected %s in the envelope and input', async key => {
      expect((await call({ input, [key]: 'override' })).ok).toBe(false);
      expect((await call({ input: { ...input, [key]: 'override' } })).ok).toBe(false);
      expect(dispatchHarness).not.toHaveBeenCalled();
    },
  );
  it.each([{ ...input, mode: 'live' }, { ...input, requestKey: '' }])('enforces declared PAPER values %j', async invalid => {
    expect((await call({ input: invalid })).ok).toBe(false);
    expect(dispatchHarness).not.toHaveBeenCalled();
  });
  it.each([
    { requestKey: input.requestKey, analysis: [], orders: [] },
    { requestKey: input.requestKey, analysis: [1, 2] },
  ])('rejects mutation-shaped and cardinality-invalid results %j', async invalid => {
    dispatchHarness.mockResolvedValue(invalid);
    expect((await call()).ok).toBe(false);
  });
  it('fails closed on missing installed schemas and name-registry failure', async () => {
    vi.mocked(blueprints.getEffectiveBlueprint).mockResolvedValue(null);
    expect((await call()).ok).toBe(false);
    vi.mocked(names.resolveAdoptedName).mockRejectedValue(new Error('name registry unavailable'));
    expect((await call()).ok).toBe(false);
    expect(dispatchHarness).not.toHaveBeenCalled();
  });
});

const makeCtx = (caps: Partial<CoordOpCaps>): CoordOpCtx => ({
  identity: { ownerId: 'owner-1' },
  depth: 0,
  now: () => '2026-01-01T00:00:00.000Z',
  newId: (p) => `${p}-test`,
  caps: caps as CoordOpCaps,
});

describe('coord:ask-owner tool args (askOwnerArgs)', () => {
  it('accepts the declared owner question and refuses the legacy options/context payload', async () => {
    const tool = lookupByMcpName('coord:ask-owner');
    expect(tool, 'the live tool must be registered').toBeDefined();
    const run = vi.spyOn(askOp, 'run').mockResolvedValue({
      answered: false,
      answer: null,
      conversation_id: 'fixture-owner-question',
    });
    const context = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'papercusp-workspace',
      role: 'operator',
      runId: 'owner-ask-contract',
      isSuperuser: true,
      uiClientId: 'su-owner-ask-fixture',
    } as unknown as Parameters<typeof dispatchProjectedTool>[3];
    const dispatch = (args: Record<string, unknown>) =>
      dispatchProjectedTool(tool!, 'coord:ask-owner', args, context, {});
    try {
      const valid = await dispatch({
        question: 'Which route should we take?',
        body: 'The two candidates are A and B.',
      });
      expect(valid.ok, JSON.stringify(valid)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);

      const legacy = await dispatch({
        question: 'Which route should we take?',
        options: ['A', 'B'],
        context: { decision: 'route' },
      });
      expect(legacy.ok).toBe(false);
      expect(legacy.error?.message).toMatch(/options.*context|context.*options/);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });

  it('defaults timeout_s to 0 — NOT the op\'s 120s default', () => {
    const parsed = askOwnerArgs.parse({ question: 'A or B?' });
    expect(parsed.timeout_s).toBe(0);
  });

  it('still accepts an explicit positive timeout_s for a caller that genuinely wants to block', () => {
    const parsed = askOwnerArgs.parse({ question: 'q', timeout_s: 30 });
    expect(parsed.timeout_s).toBe(30);
  });

  it('rejects a negative timeout_s (matches the op\'s nonnegative constraint)', () => {
    expect(() => askOwnerArgs.parse({ question: 'q', timeout_s: -1 })).toThrow();
  });

  it('end-to-end: parsed default args resolve immediately via askOp.run — no poll, no sleep', async () => {
    const caps = {
      openThread: vi.fn().mockResolvedValue({ thread_id: 't1', conversation_id: 'c1' }),
      escalate: vi.fn().mockResolvedValue({ msg_id: 'e1' }),
      sleep: vi.fn().mockResolvedValue(undefined),
      readAnswer: vi.fn().mockResolvedValue({ answered: false, answer: null }),
      findOverlappingGoalAsk: vi.fn().mockResolvedValue({ goalId: null, compared: 0, overlap: null }),
    };
    const args = askOwnerArgs.parse({ question: 'Ship it?' });
    const out = await askOp.run(args, makeCtx(caps));
    expect(out).toEqual({
      answered: false,
      answer: null,
      conversation_id: 'c1',
      goal_ask_dedup: { status: 'not-in-goal' },
    });
    expect(caps.sleep).not.toHaveBeenCalled();
    expect(caps.readAnswer).toHaveBeenCalledTimes(1);
  });
});
