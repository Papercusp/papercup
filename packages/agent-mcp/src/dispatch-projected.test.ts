/**
 * Tests for the unified projected-tool dispatcher.
 * Run with: npx vitest run packages/agent-mcp/src/dispatch-projected.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  computeProjectedQuotaWindowKey,
  type DispatchProjectedDeps,
} from './dispatch-projected';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import type { ToolResult } from '@papercusp/plugin-sdk';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: 'F-AUTH-003',
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

const MAKE_DEPS = (over: Partial<DispatchProjectedDeps> = {}): DispatchProjectedDeps => ({
  readQuotaState: undefined,
  recordInvocation: undefined,
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('computeProjectedQuotaWindowKey', () => {
  it('uses chunk:<id> for workers', () => {
    expect(computeProjectedQuotaWindowKey(MAKE_CTX({ role: 'worker', chunkId: 'ck_A' }))).toBe('chunk:ck_A');
  });
  it('uses run:<id> for non-workers', () => {
    expect(computeProjectedQuotaWindowKey(MAKE_CTX({ role: 'architect', runId: 'run_A', chunkId: null }))).toBe('run:run_A');
  });
  it('returns null for workers without a chunk', () => {
    expect(computeProjectedQuotaWindowKey(MAKE_CTX({ role: 'worker', chunkId: null }))).toBeNull();
  });
});

describe('dispatchProjectedTool', () => {
  it('invokes the function and returns its ToolResult', async () => {
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'invoked' }] }),
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', { x: 1 }, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(true);
    expect(r.result?.content[0]).toEqual({ type: 'text', text: 'invoked' });
  });

  it('passes the unified context to the function', async () => {
    let captured: UnifiedToolContext | null = null;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        captured = ctx;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'architect', spawnId: 'spw_Y' }), MAKE_DEPS());
    expect(captured).not.toBeNull();
    expect(captured!.role).toBe('architect');
    expect(captured!.spawnId).toBe('spw_Y');
  });

  it('rejects role-not-allowed when caller role outside allowlist', async () => {
    const tool = makeTool({ roles: ['architect'] });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker' }), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
    expect(recorded).toEqual(['role-not-allowed']);
  });

  it('skips role check when ctx.role is unset (HTTP caller without role)', async () => {
    const tool = makeTool({ roles: ['architect'] });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: undefined }), MAKE_DEPS());
    expect(r.ok).toBe(true);
  });

  it('rejects quota_exceeded when count is at the limit', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perChunk: 1 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => ({ count: 1 })),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('quota_exceeded');
    expect(r.error?.meta).toMatchObject({ used: 1, limit: 1 });
  });

  it('allows when count under limit', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perChunk: 5 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => ({ count: 2 })),
    }));
    expect(r.ok).toBe(true);
  });

  it('fails-open when readQuotaState throws', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perChunk: 1 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => { throw new Error('pg down'); }),
    }));
    expect(r.ok).toBe(true);
  });

  it('records ok invocations with output size', async () => {
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'a b c' }] }),
    });
    const recorded: Array<{ status: string; outputSize?: number | null }> = [];
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push({ status: i.status, outputSize: i.outputSize }); }),
    }));
    expect(recorded[0]?.status).toBe('ok');
    expect(recorded[0]?.outputSize).toBeGreaterThan(0);
  });

  it('records handler_error when fn throws', async () => {
    const tool = makeTool({ fn: async () => { throw new Error('boom'); } });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('handler_error');
    expect(recorded).toEqual(['error']);
  });

  it('returns timeout when fn exceeds timeoutSec', async () => {
    const tool = makeTool({
      timeoutSec: 0.05,
      fn: async (_input, ctx) =>
        new Promise<ToolResult>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ content: [] }), 1000);
        }),
    });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('timeout');
    expect(recorded).toEqual(['timeout']);
  });

  it('routes ctx.progress() to the unified context (handler can call it)', async () => {
    const progressCalls: Array<[number | undefined, string | undefined]> = [];
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.progress(0, 'starting');
        ctx.progress(50);
        ctx.progress(100, 'done');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const ctx = MAKE_CTX({
      progress: (pct, msg) => progressCalls.push([pct, msg]),
    });
    await dispatchProjectedTool(tool, 'fix.tool', {}, ctx, MAKE_DEPS());
    expect(progressCalls).toEqual([[0, 'starting'], [50, undefined], [100, 'done']]);
  });
});
