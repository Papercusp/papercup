import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';

// Durable path ENABLED for this file (the default engine.test.ts has it disabled).
vi.mock('./durable', () => ({
  durableReactionsEnabled: () => true,
  runDurableReaction: vi.fn(async () => {}),
}));
vi.mock('./dispatch-reaction', () => ({
  fireReactionInProcess: vi.fn(async () => ({ ok: true })),
  buildReactionCtx: vi.fn(),
}));

import { handleToolInvoked } from './engine';
import { registerReactionRule, _resetReactionsForTests } from './registry';
import { runDurableReaction } from './durable';
import { fireReactionInProcess } from './dispatch-reaction';

const durable = vi.mocked(runDurableReaction);
const inproc = vi.mocked(fireReactionInProcess);

function pe(): PostInvokeEvent {
  return {
    toolName: 'demo:tool',
    pluginName: '',
    args: {},
    result: { ok: true, result: { content: [] } },
    ctx: { workspaceId: 'w1', runId: 'run-1' } as unknown as UnifiedToolContext,
    durationMs: 1,
  } as PostInvokeEvent;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetReactionsForTests();
  durable.mockReset().mockResolvedValue(undefined);
  inproc.mockReset().mockResolvedValue({ ok: true });
});

describe('durable routing', () => {
  it('routes a durable-mode rule to the DBOS enqueue (not in-process)', async () => {
    registerReactionRule({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' }); // default mode = durable
    handleToolInvoked(pe());
    await flush();
    expect(durable).toHaveBeenCalledOnce();
    expect(inproc).not.toHaveBeenCalled();
  });

  it('routes a sync-mode rule in-process even when durable is enabled', async () => {
    registerReactionRule({ id: 'r1', on: 'demo:tool', fire: 'sink:tool', mode: 'sync' });
    handleToolInvoked(pe());
    await flush();
    expect(inproc).toHaveBeenCalledOnce();
    expect(durable).not.toHaveBeenCalled();
  });

  it('falls back to in-process when the durable enqueue throws (never drops a reaction)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    durable.mockRejectedValue(new Error('dbos down'));
    registerReactionRule({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    handleToolInvoked(pe());
    await flush();
    expect(durable).toHaveBeenCalledOnce();
    expect(inproc).toHaveBeenCalledOnce(); // fell back
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('firing in-process'));
    warn.mockRestore();
  });
});
