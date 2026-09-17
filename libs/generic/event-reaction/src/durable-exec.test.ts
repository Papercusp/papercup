import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeDurableReaction, type DurableReactionPayload } from './durable-exec';
import type { ReactionStore } from './dedup';

interface TestParent {
  workspaceId?: string;
  uiClientId?: string;
  role?: string;
}

function payload(over: Partial<DurableReactionPayload<TestParent>> = {}): DurableReactionPayload<TestParent> {
  return {
    fire: 'sink:tool',
    args: { owner: 'agent-1' },
    parent: { workspaceId: 'w1', uiClientId: 'agent-1' },
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' },
    ruleId: 'r1',
    triggerTool: 'thing:done',
    dedupId: 'reaction:root:r1',
    ...over,
  };
}

function deps() {
  const store = {
    claim: vi.fn<ReactionStore['claim']>(async () => true),
    release: vi.fn<ReactionStore['release']>(async () => {}),
    markFailed: vi.fn<ReactionStore['markFailed']>(async () => {}),
  };
  const fire = vi.fn<(p: DurableReactionPayload<TestParent>) => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: true }),
  );
  const log = vi.fn<(m: string) => void>();
  return { store, fire, log };
}

describe('executeDurableReaction', () => {
  let d: ReturnType<typeof deps>;
  beforeEach(() => {
    d = deps();
  });

  it('claims the dedup id then dispatches when fresh', async () => {
    await executeDurableReaction(payload(), d);
    expect(d.store.claim).toHaveBeenCalledOnce();
    expect(d.store.claim.mock.calls[0][0]).toMatchObject({
      dedupId: 'reaction:root:r1',
      workspaceId: 'w1',
      fire: 'sink:tool',
      depth: 1,
    });
    expect(d.fire).toHaveBeenCalledOnce();
    expect(d.fire.mock.calls[0][0].fire).toBe('sink:tool');
  });

  it('carries the contributor into the claim, so the ledger can attribute the fire', async () => {
    await executeDurableReaction(payload({ contributor: 'plugin:acme' }), d);
    expect(d.store.claim.mock.calls[0][0].contributor).toBe('plugin:acme');
  });

  it('claims contributor NULL — never undefined — when the rule declares no source', async () => {
    await executeDurableReaction(payload(), d);
    // Explicit null, not a missing key: a store writing this straight into a
    // column needs a value, and `undefined` is not one.
    expect(d.store.claim.mock.calls[0][0].contributor).toBeNull();
  });

  it('is a no-op when the dedup id was already claimed (double-fire → no-op)', async () => {
    d.store.claim.mockResolvedValue(false);
    await executeDurableReaction(payload(), d);
    expect(d.fire).not.toHaveBeenCalled();
  });

  it('skips (no claim, no dispatch) when there is no workspace', async () => {
    await executeDurableReaction(payload({ parent: { uiClientId: 'a' } }), d);
    expect(d.store.claim).not.toHaveBeenCalled();
    expect(d.fire).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('no workspace'));
  });

  it('releases the claim and rethrows when dispatch fails (so the runner retries)', async () => {
    d.fire.mockResolvedValue({ ok: false, error: 'unknown reaction tool' });
    await expect(executeDurableReaction(payload(), d)).rejects.toThrow(/unknown reaction tool/);
    expect(d.store.release).toHaveBeenCalledWith('reaction:root:r1');
  });

  it('passes the serializable parent + cause through to the fire port', async () => {
    await executeDurableReaction(payload({ parent: { workspaceId: 'w1', role: 'worker' } }), d);
    const passed = d.fire.mock.calls[0][0];
    expect(passed.parent).toMatchObject({ workspaceId: 'w1', role: 'worker' });
    expect(passed.cause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' });
  });
});
