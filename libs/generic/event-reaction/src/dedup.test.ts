import { describe, it, expect } from 'vitest';
import { computeDedupId, type DedupIdInput, type ReactionStore, type ReactionClaim } from './dedup';
import type { ReactionRule } from './types';

interface TestEvent {
  kind: string;
  item?: string;
}

function input(over: Partial<DedupIdInput<TestEvent>> = {}): DedupIdInput<TestEvent> {
  const rule: ReactionRule<TestEvent> = { id: 'r1', on: 'k', fire: 'f' };
  return {
    rule,
    event: { kind: 'k', item: 'WI-1' },
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root-7' },
    rootRunId: 'fallback-run',
    ...over,
  };
}

describe('computeDedupId', () => {
  it('is deterministic over (rootRunId, ruleId)', () => {
    expect(computeDedupId(input())).toBe('reaction:root-7:r1');
    expect(computeDedupId(input())).toBe('reaction:root-7:r1');
  });

  it('falls back to the provided rootRunId when cause.rootRunId is unset', () => {
    expect(computeDedupId(input({ cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: null } }))).toBe(
      'reaction:fallback-run:r1',
    );
  });

  it('uses "noroot" when neither root is available', () => {
    expect(
      computeDedupId(input({ cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: null }, rootRunId: null })),
    ).toBe('reaction:noroot:r1');
  });

  it('appends a rule-supplied dedupKey', () => {
    const rule: ReactionRule<TestEvent> = { id: 'r1', on: 'k', fire: 'f', dedupKey: (e) => String(e.item) };
    expect(computeDedupId(input({ rule }))).toBe('reaction:root-7:r1:WI-1');
  });
});

describe('ReactionStore (port contract)', () => {
  // A trivial in-memory store proves the contract is implementable without any host.
  function memStore(): ReactionStore & { claimed: Map<string, ReactionClaim> } {
    const claimed = new Map<string, ReactionClaim>();
    return {
      claimed,
      async claim(c) {
        if (claimed.has(c.dedupId)) return false;
        claimed.set(c.dedupId, c);
        return true;
      },
      async release(id) {
        claimed.delete(id);
      },
      async markFailed() {},
    };
  }

  it('first claim wins, a re-delivery is a no-op, release re-opens it', async () => {
    const s = memStore();
    const c: ReactionClaim = { dedupId: 'd1', workspaceId: 'w', ruleId: 'r', fire: 'f', depth: 1 };
    expect(await s.claim(c)).toBe(true);
    expect(await s.claim(c)).toBe(false);
    await s.release('d1');
    expect(await s.claim(c)).toBe(true);
  });
});
