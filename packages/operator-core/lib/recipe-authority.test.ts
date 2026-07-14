import { describe, expect, it } from 'vitest';
import {
  buildRecipeAuthorityRecommendation,
  deriveRecipeAuthority,
  recipeRevision,
  validateRecipeAuthorityProof,
} from './recipe-authority';

describe('recipe recommendation authority (P-008)', () => {
  const script = `
    await tools.plans.get({ slug: 'release-plan' });
    await tools.workItems.get({ id: 'WI-4655', harness: 'papercusp' });
    await tools.locks.acquireResource({ resource: 'windows-vm' });
  `;

  it('derives fleet/plan/harness/item/resource bindings and rejects mismatched recommendations', async () => {
    const descriptor = await deriveRecipeAuthority(script);
    expect(descriptor).toMatchObject({
      bound: true,
      unresolved: false,
      refs: {
        plans: ['release-plan'],
        harnesses: ['papercusp'],
        items: ['WI-4655'],
        resources: ['windows-vm'],
      },
    });

    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-07-13T12:00:00.000Z',
      context: { plan: 'another-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    })).resolves.toBeNull();

    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-07-13T12:00:00.000Z',
      context: { plan: 'release-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    })).resolves.toMatchObject({ proof: { version: 1 }, refs: { items: ['WI-4655'] } });
  });

  it('fails closed for opaque SQL and dynamic entity arguments', async () => {
    await expect(deriveRecipeAuthority(`await tools.dev.pg_query({ sql: 'SELECT 1' });`)).resolves.toMatchObject({
      unresolved: true,
    });
    await expect(deriveRecipeAuthority(`await tools.workItems.get({ id: runtimeId });`)).resolves.toMatchObject({
      unresolved: true,
    });
  });

  it('revalidates the stored revision and live entity identity at run time', async () => {
    const updatedAt = '2026-07-13T12:00:00.000Z';
    const proof = {
      version: 1 as const,
      revision: recipeRevision(script, updatedAt),
      context: { plan: 'release-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    };
    await expect(validateRecipeAuthorityProof({ script, updatedAt, proof, liveContext: { harness: 'papercusp' } }))
      .resolves.toMatchObject({ ok: true });
    await expect(validateRecipeAuthorityProof({ script: `${script}\n// changed`, updatedAt, proof }))
      .resolves.toEqual({ ok: false, error: 'authority_stale_revision' });
    await expect(validateRecipeAuthorityProof({ script, updatedAt, proof, liveContext: { harness: 'other' } }))
      .resolves.toEqual({ ok: false, error: 'authority_entity_mismatch' });
  });

  it('allows truly generic recipes without an authority proof', async () => {
    await expect(validateRecipeAuthorityProof({
      script: `return await tools.gateway.status({});`,
      updatedAt: '2026-07-13T12:00:00.000Z',
    })).resolves.toMatchObject({ ok: true, descriptor: { bound: false } });
  });
});
