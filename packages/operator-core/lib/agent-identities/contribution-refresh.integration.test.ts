import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { replayAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { bindSelectedIdentityOutputArtifact, bindSelectedIdentityOutputs } from './source';
import { bindTurnStartIdentityOutputs, type OrientationState } from '../turn-start-orientation';

describe('portable contribution refresh at the selected-identity boundary', () => {
  it.each([
    ['turn', 'turn-start'], ['launch', 'launch'], ['on-demand', 'on-demand'],
  ] as const)('enforces %s cadence through its real %s sink', async (refresh, sink) => {
    const root = mkdtempSync(join(tmpdir(), 'identity-refresh-'));
    const dir = join(root, '.papercusp', 'blueprints', 'refresh-fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blueprint.yaml'), stringify({
      id: 'refresh-fixture', extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
      contributions: [{ id: 'current-context', purpose: 'prompt', source: 'provider', refresh,
        inputKind: 'prompt-file', ref: 'provider:fixture', producerRef: 'papercusp.turn-start-orientation@1', verb: 'render',
        availability: 'optional' }],
    }));
    const input = { identityId: 'refresh-fixture', repoDir: root,
      scope: { workspace: 'refresh-workspace', harness: 'fixture', sink },
      observedAt: '2026-09-26T19:00:00.000Z' };
    try {
      const bound = await bindSelectedIdentityOutputArtifact({ ...input,
        outputs: [{ contributionId: 'current-context', value: 'Current context' }],
      });
      expect(bound.contributions[0]?.status).toBe('bound');
      expect(replayAgentSpecification(bound.artifact).specificationRevision).toBe(bound.specificationRevision);
      await expect(bindSelectedIdentityOutputs({ ...input,
        outputs: [{ contributionId: 'current-context', omission: { reason: 'not-requested' } }],
      })).rejects.toThrow(/contribution-not-delivered.*refresh/);
      for (const omission of [{ reason: 'ineligible' },
        { reason: 'unavailable', errorRef: 'fixture:provider-failed' }] as const) {
        const omitted = await bindSelectedIdentityOutputs({ ...input,
          outputs: [{ contributionId: 'current-context', omission }],
        });
        expect(omitted.contributions[0]?.status).toBe('omitted:' + omission.reason);
      }
      const offCadence = await bindSelectedIdentityOutputs({ ...input,
        scope: { ...input.scope, sink: sink === 'turn-start' ? 'launch' : 'turn-start' },
        outputs: [{ contributionId: 'current-context', omission: { reason: 'not-requested' } }],
      });
      expect(offCadence.contributions[0]?.status).toBe('omitted:not-requested');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps launch-only GOAL context off the turn sink and records no eligible obligations', async () => {
    const receipt = await bindTurnStartIdentityOutputs({
      ownerId: 'su-refresh', workspaceId: 'refresh-workspace',
      state: { modes: [{ mode: 'goal' }], obligations: null } as OrientationState,
      committed: null, epoch: 1, contextTokens: null,
      block: 'Current turn', deliveryToken: 'refresh-token',
    }, (input) => bindSelectedIdentityOutputs({ ...input, sourceTier: 'builtin' }),
    async (ownerId) => ({ ownerId, workspaceId: 'refresh-workspace', intent: 'refresh fixture',
      currentPlanSlug: null, stale: false }));
    expect(receipt.root).toMatchObject({ contributions: expect.arrayContaining([
      expect.objectContaining({ contributionId: 'turn-start-orientation', status: 'bound' }),
    ]) });
    expect(receipt.goal).toMatchObject({ contributions: expect.arrayContaining([
      expect.objectContaining({ contributionId: 'goal-portfolio', status: 'omitted:not-requested' }),
      expect.objectContaining({ contributionId: 'goal-obligations', status: 'omitted:ineligible' }),
    ]) });
    expect(receipt.token).toBe('refresh-token');
  });
});
