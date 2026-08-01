/**
 * work_items:claim — planItemClaimCollision at CLAIM time
 * (P-007, fleet-leadership-continuity-and-actuation-2026-08-01).
 *
 * `work_items:get` has surfaced this divergence since agent-trap-guards-2026-07-26, but claim —
 * the call that actually STARTS the duplicated work — did not, so the drift was only discoverable
 * by an agent who happened to look before claiming. This pins the claim-side wiring; the detector
 * itself is unit-pinned in scheduler/plan-item-claim-collision.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// PARTIAL mock (importOriginal) — see claim.checkpoint-hint.test.ts's note on why a hand-listed
// factory silently rots the moment claim.ts imports one more member.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
}));
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

const getClaimTimePriorWorkHint = vi.fn();
vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClaimTimePriorWorkHint: (...a: unknown[]) => getClaimTimePriorWorkHint(...a),
}));

const planItemClaimCollision = vi.fn();
vi.mock('../../scheduler/plan-item-claim-collision', () => ({
  planItemClaimCollision: (...a: unknown[]) => planItemClaimCollision(...a),
}));

import { claimWorkItem, getWorkItem } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;
const one = async (args: unknown) => (await body(args)).results[0];

const COLLISION = {
  planSlug: 'a-plan',
  itemId: 'P-9',
  claimedBy: 'su-B',
  claimedByLabel: 'su · B',
  note: 'plan item a-plan#P-9 — which this work-item implements — is now held by a LIVE claim…',
};

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(
    async (id: string) => ({ id, harness: 'papercup', assignee: 'me' }) as never,
  );
  getWorkItemM.mockResolvedValue(null as never);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
  getClaimTimePriorWorkHint.mockResolvedValue(null);
  planItemClaimCollision.mockResolvedValue(null);
});

describe('work_items:claim — planItemClaimCollision (P-007)', () => {
  it('surfaces the collision when the linked plan lane is held by a DIFFERENT live agent', async () => {
    planItemClaimCollision.mockResolvedValue(COLLISION);
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true); // the claim still SUCCEEDS — this warns, it does not refuse
    expect(r.planItemClaimCollision).toMatchObject({
      planSlug: 'a-plan',
      itemId: 'P-9',
      claimedBy: 'su-B',
    });
  });

  it('omits the field entirely (not even null) when there is no divergence', async () => {
    planItemClaimCollision.mockResolvedValue(null);
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.planItemClaimCollision).toBeUndefined();
  });

  it('checks the POST-claim row, so the detector can compare against the new assignee', async () => {
    await one({ id: 'F-100' });
    expect(planItemClaimCollision).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'F-100', assignee: 'me' }),
    );
  });

  it('fails OPEN — a claims-store error must never fail the claim itself', async () => {
    planItemClaimCollision.mockRejectedValue(new Error('plan_item_claims pg down'));
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.planItemClaimCollision).toBeUndefined();
  });

  it('is surfaced ALONGSIDE a checkpoint hint, not swallowed by it (the other return branch)', async () => {
    // claim.ts has two success shapes — with and without a checkpoint hint. A field added to
    // only one of them is invisible on the other; this pins the branch the first three miss.
    getClaimTimeCheckpointHint.mockResolvedValue({
      checkpoint: 'prior in-flight state',
      checkpointAgeMs: 1_000,
    });
    planItemClaimCollision.mockResolvedValue(COLLISION);
    const r = await one({ id: 'F-100' });
    expect(r.checkpoint).toBe('prior in-flight state');
    expect(r.planItemClaimCollision).toMatchObject({ itemId: 'P-9' });
  });
});
