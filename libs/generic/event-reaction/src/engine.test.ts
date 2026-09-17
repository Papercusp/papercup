import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReactions, type FireInProcess, type DurableSeam, type OnReactionFailure } from './engine';
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

// P-030 (b). The `log` port formats a failure into a sentence, which is why a
// host could never record or surface one: the rule, its contributor, its
// capability scope and the dedup id are all unrecoverable from prose. These
// assert the STRUCTURE survives.
describe('runReactions failure surfacing', () => {
  const makeOnFailure = () => vi.fn<OnReactionFailure<TestEvent>>();
  let h: ReturnType<typeof harness>;
  let onFailure: ReturnType<typeof makeOnFailure>;
  beforeEach(() => {
    h = harness();
    onFailure = makeOnFailure();
  });

  it('reports a dispatch refusal with the rule, contributor, capability and dedup id intact', async () => {
    h.registry.add({
      id: 'r1',
      on: 'demo:tool',
      fire: 'sink:tool',
      source: 'plugin:acme',
      capability: 'sink.write',
    });
    h.fireInProcess.mockResolvedValueOnce({ ok: false, error: 'missing_capability: principal lacks [sink.write]' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure });
    await flush();

    expect(onFailure).toHaveBeenCalledOnce();
    const f = onFailure.mock.calls[0][0];
    expect(f.stage).toBe('dispatch');
    expect(f.rule.id).toBe('r1');
    // The two fields an alert needs and a log line destroys.
    expect(f.rule.source).toBe('plugin:acme');
    expect(f.rule.capability).toBe('sink.write');
    expect(f.error).toBe('missing_capability: principal lacks [sink.write]');
    // Deterministic, and the SAME id the durable route would claim — so an
    // in-process failure and a ledger row correlate on one key.
    expect(f.dedupId).toBe('reaction:run-1:r1');
    expect(f.cause.ruleId).toBe('r1');
  });

  it('reports a thrown dispatcher as stage "threw"', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.fireInProcess.mockRejectedValueOnce(new Error('dispatcher exploded'));
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure });
    await flush();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0].stage).toBe('threw');
    expect(onFailure.mock.calls[0][0].error).toBe('dispatcher exploded');
  });

  it('is silent on success — only a failed reaction is reported', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure });
    await flush();
    expect(h.fireInProcess).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('keeps the human log line as well as the structured report', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.fireInProcess.mockResolvedValueOnce({ ok: false, error: 'boom' });
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure });
    await flush();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('reaction r1 → sink:tool failed: boom'));
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('a throwing onFailure never becomes a second failure', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.fireInProcess.mockResolvedValueOnce({ ok: false, error: 'boom' });
    onFailure.mockImplementation(() => {
      throw new Error('surfacing is broken');
    });
    expect(() => h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure })).not.toThrow();
    await flush();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('surfacing'));
  });

  it('a REJECTING async onFailure is swallowed too (unhandled rejections would kill the host)', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.fireInProcess.mockResolvedValueOnce({ ok: false, error: 'boom' });
    onFailure.mockRejectedValue(new Error('alerting is down'));
    h.run({ kind: 'demo:tool', runId: 'run-1' }, { onFailure });
    await flush();
    await flush();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('alerting is down'));
  });

  it('a guard DROP is not a failure — the cap working is not something to alert on', async () => {
    h.registry.add({ id: 'r1', on: 'demo:tool', fire: 'sink:tool' });
    h.run(
      {
        kind: 'demo:tool',
        runId: 'run-1',
        cause: { depth: MAX_REACTION_DEPTH + 1, chain: ['x'], ruleId: 'x', rootRunId: 'run-1' },
      },
      { onFailure },
    );
    await flush();
    expect(h.fireInProcess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('dropped reaction'));
  });
});
