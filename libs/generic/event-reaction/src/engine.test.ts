import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReactions, type FireInProcess, type DurableSeam } from './engine';
import { ReactionRegistry } from './registry';
import { MAX_REACTION_DEPTH } from './loop-guard';
import type { ReactionCause } from './types';

// Synthetic event — the engine never reads host-specific fields; the caller
// passes `succeeded` / `cause` / `rootRunId` explicitly. Proves genericity.
interface TestEvent {
  kind: string;
  item?: string;
  cause?: ReactionCause;
  runId?: string;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const registry = new ReactionRegistry<TestEvent>({ keyOf: (e) => e.kind });
  const fireInProcess = vi.fn<FireInProcess<TestEvent>>(async () => ({ ok: true }));
  const log = vi.fn<(m: string) => void>();
  const run = (event: TestEvent, over: Partial<Parameters<typeof runReactions<TestEvent>>[0]> = {}) =>
    runReactions<TestEvent>({
      actions: registry.match(event),
      event,
      succeeded: true,
      cause: event.cause,
      rootRunId: event.runId ?? null,
      fireInProcess,
      log,
      ...over,
    });
  return { registry, fireInProcess, log, run };
}

describe('runReactions', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('does nothing when no rule matches', async () => {
    h.run({ kind: 'demo:tool', runId: 'run-1' });
    await flush();
    expect(h.fireInProcess).not.toHaveBeenCalled();
  });

  it('fires a matched rule with mapped args and a depth-1 cause-chain', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool', args: (e) => ({ echoed: e.item }) });
    h.run({ kind: 'demo:tool', item: 'WI-1', runId: 'run-1' });
    await flush();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    const call = h.fireInProcess.mock.calls[0][0];
    expect(call.fire).toBe('sink:tool');
    expect(call.args).toEqual({ echoed: 'WI-1' });
    expect(call.cause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'run-1' });
  });

  it('respects onlyOnSuccess (default true): skips when the trigger errored', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { succeeded: false });
    await flush();
    expect(h.fireInProcess).not.toHaveBeenCalled();
  });

  it('onlyOnSuccess:false fires even on a failed trigger', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool', onlyOnSuccess: false });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { succeeded: false });
    await flush();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
  });

  it('drops a reaction at the depth cap and logs it', async () => {
    h.registry.add({ id: 'deep', on: 'demo:tool', fire: 'sink:tool' });
    const atCap: ReactionCause = { depth: MAX_REACTION_DEPTH, chain: ['x'], ruleId: 'x', rootRunId: 'root' };
    h.run({ kind: 'demo:tool', cause: atCap });
    await flush();
    expect(h.fireInProcess).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('depth_exceeded'));
  });

  it('drops a cycle (the rule already fired in this chain) and logs it', async () => {
    h.registry.add({ id: 'loop', on: 'demo:tool', fire: 'sink:tool' });
    const chain: ReactionCause = { depth: 1, chain: ['loop'], ruleId: 'loop', rootRunId: 'root' };
    h.run({ kind: 'demo:tool', cause: chain });
    await flush();
    expect(h.fireInProcess).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('cycle'));
  });

  it('extends an existing cause-chain by one when a reaction triggers another', async () => {
    h.registry.add({ id: 'r2', on: 'demo:tool', fire: 'sink:tool' });
    const prior: ReactionCause = { depth: 2, chain: ['a', 'b'], ruleId: 'b', rootRunId: 'root-xyz' };
    h.run({ kind: 'demo:tool', cause: prior });
    await flush();
    expect(h.fireInProcess.mock.calls[0][0].cause).toEqual({
      depth: 3,
      chain: ['a', 'b', 'r2'],
      ruleId: 'r2',
      rootRunId: 'root-xyz',
    });
  });
});

describe('runReactions — durable routing', () => {
  function durableHarness(enabled: boolean) {
    const h = harness();
    const run = vi.fn(async () => {});
    const durable: DurableSeam<TestEvent> = { enabled: () => enabled, run };
    return { ...h, durableRun: run, durable };
  }

  it('routes a durable-mode rule (the default) to the durable seam, not in-process', async () => {
    const h = durableHarness(true);
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { durable: h.durable });
    await flush();
    expect(h.durableRun).toHaveBeenCalledOnce();
    expect(h.fireInProcess).not.toHaveBeenCalled();
  });

  it('routes a sync-mode rule in-process even when durable is enabled', async () => {
    const h = durableHarness(true);
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool', mode: 'sync' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { durable: h.durable });
    await flush();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.durableRun).not.toHaveBeenCalled();
  });

  it('falls back to in-process when the durable enqueue throws (never drops a reaction)', async () => {
    const h = durableHarness(true);
    h.durableRun.mockRejectedValueOnce(new Error('queue down'));
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { durable: h.durable });
    await flush();
    expect(h.durableRun).toHaveBeenCalledOnce();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('firing in-process'));
  });

  it('with durable disabled, a durable-mode rule fires in-process', async () => {
    const h = durableHarness(false);
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { durable: h.durable });
    await flush();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(h.durableRun).not.toHaveBeenCalled();
  });
});
