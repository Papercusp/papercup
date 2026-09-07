/**
 * work_items:claim_next — plan-Decisions brief at CLAIM time (EI-19387745408924340).
 *
 * `plan-decisions-claim-port.ts` (agent-trap-guards-2026-07-26 P-003b) was wired at
 * scheduler:get_next ONLY, despite its own docstring claiming all three claim surfaces —
 * so this self-select compatibility wrapper never saw its claimed item's governing plan
 * decisions either. This pins the fix at THIS surface (both the count===1 single-claim
 * shape and the count>1 batch shape); the port itself is unit-pinned in
 * plan-decisions-claim-port.test.ts, and the sibling wiring at work_items:claim is pinned
 * in claim.plan-decisions.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'su-me', workspaceId: 'ws-1' }));
const flag = vi.hoisted(() => ({ schedulerSpecClaim: true }));
const fleet = vi.hoisted(() => ({ scope: null as any, quarantinedIds: [] as string[], windingDown: false, pauseReason: null as string | null }));
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('../../events/await/store', () => ({
  cancelClaimableAwaits: cancelClaimableAwaitsM,
}));

vi.mock('@papercusp/flags', () => ({
  FLAGS: { SCHEDULER_SPEC_CLAIM: 'scheduler.spec.claim' },
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => flag.schedulerSpecClaim),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => identity,
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));

vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(),
}));

vi.mock('../../work-item-redundancy', () => ({
  workItemRedundancyEnabled: vi.fn(() => false),
}));

vi.mock('../../fleet/swarm-identity', () => ({
  localSwarmId: vi.fn(() => 'swarm-1'),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-1'),
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn((ws: string | null | undefined) => ws ?? undefined),
}));

vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: fleet.scope, quarantinedIds: fleet.quarantinedIds })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: fleet.windingDown, reason: fleet.pauseReason })),
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  fleetScopedMiss: vi.fn(() => ({ ok: false, error: 'scoped miss', windDown: true })),
}));

// `claim_next` reaches this pure predicate transitively through the claim-time
// retraction advisory. Preserve the real implementation so the focused handler
// test stays hermetic without making the production path fail at module link.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  CLAIM_STATES_ALLOWLIST: ['open', 'failing'],
  claimNextWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  diagnoseClaimNextMiss: vi.fn(),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

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

import { getNextForBee } from '../../scheduler/claim-spec-store';
import { claimNextWorkItem } from '../../work-items';

const getNextForBeeM = vi.mocked(getNextForBee);
const claimNextM = vi.mocked(claimNextWorkItem);
const tool = (await import('./claim_next')).default;

async function body(args: unknown) {
  const out = (await tool.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text);
}

const BRIEF = {
  planSlug: 'target-plan',
  decisions: [{
    id: 'D-009', title: 'Inbound authority', snippet: 'body excerpt',
    sourcePlanSlug: 'source-plan', ref: 'source-plan#D-009', relation: 'affects',
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
  identity.ownerId = 'su-me';
  identity.workspaceId = 'ws-1';
  flag.schedulerSpecClaim = true;
  fleet.scope = null;
  fleet.quarantinedIds = [];
  fleet.windingDown = false;
  fleet.pauseReason = null;
  getNextForBeeM.mockResolvedValue({
    workItem: { id: 'WI-lane', assignee: 'su-me', payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } } } as never,
    claimedUnder: { specId: 'fleet-bugs', revision: 3 },
    specSource: 'fleet',
  });
  claimNextM.mockResolvedValue({ id: 'WI-raw', assignee: 'su-me' } as never);
  getClaimTimePlanDecisions.mockResolvedValue(null);
  renderPlanDecisionsNote.mockReturnValue(AFFECTS_WARNING);
  getClaimTimePriorAttemptBrief.mockResolvedValue(null);
});

describe('work_items:claim_next — plan-Decisions brief (EI-19387745408924340)', () => {
  it('single-claim: surfaces the shared bounded prior-attempt brief', async () => {
    const brief = { schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'fp' };
    getClaimTimePriorAttemptBrief.mockResolvedValue(brief);
    const b = await body({ harness: 'papercusp' });
    expect(b.ok).toBe(true);
    expect(b.priorAttemptBrief).toEqual(brief);
  });
  it('single-claim (count omitted): surfaces planDecisions + planDecisionsNote', async () => {
    getClaimTimePlanDecisions.mockResolvedValue(BRIEF);
    const b = await body({ harness: 'papercusp' });
    expect(b.ok).toBe(true);
    expect(b.planDecisions).toEqual(BRIEF.decisions);
    expect(b.planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(getClaimTimePlanDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: { payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } } },
        workspaceId: 'ws-1',
      }),
    );
  });

  it('single-claim: omits the field entirely when the plan has no decisions', async () => {
    const b = await body({ harness: 'papercusp' });
    expect(b.ok).toBe(true);
    expect(b.planDecisions).toBeUndefined();
    expect(b.planDecisionsNote).toBeUndefined();
  });

  it('single-claim: fails soft — a port error must never fail the claim itself', async () => {
    getClaimTimePlanDecisions.mockRejectedValue(new Error('pg hiccup'));
    const b = await body({ harness: 'papercusp' });
    expect(b.ok).toBe(true);
    expect(b.planDecisions).toBeUndefined();
  });

  it('batch claim (count>1): attaches planDecisions PER claimed item', async () => {
    getNextForBeeM
      .mockResolvedValueOnce({
        workItem: { id: 'WI-1', assignee: 'su-me', payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } } } as never,
        claimedUnder: { specId: 'fleet-bugs', revision: 3 },
        specSource: 'fleet',
      })
      .mockResolvedValueOnce({
        workItem: { id: 'WI-2', assignee: 'su-me', payload: {} } as never,
        claimedUnder: { specId: 'fleet-bugs', revision: 3 },
        specSource: 'fleet',
      })
      .mockResolvedValueOnce(null);
    getClaimTimePlanDecisions.mockResolvedValueOnce(BRIEF).mockResolvedValueOnce(null);
    getClaimTimePriorAttemptBrief
      .mockResolvedValueOnce({ schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'one' })
      .mockResolvedValueOnce(null);

    const b = await body({ harness: 'papercusp', count: 3 });
    expect(b.ok).toBe(true);
    expect(b.claimed).toHaveLength(2);
    expect(b.claimed[0].workItem.id).toBe('WI-1');
    expect(b.claimed[0].planDecisions).toEqual(BRIEF.decisions);
    expect(b.claimed[0].planDecisionsNote).toBe(AFFECTS_WARNING);
    expect(b.claimed[0].priorAttemptBrief.fingerprint).toBe('one');
    expect(b.claimed[1].workItem.id).toBe('WI-2');
    expect(b.claimed[1].planDecisions).toBeUndefined();
    expect(b.claimed[1].priorAttemptBrief).toBeUndefined();
  });
});
