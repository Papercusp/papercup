import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bindSelectedIdentityOutputs, getSelectedModeCatalog } from './source';

const scope = { workspace: 'ws-test', goal: 'goal-1', ownerId: 'su-goal-1' };
const observedAt = '2026-09-24T13:00:00.000Z';

describe('selected identity producer output binding', () => {
  it('pins an existing structured orient result with the fixed SU practice prompt', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'coord-orientation', value: { ok: true, self: { ownerId: 'su-1' } } }],
      scope: { workspace: 'ws-test', ownerId: 'su-1' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'coord-orientation', status: 'bound' }),
    ]);
  });

  it('binds the same source revision selected by the installed mode catalog', async () => {
    const catalog = await getSelectedModeCatalog();
    const goal = catalog.entries.find((entry) => entry.id === 'goal');
    expect(goal).toBeDefined();
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });
    expect(receipt.sourceRevision).toBe(goal!.sourceHash);
  });

  it('pins one already-produced kickoff and an explicit absent portfolio with the fixed GOAL definition', async () => {
    const kickoff = 'You are in GOAL mode on goal goal-1';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: kickoff },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });

    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
      expect.objectContaining({
        contributionId: 'goal-kickoff',
        status: 'bound',
        outputRevision: createHash('sha256').update(kickoff).digest('hex'),
      }),
      expect.objectContaining({
        contributionId: 'goal-portfolio', status: 'omitted:not-requested', outputRevision: null,
      }),
    ]);
  });

  it('refuses a provider failure without a traceable error reference', async () => {
    await expect(bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'unavailable' } },
      ],
      scope,
      observedAt,
    })).rejects.toThrow(/unavailable needs errorRef/);
  });
});
