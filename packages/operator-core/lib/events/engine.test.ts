import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';

// Mock the executors so the engine's match → gate → guard → schedule logic is
// tested without touching PG / the real dispatcher.
vi.mock('./dispatch-reaction', () => ({
  fireReactionInProcess: vi.fn(async () => ({ ok: true })),
  buildReactionCtx: vi.fn(),
}));
vi.mock('./durable', () => ({
  durableReactionsEnabled: () => false,
  runDurableReaction: vi.fn(),
}));

import { handleToolInvoked } from './engine';
import { registerReactionRule, _resetReactionsForTests } from './registry';
import { fireReactionInProcess } from './dispatch-reaction';
import { MAX_REACTION_DEPTH } from '@papercusp/event-reaction';

const fired = vi.mocked(fireReactionInProcess);

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return { workspaceId: 'w1', runId: 'run-1', uiClientId: 'agent-1', ...over } as unknown as UnifiedToolContext;
}

function pe(over: Partial<PostInvokeEvent> = {}): PostInvokeEvent {
  return {
    toolName: 'demo:tool',
    pluginName: '',
    args: { item: 'WI-1' },
    result: { ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } },
    ctx: ctx(),
    durationMs: 1,
    ...over,
  } as PostInvokeEvent;
}

/** Let the void-scheduled async reaction run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetReactionsForTests();
  fired.mockClear();
});

describe('handleToolInvoked', () => {
  it('does nothing when no rule is registered for the tool', async () => {
    handleToolInvoked(pe());
    await flush();
    expect(fired).not.toHaveBeenCalled();
  });

  it('fires a matched rule with mapped args and a depth-1 cause-chain', async () => {
    registerReactionRule({
      id: 'r1',
      on: 'demo:tool',
      fire: 'sink:tool',
      args: (e) => ({ echoed: (e.args as { item: string }).item }),
    });
    handleToolInvoked(pe());
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    const call = fired.mock.calls[0][0];
    expect(call.fire).toBe('sink:tool');
    expect(call.args).toEqual({ echoed: 'WI-1' });
    expect(call.cause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'run-1' });
  });

  it('respects onlyOnSuccess (default true): skips when the trigger errored', async () => {
    registerReactionRule({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    handleToolInvoked(pe({ result: { ok: false, error: { code: 'handler_error', message: 'boom' } } }));
    await flush();
    expect(fired).not.toHaveBeenCalled();
  });

  it('onlyOnSuccess:false fires even on a failed trigger', async () => {
    registerReactionRule({ id: 'r1', on: 'demo:tool', fire: 'sink:tool', onlyOnSuccess: false });
    handleToolInvoked(pe({ result: { ok: false, error: { code: 'handler_error', message: 'boom' } } }));
    await flush();
    expect(fired).toHaveBeenCalledOnce();
  });

  it('evaluates a declarative `when` against the event', async () => {
    registerReactionRule({ id: 'r1', on: 'demo:tool', when: { 'args.item': { exists: true } }, fire: 'sink:tool' });
    registerReactionRule({ id: 'r2', on: 'demo:tool', when: { 'args.item': 'NOPE' }, fire: 'sink:tool' });
    handleToolInvoked(pe());
    await flush();
    expect(fired).toHaveBeenCalledOnce(); // only r1 matched
  });

  it('drops a reaction at the depth cap (loop guard) and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerReactionRule({ id: 'deep', on: 'demo:tool', fire: 'sink:tool' });
    const atCap = { depth: MAX_REACTION_DEPTH, chain: ['x'], ruleId: 'x', rootRunId: 'root' };
    handleToolInvoked(pe({ ctx: ctx({ reactionCause: atCap }) }));
    await flush();
    expect(fired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('depth_exceeded'));
    warn.mockRestore();
  });

  it('drops a cycle (the rule already fired in this chain) and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerReactionRule({ id: 'loop', on: 'demo:tool', fire: 'sink:tool' });
    const chain = { depth: 1, chain: ['loop'], ruleId: 'loop', rootRunId: 'root' };
    handleToolInvoked(pe({ ctx: ctx({ reactionCause: chain }) }));
    await flush();
    expect(fired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cycle'));
    warn.mockRestore();
  });

  it('extends an existing cause-chain by one when a reaction triggers another', async () => {
    registerReactionRule({ id: 'r2', on: 'demo:tool', fire: 'sink:tool' });
    const priorCause = { depth: 2, chain: ['a', 'b'], ruleId: 'b', rootRunId: 'root-xyz' };
    handleToolInvoked(pe({ ctx: ctx({ reactionCause: priorCause }) }));
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    expect(fired.mock.calls[0][0].cause).toEqual({
      depth: 3,
      chain: ['a', 'b', 'r2'],
      ruleId: 'r2',
      rootRunId: 'root-xyz',
    });
  });
});
