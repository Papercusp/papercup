import { describe, it, expect } from 'vitest';
import { promoteChampion, type PromotionDeps } from '../promotion';

/**
 * Immediate promotion (P-020, D-012): write the champion's overlay into the
 * DEDICATED gym harness's promptOverrides — and clear any role the prior champion
 * set that the new one doesn't, so the harness's overrides become EXACTLY the
 * champion's overlay. Never the shared default prompt files. Effects injected.
 */
function deps(existing: string[]): { d: PromotionDeps; set: string[]; cleared: string[] } {
  const set: string[] = [];
  const cleared: string[] = [];
  const d: PromotionDeps = {
    async listExistingOverrideRoles() { return existing; },
    async setOverride(_slug, role) { set.push(role); },
    async clearOverride(_slug, role) { cleared.push(role); },
  };
  return { d, set, cleared };
}

describe('promoteChampion', () => {
  it('sets every role in the overlay', async () => {
    const { d, set } = deps([]);
    const res = await promoteChampion('gym-h', { promptOverrides: { worker: 'w', validator: 'v' } }, d);
    expect(set.sort()).toEqual(['validator', 'worker']);
    expect(res.rolesSet).toEqual(['validator', 'worker']);
  });

  it('clears roles the prior champion set that the new overlay omits', async () => {
    const { d, cleared } = deps(['worker', 'reviewer']); // reviewer no longer overridden
    const res = await promoteChampion('gym-h', { promptOverrides: { worker: 'w2' } }, d);
    expect(cleared).toEqual(['reviewer']);
    expect(res.rolesCleared).toEqual(['reviewer']);
  });

  it('promoting the baseline (empty overlay) clears all prior overrides', async () => {
    const { d, set, cleared } = deps(['worker', 'validator']);
    await promoteChampion('gym-h', { promptOverrides: {} }, d);
    expect(set).toEqual([]);
    expect(cleared.sort()).toEqual(['validator', 'worker']);
  });
});
