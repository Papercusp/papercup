import { describe, expect, it } from 'vitest';
import {
  buildRecipeAuthorityRecommendation,
  deriveRecipeAuthority,
  recipeRevision,
  recipeAuthorityMatches,
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

  it('fails closed for volatile coordination sender and cursor arguments', async () => {
    const coordinationScript = `return await tools.coord.inbox({
      from: 'su-stale-leader',
      since_ts: '2026-07-10T16:05:00.000Z',
    });`;
    await expect(deriveRecipeAuthority(coordinationScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-args',
        tool: 'coord.inbox',
        keys: ['from', 'since_ts'],
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: coordinationScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: coordinationScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('volatile coordination sender/cursor'),
    });
  });

  it('fails closed for caller-scoped loop checkpoint state', async () => {
    const checkpointScript = `return await tools.loop.checkpoint({
      did: 'historical fleet work',
      left: 'historical next step',
      insight: 'historical conclusion',
      next: 'historical wake action',
    });`;
    await expect(deriveRecipeAuthority(checkpointScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-session-state',
        tool: 'loop.checkpoint',
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: checkpointScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
      context: { fleet: 'current-fleet', harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: checkpointScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('caller-scoped session carry state'),
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
      .resolves.toMatchObject({ ok: false, error: 'authority_stale_revision' });
    await expect(validateRecipeAuthorityProof({ script, updatedAt, proof, liveContext: { harness: 'other' } }))
      .resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });

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
    })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
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

  it('captures positional work-item claim rows and rejects fixed assignees (EI-20238127178875631)', async () => {
    const rowScript = `return await tools.workItems.claim({ row: 'WI-38077,,papercusp' });`;
    const descriptor = await deriveRecipeAuthority(rowScript);
    expect(descriptor).toMatchObject({
      bound: true,
      unresolved: false,
      refs: { items: ['WI-38077'], harnesses: ['papercusp'] },
    });

    await expect(buildRecipeAuthorityRecommendation({
      script: rowScript,
      updatedAt: '2026-08-12T09:00:00.000Z',
      context: { harness: 'papercusp', items: ['WI-38078'] },
    })).resolves.toBeNull();

    const fixedAssigneeScript = `return await tools.workItems.claim({ row: 'WI-38077,su-497dd000-243c-41f3-8cd4-c44756c81694,papercusp' });`;
    await expect(deriveRecipeAuthority(fixedAssigneeScript)).resolves.toMatchObject({
      refs: { items: ['WI-38077'], harnesses: ['papercusp'] },
      unresolved: true,
      unresolvedCause: { kind: 'fixed-claim-assignee', tool: 'workItems.claim' },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: fixedAssigneeScript,
      updatedAt: '2026-08-12T09:00:00.000Z',
      context: { harness: 'papercusp', items: ['WI-38077'] },
    })).resolves.toBeNull();
  });

  it('allows truly generic recipes without an authority proof', async () => {
    await expect(validateRecipeAuthorityProof({
      script: `return await tools.gateway.status({});`,
      updatedAt: '2026-07-13T12:00:00.000Z',
    })).resolves.toMatchObject({ ok: true, descriptor: { bound: false } });
  });

  // EI-20186804943808838 / EI-12692: `http-projection` sets `ctx.harnessSlug = '*'` for EVERY
  // superuser/operator-scope call (the documented HARNESS_ALL sentinel — see
  // agent-tools/_harness-scope.ts). Both recipes:search and recipes:run thread that ctx value
  // straight into the authority context, where the scalar comparison was a strict `===`. So for
  // every su session — the population recipe reuse exists to serve — a recipe binding a concrete
  // harness was UNREACHABLE, in a way no caller could repair: search refused to issue a proof
  // (buildRecipeAuthorityRecommendation returned null) and run rejected on the LIVE context, which
  // is server-derived and therefore immune to any proof the caller supplies. Filed twice, a month
  // apart, against the same recipe.
  describe('operator-scope wildcard harness (EI-20186804943808838)', () => {
    const harnessScript = `return await tools.scheduler.getNext({ harness: 'papercusp' });`;
    const updatedAt = '2026-07-10T16:14:16.826Z';

    it('lets an operator-scope session run a harness-bound recipe end to end', async () => {
      // The exact broken flow: search issues the proof, run validates it against the live ctx.
      const recommendation = await buildRecipeAuthorityRecommendation({
        script: harnessScript,
        updatedAt,
        context: { workspace: 'papercusp-workspace', harness: '*' },
      });
      expect(recommendation).not.toBeNull();

      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: recommendation!.proof,
        liveContext: { workspace: 'papercusp-workspace', harness: '*' },
      })).resolves.toMatchObject({ ok: true });
    });

    it('accepts the friendly `all` spelling of the same sentinel', async () => {
      const recommendation = await buildRecipeAuthorityRecommendation({
        script: harnessScript,
        updatedAt,
        context: { harness: 'all' },
      });
      expect(recommendation).not.toBeNull();
    });

    // CONTROLS — the wildcard must not become a skeleton key. Each of these asserts the
    // widening stopped exactly where it was supposed to.
    it('still rejects a CALLER-CARRIED proof that claims wildcard scope', async () => {
      // The live context is server-derived and trustworthy; the proof is not. A caller who
      // hand-builds `harness:'*'` must not thereby authorize a concrete-harness recipe.
      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: { version: 1, revision: recipeRevision(harnessScript, updatedAt), context: { harness: '*' } },
        liveContext: { harness: 'papercusp' },
      })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
    });

    it('still rejects a live session scoped to a DIFFERENT concrete harness', async () => {
      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: { version: 1, revision: recipeRevision(harnessScript, updatedAt), context: { harness: 'papercusp' } },
        liveContext: { harness: 'some-other-harness' },
      })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
    });

    // CALIBRATION. The two controls above assert a REJECTION, and a rejection also happens
    // when nothing is wired up at all — so on their own they could pass vacuously. This pins
    // that the strict/loose distinction is real and load-bearing: the very same descriptor and
    // wildcard context that the strict comparison REJECTS is ACCEPTED once operator scope is
    // opted into. If a future edit passes `operatorScope: true` at the caller-carried proof
    // check, that is exactly the mutation this makes the controls above catch.
    it('separates strict from operator-scope matching (proves the controls are not vacuous)', async () => {
      const descriptor = await deriveRecipeAuthority(harnessScript);
      expect(recipeAuthorityMatches(descriptor, { harness: '*' })).toBe(false);
      expect(recipeAuthorityMatches(descriptor, { harness: '*' }, { operatorScope: true })).toBe(true);
      // ...and operator scope is not a blanket pass: a wrong concrete harness still fails.
      expect(recipeAuthorityMatches(descriptor, { harness: 'nope' }, { operatorScope: true })).toBe(false);
    });

    it('does NOT extend the wildcard to workspace — that is a tenant boundary', async () => {
      const wsScript = `return await tools.workItems.get({ id: 'WI-1', workspace: 'other-workspace' });`;
      const descriptor = await deriveRecipeAuthority(wsScript);
      expect(descriptor.refs.workspaces).toEqual(['other-workspace']);
      await expect(buildRecipeAuthorityRecommendation({
        script: wsScript,
        updatedAt,
        context: { workspace: '*' },
      })).resolves.toBeNull();
    });
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
