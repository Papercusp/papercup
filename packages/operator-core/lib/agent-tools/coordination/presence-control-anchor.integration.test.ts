import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, type PlanPgFixture } from '../plans/__tests__/_pg-tool-fixture';
import { checkPlanExecutionGuard, readExecutionPlanBindings } from '../plans/plan-execution-guard';
import * as briefs from '../../session-brief';
import { buildAndPersistControlAnchor } from './control-anchor';
import { writePresence } from './presence';

vi.mock('./machine-capability-tags', () => ({ getCachedMachineCapabilityTags: async () => ['node'] }));

const OWNER = 'su-presence-control-scope';
const HARNESS = 'presence-control-scope';
const identity = {
  ownerId: OWNER,
  ownerLabel: OWNER,
  workspaceId: 'default',
  userId: null,
  source: 'omp-hook-session' as const,
};
let fx: PlanPgFixture;
let previousFleet: string | undefined;
let previousRole: string | undefined;

beforeAll(async () => {
  previousFleet = process.env.PAPERCUSP_FLEET_SLUG;
  previousRole = process.env.PAPERCUSP_FLEET_ROLE;
  delete process.env.PAPERCUSP_FLEET_SLUG;
  delete process.env.PAPERCUSP_FLEET_ROLE;
  fx = await setupPlanPgFixture({ isolated: true });
  for (const slug of ['previous-draft', 'next-draft']) {
    const content = `---\ntitle: Scope regression\nstatus: draft\n---\n# Scope regression\n`;
    await fx.admin`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, status)
      VALUES (${identity.workspaceId}, ${HARNESS}, ${slug}, ${content}, md5(${content}), 'draft')`;
  }
}, 120_000);

afterAll(async () => {
  try { await fx?.dispose(); }
  finally {
    if (previousFleet === undefined) delete process.env.PAPERCUSP_FLEET_SLUG;
    else process.env.PAPERCUSP_FLEET_SLUG = previousFleet;
    if (previousRole === undefined) delete process.env.PAPERCUSP_FLEET_ROLE;
    else process.env.PAPERCUSP_FLEET_ROLE = previousRole;
  }
});

beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.plan_item_claims WHERE owner=${OWNER}`;
  await writePresence(identity, { intent: 'initial plan work', currentPlanSlug: 'previous-draft' }, HARNESS);
  // Seed the predecessor through the canonical projection, even before the
  // presence writer itself refreshes it. This makes the stale-anchor bug real.
  await buildAndPersistControlAnchor(OWNER, identity.workspaceId, { sql: fx.admin });
});

async function snapshot() {
  const rows = await fx.admin<Array<{
    current_plan_slug: string | null;
    control_generation: string;
    control_state: { scope: { plan: string | null; items: string[] } };
  }>>`
    SELECT current_plan_slug, control_generation::text, control_state
      FROM harness_shared.session_briefs WHERE owner_id=${OWNER}`;
  return rows[0]!;
}

const guard = () => checkPlanExecutionGuard({
  ownerId: OWNER, workspaceId: identity.workspaceId,
  toolName: 'locks:acquire', args: { paths: ['packages/operator-core/lib/example.ts'] },
});

describe('presence scope and the normal execution guard (EI-28597676601457969)', () => {
  it('clears an obsolete control-state plan when the durable declaration moves to ad-hoc work', async () => {
    expect(await guard()).toMatchObject({ planSlug: 'previous-draft', blockers: ['plan_status:draft'] });
    const before = await snapshot();

    await writePresence(identity, { intent: 'independent assigned bug' }, HARNESS);

    const after = await snapshot();
    expect(after.current_plan_slug).toBeNull();
    expect(after.control_state.scope).toMatchObject({ plan: null, items: [] });
    expect(Number(after.control_generation)).toBeGreaterThan(Number(before.control_generation));
    expect(await readExecutionPlanBindings(OWNER, identity.workspaceId)).toEqual([]);
    expect(await guard()).toBeNull();
  });

  it('replaces the obsolete plan without bypassing the new draft plan refusal', async () => {
    await writePresence(identity, { intent: 'different plan', currentPlanSlug: 'next-draft' }, HARNESS);

    expect((await snapshot()).control_state.scope.plan).toBe('next-draft');
    const bindings = await readExecutionPlanBindings(OWNER, identity.workspaceId);
    expect(bindings).toHaveLength(2);
    expect(bindings.every(binding => binding.planSlug === 'next-draft')).toBe(true);
    expect(await guard()).toMatchObject({ planSlug: 'next-draft', blockers: ['plan_status:draft'] });
  });

  it.each(['1 hour', '-1 hour'])('preserves a held plan claim with expiry offset %s', async offset => {
    await fx.admin`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES (${identity.workspaceId}, ${HARNESS}, 'previous-draft', 'P-001', ${OWNER},
        now() + ${offset}::interval)`;

    await writePresence(identity, { intent: 'ad-hoc prose cannot drop a held lane' }, HARNESS);

    expect((await snapshot()).control_state.scope).toMatchObject({ plan: 'previous-draft', items: ['P-001'] });
    expect(await guard()).toMatchObject({ planSlug: 'previous-draft', blockers: ['plan_status:draft'] });
    const claims = await fx.admin`SELECT item_id FROM harness_shared.plan_item_claims WHERE owner=${OWNER}`;
    expect(claims).toEqual([{ item_id: 'P-001' }]);
  });

  it('keeps the prior refusal when the refresh cannot read canonical scope', async () => {
    const before = await snapshot();
    const read = vi.spyOn(briefs, 'getSessionBrief').mockRejectedValueOnce(new Error('scope read unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writePresence(identity, { intent: 'brief changed but refresh unreadable' }, HARNESS);
      expect(read).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('control-anchor:refresh failed: scope read unavailable'));
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }

    const after = await snapshot();
    expect(after.current_plan_slug).toBeNull();
    expect(after.control_state).toEqual(before.control_state);
    expect(after.control_generation).toBe(before.control_generation);
    expect(await guard()).toMatchObject({ planSlug: 'previous-draft', blockers: ['plan_status:draft'] });
  });

  it('does not advance the control generation for an intent-only update in the same scope', async () => {
    const before = await snapshot();
    await writePresence(identity, { intent: 'new wording', currentPlanSlug: 'previous-draft' }, HARNESS);
    expect((await snapshot()).control_generation).toBe(before.control_generation);
  });
});
