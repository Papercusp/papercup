/**
 * P-009 acceptance "context-critical claim", asserted AT THE CALL SITE.
 *
 * `fleet/context-critical-bench.test.ts` proves the auto-bench itself: it parks on the member's own
 * compaction event, never supersedes a leader's staged assignment, and never throws no matter which
 * dependency fails. None of that proves `scheduler:get_next` CALLS it — and a decision helper that
 * is never invoked is observationally identical to one that does not exist, because the refusal it
 * rides on ships unchanged either way and the helper is fail-soft by design. That is precisely the
 * shape the P-009 acceptance forbids: a member refused for critical context, told to compact, and
 * left to re-pull into the same refusal with nothing observing whether it ever came back.
 *
 * So this file asserts the WIRING: the refusal path registers the bench for the refused caller with
 * that caller's bucket, and the bench outcome rides back on the refusal so the park is visible.
 * The CONTROL below is what makes those assertions mean something — a served pull must arm nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'su-critical-caller';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(),
  fetchContextPressure: vi.fn(),
  autoBenchContextCriticalCaller: vi.fn(),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: mocks.getFlag,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));

vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNextForBee: mocks.getNextForBee,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(async () => true),
}));

// The seam under test. Mocked so the CALL is observable; its own behaviour is covered by
// fleet/context-critical-bench.test.ts and is deliberately not re-asserted here.
vi.mock('../../fleet/context-critical-bench', () => ({
  autoBenchContextCriticalCaller: mocks.autoBenchContextCriticalCaller,
}));

vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: mocks.fetchContextPressure,
}));

// Everything below is preflight/enrichment scenery: pinned so a cold module cache or a saturated
// database cannot consume the test budget before the assertion runs (EI-20308567859934395).
vi.mock('../locks/live-lock-paths', () => ({
  liveLockedPaths: vi.fn(async () => []),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: false, reason: null })),
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  diagnoseFleetScopeIssueFloorMiss: vi.fn(async () => null),
  diagnoseFleetScopeFeatureFamilyMatch: vi.fn(async () => null),
  diagnoseFleetScopeTerminalExhaustion: vi.fn(async () => null),
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  fleetScopedMiss: vi.fn(() => ({ ok: false, error: 'scoped miss', windDown: true })),
}));
vi.mock('../../events/await/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelClaimableAwaits: vi.fn(async () => 0),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => undefined),
}));
vi.mock('../../memory/claim-port', () => ({
  buildClaimRecallBlock: vi.fn(async () => null),
}));
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: vi.fn(async () => null),
}));
vi.mock('../../work-item-prior-work', () => ({
  getClaimTimePriorWorkHint: vi.fn(async () => null),
  priorWorkWarning: vi.fn(() => null),
}));
vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(() => null),
}));
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: vi.fn(async () => null),
}));
vi.mock('../../premises-claim-port', () => ({
  getClaimTimePremises: vi.fn(async () => null),
}));
vi.mock('../work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: vi.fn(async () => null),
}));

import getNextTool from './get_next';
import { CONTEXT_CRITICAL_REFUSAL_CODE } from '../../scheduler/context-pressure-claim-gate';

type ToolDef = {
  handler: (
    args: unknown,
    ctx?: unknown,
  ) => Promise<{ content?: Array<{ text: string }>; data?: Record<string, unknown> }>;
};

const callGetNext = (args: Record<string, unknown> = {}) =>
  (getNextTool as unknown as ToolDef).handler({ harness: 'papercusp', ...args }, {});

function refusalPayload(out: { content?: Array<{ text: string }> }): Record<string, unknown> {
  expect(out.content?.[0]?.text).toBeDefined();
  return JSON.parse(out.content![0].text) as Record<string, unknown>;
}

describe('scheduler:get_next — P-009 auto-bench on the context-critical refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: OWNER, workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockResolvedValue(null);
    mocks.fetchContextPressure.mockResolvedValue(new Map([[OWNER, 'critical']]));
    mocks.autoBenchContextCriticalCaller.mockResolvedValue({
      benched: true,
      benchId: 42,
      registered: true,
      wakeEvent: `session:compacted:${OWNER}`,
    });
  });

  it('benches the refused caller — the refusal alone leaves it re-pulling into the same wall', async () => {
    const out = await callGetNext();
    const payload = refusalPayload(out);

    expect(payload).toMatchObject({ ok: false, code: CONTEXT_CRITICAL_REFUSAL_CODE });
    expect(mocks.autoBenchContextCriticalCaller).toHaveBeenCalledTimes(1);

    // The bench must be about the caller that was actually refused, with the bucket that refused
    // it — not a fleet-wide or default park.
    const [subject] = mocks.autoBenchContextCriticalCaller.mock.calls[0];
    expect(subject).toMatchObject({ ownerId: OWNER, bucket: 'critical' });
  });

  it('carries the bench outcome back on the refusal, so the park is visible rather than implied', async () => {
    const payload = refusalPayload(await callGetNext());

    expect(payload.bench).toMatchObject({ benched: true, registered: true, wakeEvent: `session:compacted:${OWNER}` });
  });

  it('ships the refusal UNCHANGED when the bench declines to register', async () => {
    // The refusal is the load-bearing behaviour. A bench that could not arm must degrade to a
    // plain compact-first verdict, never to an error or a withheld response.
    mocks.autoBenchContextCriticalCaller.mockResolvedValue(null);

    const payload = refusalPayload(await callGetNext());

    expect(payload).toMatchObject({ ok: false, code: CONTEXT_CRITICAL_REFUSAL_CODE });
    expect(payload.bench).toBeUndefined();
  });

  it('CONTROL: a caller whose bucket is not critical is served and benched NOT AT ALL', async () => {
    // Without this the assertions above would pass equally against a version that benched every
    // caller on every pull — which is the false drain the context gate exists to prevent.
    mocks.fetchContextPressure.mockResolvedValue(new Map([[OWNER, 'high']]));

    await callGetNext();

    expect(mocks.autoBenchContextCriticalCaller).not.toHaveBeenCalled();
  });

  it('CONTROL: an UNKNOWN bucket serves and benches nothing — a stale reading must not park a member', async () => {
    mocks.fetchContextPressure.mockResolvedValue(new Map());

    await callGetNext();

    expect(mocks.autoBenchContextCriticalCaller).not.toHaveBeenCalled();
  });
});
