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

describe('emitSystemEvent (synthetic non-tool events)', () => {
  it('matches rules on the synthetic key and fires with payload as args + result.data', async () => {
    registerReactionRule({
      id: 'sys1',
      on: 'pipeline:step-done',
      when: (e) => (e.result.data as { role?: string }).role === 'worker',
      fire: 'sink:tool',
      args: (e) => ({ role: (e.args as { role: string }).role }),
    });
    const { emitSystemEvent } = await import('./engine');
    emitSystemEvent({ tool: 'pipeline:step-done', args: { role: 'worker' }, harnessSlug: 'h1' });
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    const call = fired.mock.calls[0][0];
    expect(call.fire).toBe('sink:tool');
    expect(call.args).toEqual({ role: 'worker' });
    expect(call.parentCtx.harnessSlug).toBe('h1');
  });

  it('no rules on the key → no fire, no throw', async () => {
    const { emitSystemEvent } = await import('./engine');
    emitSystemEvent({ tool: 'pipeline:launch', args: {} });
    await flush();
    expect(fired).not.toHaveBeenCalled();
  });

  it('carries a provided cause-chain into the loop guard (cycle dropped)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerReactionRule({ id: 'sysloop', on: 'myplugin.evt', fire: 'sink:tool' });
    const { emitSystemEvent } = await import('./engine');
    emitSystemEvent({
      tool: 'myplugin.evt',
      args: {},
      cause: { depth: 1, chain: ['sysloop'], ruleId: 'sysloop', rootRunId: 'root' },
    });
    await flush();
    expect(fired).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cycle'));
    warn.mockRestore();
  });
});

// D-007 (bulk-endpoint-standardization-2026-06-21): a dual-arity verb returns the
// `_bulk` keyed-array envelope; the dispatch layer must fan it out so every per-item
// reaction rule + emits desugar fires once PER ITEM, reading the singular e.args.id /
// e.result.data.workItem exactly as a single invocation would.
describe('bulk-envelope fan-out (D-007)', () => {
  const envelope = (results: Array<Record<string, unknown>>) => ({
    ok: true,
    results,
    counts: {
      ok: results.filter((r) => r.ok !== false).length,
      failed: results.filter((r) => r.ok === false).length,
    },
  });
  const bulkPe = (args: unknown, results: Array<Record<string, unknown>>, over: Partial<PostInvokeEvent> = {}) =>
    pe({
      toolName: 'wi:bulkverb',
      args,
      result: { ok: true, result: { content: [{ type: 'text', text: JSON.stringify(envelope(results)) }] } },
      ...over,
    });

  it('fans an items:[…] envelope into one per-item event; rules read the singular e.args.id', async () => {
    registerReactionRule({ id: 'r', on: 'wi:bulkverb', fire: 'sink:tool', args: (e) => ({ id: (e.args as { id: string }).id }) });
    handleToolInvoked(bulkPe({ items: [{ id: 'WI-1' }, { id: 'WI-2' }] }, [{ ok: true, id: 'WI-1' }, { ok: true, id: 'WI-2' }]));
    await flush();
    expect(fired).toHaveBeenCalledTimes(2);
    expect(fired.mock.calls.map((c) => (c[0].args as { id: string }).id).sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('per-item event carries results[i] as result.data (rules reading e.result.data.workItem fire per item)', async () => {
    registerReactionRule({
      id: 'r',
      on: 'wi:bulkverb',
      when: (e) => Boolean((e.result.data as { workItem?: unknown }).workItem),
      fire: 'sink:tool',
      args: (e) => ({ wi: (e.result.data as { workItem: { id: string } }).workItem.id }),
    });
    handleToolInvoked(
      bulkPe({ ids: ['WI-1', 'WI-2'], state: 'passed' }, [
        { ok: true, id: 'WI-1', workItem: { id: 'WI-1', state: 'passed' } },
        { ok: true, id: 'WI-2', workItem: { id: 'WI-2', state: 'passed' } },
      ]),
    );
    await flush();
    expect(fired.mock.calls.map((c) => (c[0].args as { wi: string }).wi).sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('ids:[…] + a shared scalar reconstructs per-item { id, <scalar> }', async () => {
    registerReactionRule({ id: 'r', on: 'wi:bulkverb', fire: 'sink:tool', args: (e) => e.args as Record<string, unknown> });
    handleToolInvoked(bulkPe({ ids: ['WI-1'], state: 'passed', harness: 'h' }, [{ ok: true, id: 'WI-1' }]));
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    expect(fired.mock.calls[0][0].args).toEqual({ id: 'WI-1', state: 'passed', harness: 'h' });
  });

  it('a failed item is skipped by onlyOnSuccess; a succeeded sibling still fires', async () => {
    registerReactionRule({ id: 'r', on: 'wi:bulkverb', fire: 'sink:tool', args: (e) => ({ id: (e.args as { id: string }).id }) });
    handleToolInvoked(
      bulkPe({ items: [{ id: 'OK' }, { id: 'BAD' }] }, [{ ok: true, id: 'OK' }, { ok: false, id: 'BAD', error: 'not found' }]),
    );
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    expect((fired.mock.calls[0][0].args as { id: string }).id).toBe('OK');
  });

  it('a single { id } call returning an envelope fans out to exactly one event (n=1 ≡ single dispatch)', async () => {
    registerReactionRule({ id: 'r', on: 'wi:bulkverb', fire: 'sink:tool', args: (e) => ({ id: (e.args as { id: string }).id }) });
    handleToolInvoked(bulkPe({ id: 'WI-9' }, [{ ok: true, id: 'WI-9' }]));
    await flush();
    expect(fired).toHaveBeenCalledOnce();
    expect((fired.mock.calls[0][0].args as { id: string }).id).toBe('WI-9');
  });

  it('a non-envelope { results } without counts is NOT fanned out — dispatched once unchanged', async () => {
    registerReactionRule({ id: 'r', on: 'wi:bulkverb', fire: 'sink:tool' });
    handleToolInvoked(
      pe({
        toolName: 'wi:bulkverb',
        args: { id: 'X' },
        result: { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [{ ok: true }] }) }] } },
      }),
    );
    await flush();
    expect(fired).toHaveBeenCalledOnce();
  });
});
