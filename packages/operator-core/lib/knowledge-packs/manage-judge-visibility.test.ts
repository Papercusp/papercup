/**
 * Recurrence guard for EI-18746586784230719 (knowledge-packs half of the
 * memory-conflict-check correctness bug).
 *
 * `classifyPackInstall` / `sweepHiveConflicts` run the LLM conflict judge
 * UNCONDITIONALLY (unlike memory:remember, there is no feature flag gating
 * it here) — so `manage.ts`'s `realJudge()` calling `createAnthropicJudge()`
 * with no `ANTHROPIC_API_KEY` silently classifies every item 'clean' and
 * every sweep pair as none-found, with zero signal that the judge never ran.
 *
 * `realJudge()` must check `conflictJudgeAvailable()` and call
 * `warnKnowledgePackJudgeUnavailableOnce()` when no judge can be built. This
 * pins that wiring so a future refactor of `realJudge()` can't silently drop
 * it (the class of bug the underlying issue is about: an inert guard that
 * looks byte-identical to a healthy one).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const conflictJudgeAvailable = vi.fn<() => boolean>();
const warnKnowledgePackJudgeUnavailableOnce = vi.fn();
const createAnthropicJudge = vi.fn(() => async () => ({ conflicts: [] as never[] }));

// P-009: realJudge() now asks resolveConflictJudge(); route it through the
// anthropic-judge mocks below (the factory is pinned in conflict-judge.test.ts).
vi.mock('../memory/conflict-judge', () => ({
  resolveConflictJudge: async () =>
    conflictJudgeAvailable()
      ? { available: true, backend: 'anthropic', judge: createAnthropicJudge() }
      : { available: false, reason: 'test: no judge' },
}));
vi.mock('../memory/anthropic-judge', () => ({
  conflictJudgeAvailable: (...args: unknown[]) =>
    (conflictJudgeAvailable as unknown as (...a: unknown[]) => boolean)(...args),
  warnKnowledgePackJudgeUnavailableOnce: (...args: unknown[]) =>
    (warnKnowledgePackJudgeUnavailableOnce as unknown as (...a: unknown[]) => void)(...args),
  createAnthropicJudge: (...args: unknown[]) =>
    (createAnthropicJudge as unknown as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('../memory/backend', () => ({ getMemoryBackend: vi.fn() }));

import { getMemoryBackend } from '../memory/backend';
import { classifyPackInstall, sweepHiveConflicts } from './manage';
import type { KnowledgePack } from './pack-format';

const pack: KnowledgePack = {
  manifest: { id: 'p', title: 'P', description: 'd', version: '1.0.0' },
  items: [{ id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'always do a' }],
};

type Entry = { id: string; text: string; scope: string; score?: number; metadata?: Record<string, unknown> };

/** A near-but-not-duplicate neighbor (score below the 0.9 dupThreshold) — the
 *  shape that actually reaches the conflict judge instead of short-circuiting
 *  as a 'duplicate' classification. */
const fakeBackendWithNeighbor = (pool: Entry[] = []) => {
  const backend = {
    name: 'fake',
    available: vi.fn(async () => ({ ok: true as const })),
    search: vi.fn(async () => [{ id: 'n1', text: 'a related neighbour', scope: 'hive:h', score: 0.5 }]),
    list: vi.fn(async () => pool),
    forget: vi.fn(async () => {}),
    remember: vi.fn(async () => ({ ids: ['x'] })),
  };
  vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
  return backend;
};

beforeEach(() => {
  conflictJudgeAvailable.mockReset().mockReturnValue(false);
  warnKnowledgePackJudgeUnavailableOnce.mockReset();
  createAnthropicJudge.mockReset().mockReturnValue(async () => ({ conflicts: [] }));
});

describe('manage.ts realJudge() judge-availability visibility (no deps.judge override)', () => {
  it('classifyPackInstall warns once when no judge key resolves', async () => {
    fakeBackendWithNeighbor();
    await classifyPackInstall({ potSlug: 'h', pack });
    expect(warnKnowledgePackJudgeUnavailableOnce).toHaveBeenCalled();
  });

  it('classifyPackInstall does NOT warn when a judge key resolves', async () => {
    fakeBackendWithNeighbor();
    conflictJudgeAvailable.mockReturnValue(true);
    await classifyPackInstall({ potSlug: 'h', pack });
    expect(warnKnowledgePackJudgeUnavailableOnce).not.toHaveBeenCalled();
  });

  it('sweepHiveConflicts warns once when no judge key resolves', async () => {
    const backend = fakeBackendWithNeighbor([{ id: 'r1', text: 'row one', scope: 'hive:h' }]);
    backend.list = vi.fn(async () => [{ id: 'r1', text: 'row one', scope: 'hive:h' }]);
    await sweepHiveConflicts({ potSlug: 'h' });
    expect(warnKnowledgePackJudgeUnavailableOnce).toHaveBeenCalled();
  });

  it('sweepHiveConflicts does NOT warn when a judge key resolves', async () => {
    const backend = fakeBackendWithNeighbor([{ id: 'r1', text: 'row one', scope: 'hive:h' }]);
    backend.list = vi.fn(async () => [{ id: 'r1', text: 'row one', scope: 'hive:h' }]);
    conflictJudgeAvailable.mockReturnValue(true);
    await sweepHiveConflicts({ potSlug: 'h' });
    expect(warnKnowledgePackJudgeUnavailableOnce).not.toHaveBeenCalled();
  });

  it('an explicit deps.judge override bypasses realJudge() entirely — no warn either way', async () => {
    fakeBackendWithNeighbor();
    await classifyPackInstall({ potSlug: 'h', pack }, { judge: async () => ({ conflicts: [] }) });
    expect(conflictJudgeAvailable).not.toHaveBeenCalled();
    expect(warnKnowledgePackJudgeUnavailableOnce).not.toHaveBeenCalled();
  });
});
