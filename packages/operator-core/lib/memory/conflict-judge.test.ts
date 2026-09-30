import { describe, expect, it, vi } from 'vitest';

import { CONFLICT_JUDGE_UNAVAILABLE_REASON, resolveConflictJudge, type ConflictJudgeDeps } from './conflict-judge';

function deps(over: Partial<ConflictJudgeDeps>) {
  const jev = vi.fn(async () => ({ conflicts: [{ memory_id: 'j', summary: 'jev' }] }));
  const anthropic = vi.fn(async () => ({ conflicts: [{ memory_id: 'a', summary: 'anthropic' }] }));
  const d: ConflictJudgeDeps = {
    readJevKey: async () => null,
    anthropicAvailable: () => false,
    jevJudge: () => jev,
    anthropicJudge: () => anthropic,
    ...over,
  };
  return { d, jev, anthropic };
}

describe('resolveConflictJudge (P-009, D-016)', () => {
  it('prefers Jev when a Jev key is stored, even when Anthropic is also available', async () => {
    const { d } = deps({ readJevKey: async () => 'ts-key-123', anthropicAvailable: () => true });
    const r = await resolveConflictJudge(d);
    expect(r).toMatchObject({ available: true, backend: 'jev' });
    if (!r.available) throw new Error('expected a judge');
    expect(await r.judge({ newText: 'x', neighbors: [] })).toEqual({ conflicts: [{ memory_id: 'j', summary: 'jev' }] });
  });

  it('falls back to Anthropic when no Jev key is stored', async () => {
    const { d } = deps({ anthropicAvailable: () => true });
    expect(await resolveConflictJudge(d)).toMatchObject({ available: true, backend: 'anthropic' });
  });

  it('REPORTS unavailability instead of handing back a silent no-op judge', async () => {
    const { d } = deps({});
    expect(await resolveConflictJudge(d)).toEqual({ available: false, reason: CONFLICT_JUDGE_UNAVAILABLE_REASON });
  });

  it('treats an unreadable key store as no Jev key, not as an error', async () => {
    const { d } = deps({ readJevKey: async () => Promise.reject(new Error('pg down')), anthropicAvailable: () => true });
    expect(await resolveConflictJudge(d)).toMatchObject({ available: true, backend: 'anthropic' });
  });
});
