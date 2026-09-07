/**
 * work_items:claim — plan-Decisions brief at CLAIM time (EI-19387745408924340).
 *
 * `plan-decisions-claim-port.ts` (agent-trap-guards-2026-07-26 P-003b) was wired at
 * scheduler:get_next ONLY, despite its own docstring claiming all three claim surfaces —
 * so a BY-ID claim of a plan-bound item never saw its plan's governing decisions. This
 * pins the fix at THIS surface; the port itself is unit-pinned in
 * plan-decisions-claim-port.test.ts, and the sibling wiring at work_items:claim_next is
 * pinned in claim_next.plan-decisions.test.ts.
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

const getClaimTimePlanDecisions = vi.fn();
const renderPlanDecisionsNote = vi.fn();
vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: (...a: unknown[]) => getClaimTimePlanDecisions(...a),
  renderPlanDecisionsNote: (...a: unknown[]) => renderPlanDecisionsNote(...a),
}));
const getClaimTimePriorAttemptBrief = vi.fn();
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: (...a: unknown[]) => getClaimTimePriorAttemptBrief(...a),
}));

import { claimWorkItem, getWorkItem } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;
const one = async (args: unknown) => (await body(args)).results[0];

const BRIEF = {
  planSlug: 'target-plan',
  decisions: [{
    id: 'D-009',
    title: 'Inbound authority',
    snippet: 'body excerpt',
    sourcePlanSlug: 'source-plan',
    ref: 'source-plan#D-009',
    relation: 'affects',
  }],
  totalDecisions: 1,
  totalLocalDecisions: 0,
  totalAffectedDecisions: 1,
  affectedDecisions: 1,
  authorityReadFailed: false,
};
const AFFECTS_WARNING = '⚠ CROSS-PLAN AUTHORITY CONFLICT/SUPERSESSION WARNING: source-plan#D-009';

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(
    async (id: string) =>
      ({ id, harness: 'papercup', assignee: 'me', payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } } }) as never,
  );
  getWorkItemM.mockResolvedValue(null);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
  getClaimTimePriorWorkHint.mockResolvedValue(null);
  planItemClaimCollision.mockResolvedValue(null);
  getClaimTimePlanDecisions.mockResolvedValue(null);
  renderPlanDecisionsNote.mockReturnValue(AFFECTS_WARNING);
  getClaimTimePriorAttemptBrief.mockResolvedValue(null);
});

describe('work_items:claim — prior-attempt brief (P-010)', () => {
  it('surfaces the shared bounded brief without changing claim success', async () => {
    const brief = { schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'fp', omission: { omittedRecords: 0 } };
    getClaimTimePriorAttemptBrief.mockResolvedValue(brief);
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.priorAttemptBrief).toEqual(brief);
    expect(getClaimTimePriorAttemptBrief).toHaveBeenCalledWith(expect.objectContaining({ workItem: expect.objectContaining({ id: 'F-100' }) }));
  });
});

describe('work_items:claim — plan-Decisions brief (EI-19387745408924340)', () => {
  it('surfaces planDecisions + planDecisionsNote when the plan has governing decisions', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toEqual(BRIEF.decisions);
    expect(r.planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(renderPlanDecisionsNote).toHaveBeenCalledWith(BRIEF);
  });

  it('passes the POST-claim item and harness/workspace context to the port', async () => {
    await one({ id: 'F-100', harness: 'papercup' });
    expect(getClaimTimePlanDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: { payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } } },
        harness: 'papercup',
        workspaceId: 'ws-1',
      }),
    );
  });

  it('omits the field entirely (not even null) when the plan has no decisions', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(null);
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toBeUndefined();
    expect(r.planDecisionsNote).toBeUndefined();
  });

  it('fails soft — a port error must never fail the claim itself', async () => {
    getClaimTimePlanDecisions.mockRejectedValue(new Error('pg hiccup'));
    const r = await one({ id: 'F-100' });
    expect(r.ok).toBe(true);
    expect(r.planDecisions).toBeUndefined();
  });

  it('is surfaced ALONGSIDE a checkpoint hint, not swallowed by it (the other return branch)', async () => {
    // claim.ts has two success shapes — with and without a checkpoint hint. A field added
    // to only one of them is invisible on the other; this pins the branch the tests above miss.
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'prior in-flight state', checkpointAgeMs: 1_000 });
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    const r = await one({ id: 'F-100' });
    expect(r.checkpoint).toBe('prior in-flight state');
    expect(r.planDecisions).toEqual(BRIEF.decisions);
    expect(r.planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(Object.keys(r).indexOf('planDecisionsNote')).toBeLessThan(Object.keys(r).indexOf('checkpoint'));
  });
});
