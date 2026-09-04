/**
 * WI-1912: the `states` arg on the pull tools (scheduler:get_next /
 * work_items:claim_next) must not widen past the resolver-owned floors.
 *
 * A backlog-clearance fleet member passed states:['todo','open','blocked'] and
 * get_next surfaced WI-1591 — a `blocked`, leader-triage-only item — into their
 * pull loop. The claim-spec validator rejects a `blocked` filter TERM precisely
 * so a spec can never un-floor itself (D-002), but the sibling free-string
 * `states` arg re-opened the identical hole at the tool boundary. These tests
 * pin the clamp: `states` accepts only CLAIM_STATES_ALLOWLIST members.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

const scopeState = vi.hoisted(() => ({ scope: null as any, quarantinedIds: [] as string[], windingDown: false, pauseReason: null as string | null }));
const getNextM = vi.hoisted(() => vi.fn());
type TestClaimSpecRecord = {
  source: 'default' | 'cup';
  spec: { specId: string; revision: number };
  revision: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
};
const getClaimSpecRecordM = vi.hoisted(() => vi.fn(async (): Promise<TestClaimSpecRecord> => ({
  source: 'default',
  spec: { specId: 'default', revision: 0 },
  revision: null,
  updatedBy: null,
  updatedAt: null,
})));
const getSessionBriefM = vi.hoisted(() => vi.fn(async () => null as {
  workspaceId?: string | null;
  harnessSlug?: string | null;
} | null));
const getActiveClaimForOwnerM = vi.hoisted(() => vi.fn(async () => null));
// EI-16057: registry contents the harness-existence gate checks against — 'papercusp'
// is the only registered slug by default so every pre-existing test (which all pass
// `harness: 'papercusp'`) keeps resolving; the dedicated describe block below swaps
// this to exercise the harness_not_found path.
const registryState = vi.hoisted(() => ({ projects: [{ slug: 'papercusp' }] as Array<{ slug: string }> }));
const loadHarnessRegistryM = vi.hoisted(() => vi.fn(async () => ({ projects: registryState.projects })));
// EI-15777: the paused-miss branch cancels the caller's own standing
// `work-item:claimable` await(s) — mock the store call so these unit tests never
// touch real PG, and so tests below can assert it was invoked (self-scoped, by ownerId).
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));
const liveLockedPathsM = vi.hoisted(() => vi.fn(async () => [] as string[]));
const getFlagM = vi.hoisted(() => vi.fn(async () => true));
const reconcileFleetScopeClaimsM = vi.hoisted(() => vi.fn());
const readFleetPauseStateM = vi.hoisted(() => vi.fn());
const diagnoseFleetScopeIssueFloorMissM = vi.hoisted(() => vi.fn(async () => null));
const diagnoseFleetScopeLeaderLivenessM = vi.hoisted(() => vi.fn(async () => null as boolean | null));
const workItemClaimLeaseEnabledM = vi.hoisted(() => vi.fn(() => false));
const leaseClaimedWorkItemM = vi.hoisted(() => vi.fn(async () => true));
const releaseWorkItemM = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
vi.mock('../../session-brief', () => ({
  getSessionBrief: getSessionBriefM,
}));
vi.mock('../../work-item-claims', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveClaimForOwner: getActiveClaimForOwnerM,
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryM,
}));
vi.mock('../../events/await/store', () => ({
  cancelClaimableAwaits: cancelClaimableAwaitsM,
}));
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: workItemClaimLeaseEnabledM,
  leaseClaimedWorkItem: leaseClaimedWorkItemM,
}));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  releaseWorkItem: releaseWorkItemM,
}));
vi.mock('../locks/live-lock-paths', () => ({
  liveLockedPaths: liveLockedPathsM,
}));
// EI-20099413453852234: a successful claim now declares the caller's intent, which is a
// presence WRITE — mocked here for the same reason as cancelClaimableAwaits above, so these
// unit tests never touch real PG, and so the block below can assert exactly what was written.
const getPresenceM = vi.hoisted(() => vi.fn(async (_ownerId?: string) => null as unknown));
// The parameters are DECLARED even though the body ignores them: a bare `vi.fn(async () => {})`
// types `mock.calls` as the empty tuple `[]`, so asserting on `calls[0][1]` (the PresenceInput
// this test exists to inspect) is TS2493 — caught by lint:tsc, never by vitest.
const writePresenceM = vi.hoisted(() =>
  vi.fn(async (_identity?: unknown, _input?: Record<string, unknown>, _harness?: unknown) => {}),
);
// EI-21834503221873518: the post-claim enrichment regression deliberately hangs this
// dynamically imported recall seam. Keep the rest of the suite off real memory/PG I/O
// and make the fake-timer test exercise the production timeout boundary directly.
const buildClaimRecallBlockM = vi.hoisted(() => vi.fn(async () => null as string | null));
const planTerminalityInWorkspaceM = vi.hoisted(() =>
  vi.fn(async () => null as { status: string | null; hasOpenItems: boolean } | null),
);
const planHarnessesForSlugsM = vi.hoisted(() => vi.fn(async () => new Map<string, string[]>()));
// PARTIAL mock, deliberately: this module also exports PRESENCE_STALE_MS, which
// presence-wakeability.ts -> fleet-roster.ts imports transitively. A whole-module factory
// drops it and the mock fails at import time rather than in a test.
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: getPresenceM,
  writePresence: writePresenceM,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: getFlagM,
}));
vi.mock('../../memory/claim-port', () => ({
  buildClaimRecallBlock: buildClaimRecallBlockM,
}));
vi.mock('../plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planTerminalityInWorkspace: planTerminalityInWorkspaceM,
  planHarnessesForSlugs: planHarnessesForSlugsM,
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return { ...actual, getNextForBee: getNextM, getClaimSpecRecord: getClaimSpecRecordM };
});
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: reconcileFleetScopeClaimsM,
  readFleetPauseState: readFleetPauseStateM,
  // EI-13520: real fn returns null (no cooldown-diagnosis signal) by default — these tests
  // don't exercise the cooldown-attribution path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  // WI-5561: real fn returns null (no issue-floor-breakdown signal) by default — these tests
  // don't exercise the issue-floor-breakdown path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeIssueFloorMiss: diagnoseFleetScopeIssueFloorMissM,
  // WI-7151: only ever reached when a breakdown reports matchedByFilter===0 (the issueFloorMiss
  // mock above always returns null, so this path is unreachable here) — defensive stub only.
  diagnoseFleetScopeFeatureFamilyMatch: vi.fn(async () => null),
  // EI-20260781488788952: the zero-match enrichment reads these diagnostics alongside the
  // existing family/exhaustion seams; keep this mock's module shape aligned with production.
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: diagnoseFleetScopeLeaderLivenessM,
  fleetLeaderUnavailableRefusal: (scope: any) => ({
    ok: false,
    error: 'fleet_leader_unavailable',
    recoverable: true,
    leaderLiveness: false,
    noClaim: true,
    windDown: false,
    fleetScope: { fleet: scope.fleetSlug, member: scope.ownerId },
    recovery: { tool: 'fleet:take-leadership', args: { fleet: scope.fleetSlug } },
    advice: `Recover '${scope.fleetSlug}' and retry scheduler:get_next.`,
  }),
  fleetScopedMiss: (
    scope: any,
    quarantinedIds: string[],
    opts?: {
      pausedReason?: string | null;
      cooldownDiag?: { cooldownExcluded: number; earliestExpiryMs: number | null } | null;
      claimableAwaitsCancelled?: number;
      issueBreakdown?: unknown;
    },
  ) => ({
    ok: false,
    error:
      opts?.pausedReason !== undefined
        ? `paused: ${opts.pausedReason ?? ''}`
        : opts?.cooldownDiag
          ? `cooldown-only miss; ${opts.cooldownDiag.cooldownExcluded} excluded`
          : opts?.issueBreakdown
            ? 'floor-gated miss (WI-5561); see excludedBreakdownSummary'
            : 'scoped miss; no generic fallback',
    fleetScope: { fleet: scope.fleetSlug, source: scope.record.source },
    quarantinedIds,
    windDown: true,
    ...(opts?.pausedReason !== undefined ? { paused: true } : {}),
    ...(opts?.pausedReason !== undefined ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(opts?.cooldownDiag ? { cooldownOnly: true } : {}),
    ...(opts?.issueBreakdown ? { excludedBreakdown: opts.issueBreakdown } : {}),
  }),
}));

import getNextTool, {
  GET_NEXT_BUDGET_MS,
  GET_NEXT_ISSUE_DIAG_BUDGET_MS,
  GET_NEXT_TOTAL_BUDGET_MS,
} from './get_next';
import claimNextTool from '../work_items/claim_next';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';

function handlerPayload(out: {
  data?: unknown;
  content?: Array<{ text?: string }>;
}): Record<string, unknown> {
  if (out.data !== undefined) return out.data as Record<string, unknown>;
  return JSON.parse(out.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  reconcileFleetScopeClaimsM.mockImplementation(async () => ({
    scope: scopeState.scope,
    quarantinedIds: scopeState.quarantinedIds,
  }));
  readFleetPauseStateM.mockImplementation(async () => ({
    windingDown: scopeState.windingDown,
    reason: scopeState.pauseReason,
  }));
  diagnoseFleetScopeIssueFloorMissM.mockResolvedValue(null);
  getFlagM.mockResolvedValue(true);
  liveLockedPathsM.mockImplementation(async () => []);
  getPresenceM.mockResolvedValue(null);
  writePresenceM.mockResolvedValue(undefined);
  buildClaimRecallBlockM.mockResolvedValue(null);
  planTerminalityInWorkspaceM.mockResolvedValue(null);
  getClaimSpecRecordM.mockResolvedValue({
    source: 'default',
    spec: { specId: 'default', revision: 0 },
    revision: null,
    updatedBy: null,
    updatedAt: null,
  });
  workItemClaimLeaseEnabledM.mockReturnValue(false);
  leaseClaimedWorkItemM.mockResolvedValue(true);
  releaseWorkItemM.mockResolvedValue(undefined);
});

describe('scheduler:get_next ambient transaction reservation', () => {
  it('opts out because the self-pull handler owns its DB accessors', () => {
    expect((getNextTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

const TOOLS: Array<{ name: string; args: ZodTypeAny }> = [
  { name: 'scheduler:get_next', args: (getNextTool as { args: ZodTypeAny }).args },
  { name: 'work_items:claim_next', args: (claimNextTool as { args: ZodTypeAny }).args },
];

describe('scheduler:get_next claim-spec identity is inherited (EI-20225786201327575)', () => {
  it('teaches the accepted call shape and keeps spec identity read-only', () => {
    const tool = getNextTool as { args: ZodTypeAny; description?: string; guidance?: { when?: string } };
    expect(tool.description).toContain('specId and revision are result provenance, not request arguments');
    expect(tool.description).toContain("successful claim also declares the caller's WI-/EI- intent");
    expect(tool.guidance?.when).toContain('do NOT pass specId, revision, fleet, workspace, or claimSpec');
    expect(tool.guidance?.when).toContain('claimedUnder');

    for (const [field, value] of [
      ['specId', 'nonp2p-bug-drain-headless-0812'],
      ['revision', 1],
      ['fleet', 'nonp2p-bug-drain-headless-0812'],
      ['workspace', 'papercusp-workspace'],
      ['claimSpec', { specId: 'lane', revision: 1 }],
      ['limit', 1],
    ] as const) {
      const result = tool.args.safeParse({ harness: 'papercusp', [field]: value });
      expect(result.success, `scheduler:get_next must reject undeclared ${field}`).toBe(false);
    }
  });
});

describe('scheduler:get_next prompt guidance budget (EI-20226961413829051)', () => {
  it('stays within the shared non-grandfathered prompt-weight budget', () => {
    expect(promptWeight(getNextTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });
});

describe('scheduler:get_next derives harness from the bound session (WI-38059)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
    getSessionBriefM.mockResolvedValue(null);
  });

  it('advertises an optional harness and passes the bound session harness to the claim path', async () => {
    const tool = getNextTool as { args: ZodTypeAny; description?: string };
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.description).toContain('specId and revision are result provenance');

    const out = (await getNextTool.handler({}, { harnessSlug: 'papercusp' } as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(getNextM).toHaveBeenCalledOnce();
    expect(getNextM.mock.calls[0]?.[0]).toMatchObject({
      harness: 'papercusp',
      useDedicatedClaimPool: true,
    });
  });

  it('returns a typed harness_required error when neither the call nor session supplies one', async () => {
    const out = (await getNextTool.handler({}, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'harness_required' });
    expect(out.isError).toBe(true);
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('resolves the durable session harness when transport context carries the unscoped sentinel', async () => {
    getSessionBriefM.mockResolvedValue({ workspaceId: 'ws-1', harnessSlug: 'papercusp' });

    const out = (await getNextTool.handler({}, { harnessSlug: '*' } as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0].text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(getSessionBriefM).toHaveBeenCalledWith({ ownerId: 'su-member' });
    expect(getNextM).toHaveBeenCalledOnce();
    expect(getNextM.mock.calls[0]?.[0]).toMatchObject({ harness: 'papercusp' });
  });

  it('does not pass the unscoped sentinel downstream when no durable harness exists', async () => {
    const out = (await getNextTool.handler({}, { harnessSlug: '*' } as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const body = JSON.parse(out.content[0].text);

    expect(body).toMatchObject({ ok: false, error: 'harness_required' });
    expect(out.isError).toBe(true);
    expect(getNextM).not.toHaveBeenCalled();
  });
});

describe('pull-tool `states` arg is clamped to the claimable allowlist (WI-1912)', () => {
  it('exposes the expected allowlist (open/failing — feature `todo` retired, floors + terminals excluded)', () => {
    expect([...CLAIM_STATES_ALLOWLIST]).toEqual(['open', 'failing']);
  });

  it('accepts every allowlisted state', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: [...CLAIM_STATES_ALLOWLIST] });
      expect(r.success, `${name} should accept states:${JSON.stringify(CLAIM_STATES_ALLOWLIST)}`).toBe(true);
    }
  });

  it('accepts an omitted `states` (the ["open"] default)', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp' });
      expect(r.success, `${name} should accept omitted states`).toBe(true);
    }
  });

  it('REJECTS floor-protected and terminal states — the WI-1912 widening', () => {
    for (const { name, args } of TOOLS) {
      for (const bad of ['blocked', 'cursed', 'in_progress', 'passed', 'resolved', 'closed', 'deprecated', 'needs-human', 'todo']) {
        const r = args.safeParse({ harness: 'papercusp', states: ['open', bad] });
        expect(r.success, `${name} must reject states:['open','${bad}']`).toBe(false);
      }
    }
  });

  it("REJECTS the exact observed widening args (states:['todo','open','blocked'])", () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: ['todo', 'open', 'blocked'] });
      expect(r.success, `${name} must reject the WI-1912 repro args`).toBe(false);
    }
  });
});

describe('scheduler:get_next hard fleet boundary (P-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('refuses a member with no explicit/inherited spec before generic selection', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'default', spec: { specId: 'default', revision: 0 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, fleetScope: { fleet: 'bugs', source: 'default' } });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('returns a scoped wind-down verdict on miss, including the one-pass quarantine result', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = ['WI-out'];
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, quarantinedIds: ['WI-out'] });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  // EI-12832: a member woken during a fleet pause (control_state='winding-down')
  // must stand down — the self-select path floors BEFORE it pulls, whatever the spec matches.
  it('EI-12832: a winding-down fleet floors self-select — paused miss, no pull', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.windingDown = true;
    scopeState.pauseReason = 'owner pause';
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, paused: true });
    expect(getNextM).not.toHaveBeenCalled();
    // EI-15777: the paused-miss branch must cancel the caller's OWN standing
    // work-item:claimable await(s) (self-scoped by ownerId) so a compliant peer
    // stand-down doesn't keep re-waking this member on a pull it's forbidden to make.
    expect(cancelClaimableAwaitsM).toHaveBeenCalledWith('su-member');
  });

  it('EI-21079515303301272: blocks an active member before claim when its registered leader is not live', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'leaderless-fleet',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'leaderless-rev4', revision: 4 } },
    };
    diagnoseFleetScopeLeaderLivenessM.mockResolvedValue(false);
    getNextM.mockResolvedValue({ workItem: { id: 'WI-must-not-claim' } });

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'fleet_leader_unavailable',
      noClaim: true,
      recoverable: true,
      leaderLiveness: false,
      windDown: false,
      recovery: { tool: 'fleet:take-leadership', args: { fleet: 'leaderless-fleet' } },
    });
    expect(body.advice).toMatch(/retry scheduler:get_next/);
    expect(diagnoseFleetScopeLeaderLivenessM).toHaveBeenCalledWith({ scope: scopeState.scope });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('keeps the self-pull path fail-open when leader liveness is unreadable', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'leader-read-error-fleet',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'lane-rev4', revision: 4 } },
    };
    diagnoseFleetScopeLeaderLivenessM.mockResolvedValue(null);
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
  });
});

describe('scheduler:get_next declared-plan boundary (EI-21238986333755666)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getClaimSpecRecordM.mockResolvedValue({
      source: 'default',
      spec: { specId: 'default', revision: 0 },
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
    getNextM.mockResolvedValue({ workItem: { id: 'WI-must-not-claim', title: 'Unrelated work' } });
    getPresenceM.mockResolvedValue({ currentPlanSlug: 'active-control-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: true });
  });

  it('fails closed before getNextForBee when a non-fleet caller declares a plan but has only the default spec', async () => {
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'plan_scope_missing',
      reason: 'declared_plan_without_claim_spec',
      noClaim: true,
      windDown: false,
      recoverable: true,
      declaredPlanSlug: 'active-control-plan',
      claimSpecSource: 'default',
    });
    expect(body.recovery).toMatchObject({
      tool: 'scheduler:set_claim_spec',
      args: {
        cupId: 'su-member',
        harness: 'papercusp',
        spec: {
          specVersion: '1.0',
          specId: 'declared-plan:active-control-plan',
          revision: 1,
          view: { filter: { field: 'plan', op: '=', value: 'active-control-plan' } },
          rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        },
      },
    });
    expect((body.recovery as { args: Record<string, unknown> }).args).not.toHaveProperty('plan');
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('clears a positively terminal stale declaration before resuming the default pull', async () => {
    getPresenceM.mockResolvedValue({ intent: 'finished plan work', currentPlanSlug: 'shipped-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    getNextM.mockResolvedValue(null);

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body.error).not.toBe('plan_scope_missing');
    expect(getNextM).toHaveBeenCalledOnce();
    expect(planTerminalityInWorkspaceM).toHaveBeenCalledWith('ws-1', 'shipped-plan');
    expect(writePresenceM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-member' }),
      { intent: 'finished plan work', currentPlanSlug: null },
      'papercusp',
    );
  });

  it('also clears an active plan declaration whose plan has no open items', async () => {
    getPresenceM.mockResolvedValue({ intent: 'drained plan work', currentPlanSlug: 'drained-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: false });
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
    expect(writePresenceM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-member' }),
      { intent: 'drained plan work', currentPlanSlug: null },
      'papercusp',
    );
  });

  it('keeps the fail-closed refusal when clearing the terminal declaration fails', async () => {
    getPresenceM.mockResolvedValue({ intent: 'finished plan work', currentPlanSlug: 'shipped-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    writePresenceM.mockRejectedValue(new Error('presence write failed'));

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'plan_scope_missing', noClaim: true });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('keeps the fail-closed refusal when terminality cannot be positively established', async () => {
    planTerminalityInWorkspaceM.mockResolvedValue(null);

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'plan_scope_missing', noClaim: true });
    expect(getNextM).not.toHaveBeenCalled();
    expect(writePresenceM).not.toHaveBeenCalled();
  });

  it('allows a declared-plan caller whose explicit per-bee spec supplies the scope', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'active-control-plan-lane', revision: 2 },
      revision: 2,
      updatedBy: 'leader',
      updatedAt: new Date().toISOString(),
    });
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
  });
});

// EI-16057: an unresolvable `harness` (e.g. a workspace id passed where a slug
// belongs) used to match zero rows in the claim query and render as `windDown:true`
// — indistinguishable from a genuinely drained fleet-scoped lane, so a member would
// stand its loop down and report a false all-clear. It must instead fail loud as a
// plain invalid_input, before any fleet-scope reconciliation runs, and NEVER set
// windDown.
describe('scheduler:get_next harness-existence gate (EI-16057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('an unregistered harness (e.g. a workspace id) returns invalid_input, never windDown', async () => {
    const out = (await getNextTool.handler({ harness: 'papercusp-workspace' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'invalid_input',
      reason: 'harness_not_found',
      passedHarness: 'papercusp-workspace',
      knownHarnesses: ['papercusp'],
    });
    expect(b.windDown).toBeUndefined();
    // The real claim query still runs (harness validity is checked only on the miss it
    // produces, so a correct pull never pays the extra read) — it's the WINDOWN-BEARING
    // fleetScopedMiss branch below it that must never fire for this cause.
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registered harness slug is unaffected — passes through to the normal claim path', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registry-read failure fails OPEN — never blocks a legitimate claim on a read hiccup', async () => {
    loadHarnessRegistryM.mockImplementation(async () => {
      throw new Error('transient PG hiccup');
    });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b.error).not.toBe('invalid_input');
    expect(getNextM).toHaveBeenCalledOnce();
  });
});

// EI-18167154191955470: a routine scheduler:get_next hung with ZERO response/progress for the
// full 300s MCP idle timeout (the signature of PG pool contention — a query stuck waiting on a
// pool connection blocks silently, no error) and was aborted by the client; an immediate retry
// succeeded in ~2s. The DB path (chiefly the atomic claim) is now bounded so such a stall returns
// a FAST, clean, retryable error WELL under the idle abort. These pin the two behaviors: fail
// FAST (never a silent hang) and fail LOUD (a real error is never swallowed into a false miss).
describe('scheduler:get_next bounds the claim path against a silent hang (EI-18167154191955470)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fast retryable timeout miss when the claim exceeds the budget, not a 300s hang', async () => {
    vi.useFakeTimers();
    // withBoundedTimeout logs a console.warn when it degrades; the warn is EXPECTED here (it is
    // the fail-fast firing), so capture it explicitly rather than let vitest-fail-on-console trip.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate the pool-contention stall: the atomic claim never resolves within the budget.
    getNextM.mockImplementation(() => new Promise(() => {}));
    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    // Advance past the internal budget so the bounded-timeout deadline fires; without the bound
    // this promise would never settle (the hang the bug reported).
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      budgetMs: GET_NEXT_BUDGET_MS,
    });
    expect(typeof b.message).toBe('string');
    // The message must point the caller at the real failure (idle-timeout abort) + the retry.
    expect(b.message).toContain('300s');
    // A transient timeout is NOT a drained lane — windDown must never be set for it.
    expect(b.windDown).toBeUndefined();
    // The bounded-timeout deadline fired (the fail-fast) — assert it explicitly.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:claim exceeded'));
    warnSpy.mockRestore();
  });

  it('shares one deadline across a slow preflight and a hanging claim', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getFlagM
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20_000)),
      )
      .mockResolvedValue(true);
    getNextM.mockImplementation(() => new Promise(() => {}));

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_TOTAL_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'timeout', retryable: true });
    expect(body.budgetMs).toBeLessThan(GET_NEXT_BUDGET_MS);
    expect(Date.now() - startedAt).toBe(GET_NEXT_TOTAL_BUDGET_MS + 100);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:claim exceeded'));
    warnSpy.mockRestore();
  });

  it('bounds a hanging fleet issue-floor diagnosis below the whole-handler deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      workspaceId: 'ws-1',
      record: {
        source: 'fleet',
        spec: {
          specId: 'bugs-rev1',
          revision: 1,
          states: ['open'],
          view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
        },
      },
    };
    getNextM.mockResolvedValue(null);
    diagnoseFleetScopeIssueFloorMissM.mockImplementation(() => new Promise(() => {}));

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_ISSUE_DIAG_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(Date.now() - startedAt).toBeLessThan(GET_NEXT_TOTAL_BUDGET_MS);
    expect(diagnoseFleetScopeIssueFloorMissM).toHaveBeenCalledWith(
      expect.objectContaining({ totalBudgetMs: GET_NEXT_ISSUE_DIAG_BUDGET_MS }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:issueFloorMiss exceeded'));
    warnSpy.mockRestore();
  });

  it('re-surfaces a genuine underlying claim error loudly — never swallowed as a silent miss', async () => {
    // The degrade-warn is expected on the error path too (buildBoundedTimeout logs before
    // re-surfacing) — capture it so vitest-fail-on-console does not trip on the expected warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockRejectedValue(new Error('pool exhausted: boom'));
    await expect(
      getNextTool.handler({ harness: 'papercusp' } as never, {} as never),
    ).rejects.toThrow(/pool exhausted: boom/);
    warnSpy.mockRestore();
  });

  it('returns a retryable timeout for bounded PG contention instead of handler_error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contention = new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
    getNextM.mockRejectedValue(contention);

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(b.message).toContain('operator write timed out waiting for a row/advisory lock');
    expect(b.message).toContain('Retry now');
    expect(b.windDown).toBeUndefined();
    warnSpy.mockRestore();
  });
});

// EI-20228674494907304: the first timeout was observed after a fleet spec revision wake, but
// the old watchdog began only at getNextForBee. These tests isolate every pre-claim await so a
// reconciliation, pause-state, flag, or lock-plane stall cannot regress into a 300s MCP hang.
describe('scheduler:get_next bounds every pre-claim await (EI-20228674494907304)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function expectPreflightTimeout() {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);
    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      phase: 'preflight',
      budgetMs: GET_NEXT_BUDGET_MS,
    });
    expect(body.message).toContain('No claim was attempted');
    expect(getNextM).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:preflight exceeded'));
    warnSpy.mockRestore();
  }

  it('bounds fleet-scope reconciliation before any claim attempt', async () => {
    reconcileFleetScopeClaimsM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout();
  });

  it('bounds the paused-fleet control-state read before any claim attempt', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev1', revision: 1 } },
    };
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: scopeState.scope, quarantinedIds: [] });
    readFleetPauseStateM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout();
  });

  it('bounds the scheduler flag read before any claim attempt', async () => {
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: null, quarantinedIds: [] });
    getFlagM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout();
  });

  it('bounds the live lock-plane snapshot before any claim attempt', async () => {
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: null, quarantinedIds: [] });
    getFlagM.mockResolvedValue(true);
    liveLockedPathsM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout();
  });
});

// EI-21834503221873518: the claim commits before advisory enrichment begins. A
// post-claim read that never settles must therefore degrade to the compact,
// committed receipt instead of leaving the caller to retry a destructive pull.
describe('scheduler:get_next bounds post-claim enrichment (EI-21834503221873518)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the committed claim receipt when claim-time recall hangs', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockResolvedValue({
      workItem: { id: 'WI-218345032', title: 'post-claim enrichment stalls' },
      claimedUnder: { specId: 'scheduler-spec', revision: 7 },
    });
    buildClaimRecallBlockM.mockImplementation(() => new Promise<string | null>(() => {}));

    const pending = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      data?: unknown;
      content?: Array<{ text?: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_TOTAL_BUDGET_MS + 100);

    const out = await pending;
    const body = handlerPayload(out);
    expect(body).toMatchObject({
      ok: true,
      claimReceipt: {
        committed: true,
        workItemId: 'WI-218345032',
        specId: 'scheduler-spec',
        revision: 7,
      },
      workItem: { id: 'WI-218345032' },
    });
    expect(buildClaimRecallBlockM).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'su-member',
        workspaceId: 'ws-1',
        items: [expect.objectContaining({ id: 'WI-218345032' })],
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scheduler:get_next:postClaimEnrichment exceeded'),
    );
    warnSpy.mockRestore();
  });
});

/**
 * EI-20099413453852234 — claiming an item must also DECLARE it.
 *
 * get_next claimed an item and left the caller's declared intent untouched, so presence held a
 * live claim beside a stale intent and computed `intentDivergent: true` for an agent that was
 * actively mid-implementation. Peers use that signal to judge whether a claim is real: one read
 * it and offered to take an item out from under its holder, mid-fix. An agent in a get_next loop
 * re-claims every wake, so the intent was stale BY CONSTRUCTION unless it remembered a second,
 * optional call each time.
 */
describe('a successful claim declares the caller intent (EI-20099413453852234)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4242', title: 'Fix the flaky thing' } });
    getPresenceM.mockResolvedValue(null);
    writePresenceM.mockResolvedValue(undefined);
  });

  it('writes an intent naming the claimed item', async () => {
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).toHaveBeenCalledTimes(1);
    expect(writePresenceM.mock.calls[0]![1]).toMatchObject({
      intent: 'WI-4242: Fix the flaky thing',
    });
  });

  it('publishes the complete committed claim through structuredContent for programmatic callers', async () => {
    const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('scheduler:get_next')!;
    const dispatched = await dispatchProjectedTool(
      projected,
      'scheduler:get_next',
      { harness: 'papercusp' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        runId: 'scheduler-structured-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: vi.fn(async () => []),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      claimReceipt: {
        committed: true,
        workItemId: 'WI-4242',
      },
      workItem: { id: 'WI-4242' },
    });
  });

  it('passes live peer lock paths into the atomic placement rank, excluding its own locks', async () => {
    liveLockedPathsM.mockResolvedValueOnce(['packages/operator-core/lib/hot.ts']);
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(liveLockedPathsM).toHaveBeenCalledWith({ excludeOwner: 'su-member' });
    expect(getNextM).toHaveBeenCalledWith(expect.objectContaining({
      cupId: 'su-member',
      contendedPaths: ['packages/operator-core/lib/hot.ts'],
    }));
  });

  it('routes a legacy/pre-envelope bug through the cheap validation lane at claim time', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4242', title: 'Fix the flaky thing', kind: 'bug' } });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({
      ok: true,
      workItem: { id: 'WI-4242' },
      freshness: {
        lane: 'validation',
        likelyStale: true,
        reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
      },
    });
  });

  it('does not attach bug-freshness routing to a non-bug claim', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4243', title: 'Improve the flow', kind: 'change' } });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).not.toHaveProperty('freshness');
  });

  // THE REGRESSION CASE, and the reason this is a read-modify-write rather than a bare write.
  // PgPresenceStore's ON CONFLICT sets `current_plan_slug = EXCLUDED.current_plan_slug` — a BARE
  // assignment — so a write that omits it CLEARS it. Without this test a naive implementation
  // passes the one above while silently wiping the declared plan slug of every self-pulling
  // agent on every claim: strictly worse than the stale intent it set out to fix.
  it('CARRIES the existing currentPlanSlug — a claim must never wipe the declared plan', async () => {
    getPresenceM.mockResolvedValue({ intent: 'something older', currentPlanSlug: 'my-plan-slug' });
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'my-plan-lane', revision: 1 },
      revision: 1,
      updatedBy: 'leader',
      updatedAt: new Date().toISOString(),
    });
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM.mock.calls[0]![1]).toMatchObject({ currentPlanSlug: 'my-plan-slug' });
  });

  it('does not clobber an intent the caller already declared for THIS item', async () => {
    getPresenceM.mockResolvedValue({
      intent: 'WI-4242: my own richer wording, deliberately set',
      currentPlanSlug: null,
    });
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).not.toHaveBeenCalled();
  });

  // The claim is COMMITTED before this runs, so losing the caller's result over a presence
  // hiccup would be far worse than a stale intent. Both legs must fail soft.
  it('still returns the claim when the presence write throws', async () => {
    writePresenceM.mockRejectedValue(new Error('presence pool exhausted'));
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({ workItem: { id: 'WI-4242' } });
  });

  it('still returns the claim when the presence READ throws', async () => {
    getPresenceM.mockRejectedValue(new Error('presence read failed'));
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({ workItem: { id: 'WI-4242' } });
  });

  it('declares nothing on a MISS — an empty pull leaves the existing intent alone', async () => {
    getNextM.mockResolvedValue(null);
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).not.toHaveBeenCalled();
  });
});

describe('scheduler:get_next claim lease arbitration (WI-39730)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue({ workItem: { id: 'WI-lease-lost', title: 'Lease arbitration regression' } });
    workItemClaimLeaseEnabledM.mockReturnValue(true);
    leaseClaimedWorkItemM.mockResolvedValue(false);
    releaseWorkItemM.mockResolvedValue(undefined);
  });

  it('releases a local claim when the Hive lease is lost and never reports it committed', async () => {
    const out = await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(leaseClaimedWorkItemM).toHaveBeenCalledWith({
      harness: 'papercusp',
      workItemId: 'WI-lease-lost',
      owner: 'su-member',
    });
    expect(releaseWorkItemM).toHaveBeenCalledWith('WI-lease-lost', {
      harness: 'papercusp',
      expectedAssignee: 'su-member',
    });
    expect(handlerPayload(out as { data?: unknown; content?: Array<{ text?: string }> })).not.toMatchObject({
      ok: true,
      claimReceipt: { committed: true, workItemId: 'WI-lease-lost' },
    });
  });
});
