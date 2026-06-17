/**
 * capability-tools.test.ts — the CapabilityTool wrappers + profile materialization +
 * cross-sandbox isolation (P-001). FULLY STUBBED: a fake run-tool that records every MCP
 * verb + args (and simulates a per-hive memory store for the isolation test). NO real
 * hive boot, NO real MCP call, NO opus spend.
 */
import { describe, expect, it } from 'vitest';
import { openRunSandbox } from './run-sandbox';
import {
  memoryRememberTool,
  memorySearchTool,
  workqueueEnqueueTool,
  workqueueClaimTool,
  workqueueCompleteTool,
  coordConsultTool,
  coordHandoffTool,
  coordAskTool,
  unwrapRunToolPayload,
  type OpenRunSandboxDeps,
} from './capability-tools';
import { CAPABILITY_PROFILES, materializeProfile, resolveProfile } from './capability-profile';
import type { RunSandbox, RunTool, RunToolResult, SandboxHiveOps } from './types';

/** A SandboxHiveOps that does nothing (the tools don't touch the hive ops). */
function noopHiveOps(): SandboxHiveOps {
  return {
    async createHive() {},
    async registerMember() {},
    async seedFeature() {},
    async dropMember() {},
    async dissolveHive() {},
  };
}

/** A run-tool that records every call so the test asserts the verb + scope. */
function recordingRunTool(): RunTool & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fn = (async (name, args) => {
    calls.push({ name, args });
    return { ok: true, payload: { ok: true } } satisfies RunToolResult;
  }) as RunTool & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

async function openWith(runTool: RunTool, hiveSlug: string): Promise<RunSandbox> {
  const deps: OpenRunSandboxDeps = { workspaceId: 'ws-test', hiveOps: noopHiveOps(), runTool };
  return openRunSandbox(deps, { suite: 's', arm: 'a', runId: 'r', hiveSlug });
}

describe('CapabilityTool — verb + sandbox scope', () => {
  it('memory.remember fires memory:remember with hive_slug = sandbox.hiveSlug', async () => {
    const runTool = recordingRunTool();
    const sandbox = await openWith(runTool, 'hive-mem');
    await memoryRememberTool(sandbox).invoke({ fact: 'tests live next to source' });
    expect(runTool.calls).toHaveLength(1);
    expect(runTool.calls[0].name).toBe('memory:remember');
    expect(runTool.calls[0].args).toMatchObject({
      content: 'tests live next to source',
      kind: 'project',
      hive_slug: 'hive-mem',
      workspace: 'ws-test',
    });
  });

  it('memory.search fires memory:search scoped to the sandbox member harness', async () => {
    const runTool = recordingRunTool();
    const sandbox = await openWith(runTool, 'hive-mem');
    await memorySearchTool(sandbox).invoke({ query: 'where do tests live', limit: 5 });
    expect(runTool.calls[0].name).toBe('memory:search');
    expect(runTool.calls[0].args).toMatchObject({
      query: 'where do tests live',
      harness_slug: 'hive-mem-m',
      limit: 5,
      workspace: 'ws-test',
    });
  });

  it('workqueue.* fire work_items:* scoped to the sandbox member harness', async () => {
    const runTool = recordingRunTool();
    const sandbox = await openWith(runTool, 'hive-wq');

    await workqueueEnqueueTool(sandbox).invoke({ title: 'sub A', summary: 'detail' });
    await workqueueClaimTool(sandbox).invoke({});
    await workqueueCompleteTool(sandbox).invoke({ id: 'WI-1', summary: 'done' });

    expect(runTool.calls.map((c) => c.name)).toEqual([
      'work_items:create',
      'work_items:claim_next',
      'work_items:complete',
    ]);
    expect(runTool.calls[0].args).toMatchObject({ kind: 'feature', title: 'sub A', harness: 'hive-wq-m' });
    expect(runTool.calls[1].args).toMatchObject({ harness: 'hive-wq-m' });
    expect(runTool.calls[2].args).toMatchObject({ id: 'WI-1', harness: 'hive-wq-m', state: 'passed' });
  });

  it('coord.* fire coord:* scoped to the sandbox hive (never the live fleet)', async () => {
    const runTool = recordingRunTool();
    const sandbox = await openWith(runTool, 'hive-coord');

    await coordConsultTool(sandbox).invoke({ specialist: 'reviewer', question: 'is this safe?' });
    await coordAskTool(sandbox).invoke({ question: 'anyone seen this?' });
    await coordHandoffTool(sandbox).invoke({ to: ['peer-1'], summary: 'over to you', nextAction: 'ship it' });

    expect(runTool.calls.map((c) => c.name)).toEqual(['coord:ask', 'coord:ask', 'coord:handoff']);
    expect(runTool.calls[0].args).toMatchObject({ harness: 'hive-coord', force_open: true });
    expect(String(runTool.calls[0].args.question)).toContain('[consult:reviewer]');
    expect(runTool.calls[1].args).toMatchObject({ harness: 'hive-coord' });
    expect(runTool.calls[2].args).toMatchObject({ to: ['peer-1'], summary: 'over to you', next_action: 'ship it' });
  });

  it('a non-ok run-tool result throws a descriptive error', async () => {
    const failing: RunTool = async () => ({ ok: false, payload: {}, error: 'boom' });
    const sandbox = await openWith(failing, 'hive-x');
    await expect(memoryRememberTool(sandbox).invoke({ fact: 'x' })).rejects.toThrow(
      /capability tool memory:remember failed: boom/,
    );
  });

  it('every tool carries a name, capability, and a JSON-schema descriptor', async () => {
    const sandbox = await openWith(recordingRunTool(), 'hive-schema');
    const tool = memoryRememberTool(sandbox);
    expect(tool.name).toBe('memory.remember');
    expect(tool.capability).toBe('memory');
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties.fact.type).toBe('string');
    expect(tool.inputSchema.required).toContain('fact');
  });
});

describe('memory isolation — A is searchable in A, never in B or production', () => {
  /**
   * A fake run-tool backed by a per-hive_slug store. memory:remember appends under the
   * write scope (hive_slug); memory:search reads back the scope the member resolves to
   * (harness_slug → its hive). Production reads the unscoped pool (no hive). This models
   * exactly the production scoping: the hive pool is isolated from production mem0 and
   * between hives.
   */
  function isolatingRunTool(): RunTool {
    const byHive = new Map<string, string[]>(); // hive_slug → facts
    const memberToHive = (member: string) => member.replace(/-m$/, ''); // memberSlug → hiveSlug
    return async (name, args) => {
      if (name === 'memory:remember') {
        const hive = String(args.hive_slug);
        (byHive.get(hive) ?? byHive.set(hive, []).get(hive)!).push(String(args.content));
        return { ok: true, payload: { ok: true } };
      }
      if (name === 'memory:search') {
        const hive = args.harness_slug ? memberToHive(String(args.harness_slug)) : '__production__';
        const facts = byHive.get(hive) ?? [];
        const q = String(args.query);
        const results = facts.filter((f) => f.includes(q)).map((memory) => ({ memory }));
        return { ok: true, payload: { ok: true, results } };
      }
      return { ok: true, payload: {} };
    };
  }

  it('a fact written in sandbox A is recalled in A, absent in B and in production', async () => {
    const runTool = isolatingRunTool();
    const sandboxA = await openWith(runTool, 'hive-A');
    const sandboxB = await openWith(runTool, 'hive-B');

    await memoryRememberTool(sandboxA).invoke({ fact: 'SECRET-A: build with pnpm' });

    // A recalls its own fact.
    const inA = (await memorySearchTool(sandboxA).invoke({ query: 'SECRET-A' })).payload as {
      results: Array<{ memory: string }>;
    };
    expect(inA.results.map((r) => r.memory)).toContain('SECRET-A: build with pnpm');

    // B does NOT see A's fact (between-arm isolation).
    const inB = (await memorySearchTool(sandboxB).invoke({ query: 'SECRET-A' })).payload as {
      results: Array<{ memory: string }>;
    };
    expect(inB.results).toHaveLength(0);

    // Production (unscoped) does NOT see A's fact (production isolation).
    const prod = (await runTool('memory:search', { query: 'SECRET-A' })).payload as {
      results: Array<{ memory: string }>;
    };
    expect(prod.results).toHaveLength(0);
  });

  it('memory ACCUMULATES across tasks within the same run/arm (D-007)', async () => {
    const runTool = isolatingRunTool();
    const sandbox = await openWith(runTool, 'hive-accum');
    // Task 1 learns; task 2 (same sandbox) recalls — cross-task learning IS the lift.
    await memoryRememberTool(sandbox).invoke({ fact: 'LEARNED: run the linter before commit' });
    const recalled = (await memorySearchTool(sandbox).invoke({ query: 'LEARNED' })).payload as {
      results: Array<{ memory: string }>;
    };
    expect(recalled.results.map((r) => r.memory)).toContain('LEARNED: run the linter before commit');
  });
});

describe('CapabilityProfile + materializeProfile', () => {
  it('vanilla materializes to no tools', async () => {
    const sandbox = await openWith(recordingRunTool(), 'hive-p');
    expect(materializeProfile('vanilla', sandbox)).toEqual([]);
  });

  it('+memory materializes to exactly the memory tools', async () => {
    const sandbox = await openWith(recordingRunTool(), 'hive-p');
    const tools = materializeProfile('+memory', sandbox);
    expect(tools.map((t) => t.name)).toEqual(['memory.remember', 'memory.search']);
    expect(tools.every((t) => t.capability === 'memory')).toBe(true);
  });

  it('+workqueue and +coord materialize only their own tools', async () => {
    const sandbox = await openWith(recordingRunTool(), 'hive-p');
    expect(materializeProfile('+workqueue', sandbox).map((t) => t.name)).toEqual([
      'workqueue.enqueue',
      'workqueue.claim',
      'workqueue.complete',
    ]);
    expect(materializeProfile('+coord', sandbox).map((t) => t.name)).toEqual([
      'coord.consult',
      'coord.handoff',
      'coord.ask',
    ]);
  });

  it('ours materializes the curated set (memory + workqueue + coord), each capability once', async () => {
    const sandbox = await openWith(recordingRunTool(), 'hive-p');
    const tools = materializeProfile('ours', sandbox);
    const caps = new Set(tools.map((t) => t.capability));
    expect(caps).toEqual(new Set(['memory', 'workqueue', 'coord']));
    // 2 memory + 3 workqueue + 3 coord = 8 tools.
    expect(tools).toHaveLength(8);
  });

  it('resolveProfile throws on an unknown name and passes a profile object through', () => {
    expect(() => resolveProfile('nope' as never)).toThrow(/unknown capability profile/);
    expect(resolveProfile(CAPABILITY_PROFILES.ours).name).toBe('ours');
  });

  it('a materialized tool is bound to its sandbox (its calls carry that sandbox scope)', async () => {
    const runTool = recordingRunTool();
    const sandbox = await openWith(runTool, 'hive-bound');
    const [remember] = materializeProfile('+memory', sandbox);
    await remember.invoke({ fact: 'bound fact' } as never);
    expect(runTool.calls[0].args).toMatchObject({ hive_slug: 'hive-bound' });
  });
});

describe('unwrapRunToolPayload', () => {
  it('unwraps the content[0].text JSON envelope', () => {
    const payload = unwrapRunToolPayload({ content: [{ text: JSON.stringify({ ok: true, ids: ['m1'] }) }] });
    expect(payload).toEqual({ ok: true, ids: ['m1'] });
  });
  it('tolerates a flat result object', () => {
    expect(unwrapRunToolPayload({ ok: true, placements: [] })).toEqual({ ok: true, placements: [] });
  });
  it('returns { text } when the wrapped body is not JSON', () => {
    expect(unwrapRunToolPayload({ content: [{ text: 'plain text' }] })).toEqual({ text: 'plain text' });
  });
});
