import { describe, expect, it } from 'vitest';
import {
  buildRecipeAuthorityRecommendation,
  deriveRecipeAuthority,
  recipeRevision,
  recipeAuthorityMatchesLiveRefs,
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

    const descriptor = await deriveRecipeAuthority(script);
    expect(recipeAuthorityMatchesLiveRefs(descriptor, {
      plans: ['release-plan'],
      items: ['WI-4655'],
      resources: ['windows-vm'],
    })).toBe(true);
    expect(recipeAuthorityMatchesLiveRefs(descriptor, {
      plans: ['release-plan'],
      items: ['WI-4655'],
      resources: ['another-vm'],
    })).toBe(false);
  });

  it('does not accept a caller-carried fleet when no matching live fleet exists', async () => {
    const fleetScript = `return await tools.fleet.status({ fleet: 'release-fleet' });`;
    const updatedAt = '2026-07-13T12:00:00.000Z';
    const proof = {
      version: 1 as const,
      revision: recipeRevision(fleetScript, updatedAt),
      context: { fleet: 'release-fleet' },
    };
    await expect(validateRecipeAuthorityProof({ script: fleetScript, updatedAt, proof }))
      .resolves.toMatchObject({ ok: true });
    await expect(validateRecipeAuthorityProof({
      script: fleetScript,
      updatedAt,
      proof,
      liveContext: {},
    })).resolves.toEqual({ ok: false, error: 'authority_entity_mismatch' });
  });

  it('collects authority from heterogeneous items rows', async () => {
    const descriptor = await deriveRecipeAuthority(`
      return await tools.plans.setStatus({
        items: [{ slug: 'release-plan', itemId: 'P-008', harness: 'papercusp' }]
      });
    `);
    expect(descriptor.refs).toMatchObject({
      plans: ['release-plan'],
      items: ['P-008'],
      harnesses: ['papercusp'],
    });
  });

  it('captures a coord:orient planItems plan-lane claim as an item authority ref (EI-12213)', async () => {
    // A "monitor" recipe whose script claims a plan lane via coord:orient({ planSlug, planItems })
    // must record BOTH the plan AND the item so the recommendation filter requires the caller to
    // already hold that exact lane. Before this fix `planItems` was not in collectArgs' item-key
    // set, so only the plan ref was captured — and the recipe was recommended to any caller on the
    // plan (regardless of item), so running it re-declared their lane and claimed another agent's
    // item (the "surfaced a monitor recipe that would claim another plan lane" bug).
    const claimScript = `
      return await tools.coord.orient({
        intent: 'Monitor release readiness',
        mode: 'monitor',
        planSlug: 'blender-public-release-readiness-drive-2026-07-14',
        planItems: ['P-006'],
      });
    `;
    const descriptor = await deriveRecipeAuthority(claimScript);
    expect(descriptor.refs).toMatchObject({
      plans: ['blender-public-release-readiness-drive-2026-07-14'],
      items: ['P-006'],
    });

    // A caller ON the plan but NOT already holding P-006 must NOT get the recipe recommended —
    // the item-lane ref is now part of the authority contract, closing the lane-theft gap.
    await expect(buildRecipeAuthorityRecommendation({
      script: claimScript,
      updatedAt: '2026-07-14T12:00:00.000Z',
      context: { plan: 'blender-public-release-readiness-drive-2026-07-14', items: ['P-010'] },
    })).resolves.toBeNull();

    // A caller already declaring P-006 as their own lane may reuse it (re-declaring is a no-op).
    await expect(buildRecipeAuthorityRecommendation({
      script: claimScript,
      updatedAt: '2026-07-14T12:00:00.000Z',
      context: { plan: 'blender-public-release-readiness-drive-2026-07-14', items: ['P-006'] },
    })).resolves.toMatchObject({ proof: { version: 1 }, refs: { items: ['P-006'] } });
  });

  it('allows truly generic recipes without an authority proof', async () => {
    await expect(validateRecipeAuthorityProof({
      script: `return await tools.gateway.status({});`,
      updatedAt: '2026-07-13T12:00:00.000Z',
    })).resolves.toMatchObject({ ok: true, descriptor: { bound: false } });
  });

  // EI-12057: a recipe composing another recipe via `tools.recipes.run(...)` fails
  // with the SAME authority codes as a direct (non-nested) run of the inner recipe
  // — the failure is a property of the INNER script, not of nesting. Distinguishing
  // `reason` text lets a caller tell "permanent, run via code:run instead"
  // (authority_unresolved — opaque SQL/shell) apart from "get a proof first"
  // (authority_required — merely bound, not opaque).
  it('surfaces an actionable reason distinguishing permanent (opaque) from fixable (missing-proof) failures', async () => {
    const opaqueScript = `await tools.dev.pg_query({ sql: 'SELECT 1' });`;
    const opaqueResult = await validateRecipeAuthorityProof({
      script: opaqueScript,
      updatedAt: '2026-07-13T12:00:00.000Z',
    });
    expect(opaqueResult).toMatchObject({ ok: false, error: 'authority_unresolved' });
    if (!opaqueResult.ok) {
      expect(opaqueResult.reason).toMatch(/opaque\/unprovable/);
      expect(opaqueResult.reason).toMatch(/code:run/);
    }

    const boundScript = `await tools.workItems.get({ id: 'WI-4655', harness: 'papercusp' });`;
    const boundResult = await validateRecipeAuthorityProof({
      script: boundScript,
      updatedAt: '2026-07-13T12:00:00.000Z',
    });
    expect(boundResult).toMatchObject({ ok: false, error: 'authority_required' });
    if (!boundResult.ok) {
      expect(boundResult.reason).toMatch(/recipes:search/);
    }
  });

  // A recipe referencing a work-item is never dropped from bound refs by the
  // nesting-composition path — this pins the exact EI-12057 repro shape (a
  // work-item-bound script that ALSO calls the opaque dev:pg_query) to confirm
  // `unresolved` wins over `bound` (opaque always fails closed, regardless of
  // whether the script is otherwise entity-bound) and stays stable.
  it('EI-12057 repro shape: work-item-bound + opaque dev.pg_query stays permanently unresolved', async () => {
    const script = `
      await tools.work_items.get({ id: 'WI-4457', harness: 'papercusp', detail: true });
      await tools.dev.pg_query({ sql: 'SELECT 1', maxRows: 100 });
    `;
    const descriptor = await deriveRecipeAuthority(script);
    expect(descriptor.unresolved).toBe(true);
    expect(descriptor.bound).toBe(true);
    const result = await validateRecipeAuthorityProof({ script, updatedAt: '2026-07-13T12:00:00.000Z' });
    expect(result).toMatchObject({ ok: false, error: 'authority_unresolved' });
  });
});
