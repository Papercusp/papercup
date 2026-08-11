/** Recurrence guards for P-016's shared fleet-scope predicate + wind-down contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterNode } from './claim-spec';
import type { ClaimSpecRecord } from './claim-spec-store';
import {
  claimSpecSubjectFromWorkItem,
  matchesClaimSpecFilter,
  type ClaimSpecSubject,
} from './claim-spec-match';
const admissionMocks = vi.hoisted(() => ({
  getClaimSpecRecord: vi.fn(),
  latestFleetMembership: vi.fn(),
  listFleetAssignments: vi.fn(),
  getWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  sendMessage: vi.fn(),
  getFleet: vi.fn(),
  // EI-13520: diagnoseFleetScopeCooldownMiss's own seam-level dependencies —
  // claimFloorsWhereSql/releaseCooldownSec (work-items.ts) + compileFilter
  // (get-next.ts) are mocked here so the test asserts the WIRING (right args in,
  // right count/expiry out) instead of replicating postgres.js's nested tagged-
  // template fragment composition in a fake sql tag.
  claimFloorsWhereSql: vi.fn(),
  releaseCooldownSec: vi.fn(),
  compileFilter: vi.fn(),
  // WI-5561: diagnoseFleetScopeIssueFloorMiss's own seam-level dependency — the
  // real aggregateIssueClaimExclusions (get-next.ts) is mocked here for the same
  // reason compileFilter is: assert the WIRING, not postgres.js's SQL composition.
  aggregateIssueClaimExclusions: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('./claim-spec-store', () => ({
  getClaimSpecRecord: admissionMocks.getClaimSpecRecord,
}));
vi.mock('../fleet-membership-store', () => ({
  latestFleetMembership: admissionMocks.latestFleetMembership,
}));
vi.mock('../fleet/assignments', async (importOriginal) => {
  // WI-6326: keep groupByAgent REAL (hasLiveFleetRouteTarget's own dependency) — only
  // listFleetAssignments (the PG I/O) is mocked, same pattern as reconcileFleetScopeClaims
  // already relies on elsewhere in this file.
  const actual = await importOriginal<typeof import('../fleet/assignments')>();
  return { ...actual, listFleetAssignments: admissionMocks.listFleetAssignments };
});
vi.mock('../work-items', () => ({
  getWorkItem: admissionMocks.getWorkItem,
  releaseWorkItem: admissionMocks.releaseWorkItem,
  claimFloorsWhereSql: admissionMocks.claimFloorsWhereSql,
  releaseCooldownSec: admissionMocks.releaseCooldownSec,
  // EI-19393442073558754: specIsIssueFamilyOnly (fleet-scope-admission.ts) imports the REAL
  // kind-set constant from '../work-items' — mirror it here rather than re-declaring it, so
  // this mock can never silently drift from the real ISSUE_FAMILY_KINDS.
  ISSUE_FAMILY_KINDS: ['bug', 'change', 'task'],
}));
vi.mock('./get-next', () => ({
  compileFilter: admissionMocks.compileFilter,
  aggregateIssueClaimExclusions: admissionMocks.aggregateIssueClaimExclusions,
}));
vi.mock('../agent-tools/coordination/messages', () => ({
  sendMessage: admissionMocks.sendMessage,
}));
vi.mock('../agent-fleets-store', () => ({
  getFleet: admissionMocks.getFleet,
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: admissionMocks.sql }),
}));

import {
  admitWorkItemForFleetTarget,
  diagnoseFleetScopeCooldownMiss,
  diagnoseFleetScopeIssueFloorMiss,
  fleetScopeLeaderRemedy,
  fleetScopedMiss,
  hasLiveFleetRouteTarget,
  itemMatchesRawClaimSpec,
  notifyFleetScopeRefusal,
  readFleetPauseState,
  reconcileFleetScopeClaims,
  type FleetScopeAdmission,
} from './fleet-scope-admission';

const base: ClaimSpecSubject = {
  id: 'WI-7',
  title: 'Fix scheduler admission',
  kind: 'bug',
  priority: 3,
  tags: ['scheduler', 'non-p2p'],
  paths: ['packages/operator-core/lib/scheduler/get-next.ts'],
  plan: 'bug-drain',
  planItem: ['P-016'],
  age: 1_000,
  riskTier: 'moderate',
  redundancy: 1,
  estCost: 12,
  assignee: null,
  severity: 'major',
  goal: null,
};

describe('fleet scope assignment admission (P-016)', () => {
  beforeEach(() => {
    for (const mock of Object.values(admissionMocks)) mock.mockReset();
    admissionMocks.sendMessage.mockResolvedValue(undefined);
  });

  it('evaluates the full boolean grammar, including id cohort + non-P2P exclusion', () => {
    const filter: FilterNode = {
      all: [
        { field: 'id', op: 'in', value: ['WI-7', 'WI-8'] },
        { field: 'kind', op: '=', value: 'bug' },
        { not: { field: 'title', op: 'glob', value: '*p2p*' } },
        { any: [{ field: 'tags', op: 'contains', value: 'scheduler' }, { field: 'risk_tier', op: '=', value: 'low' }] },
      ],
    };
    expect(matchesClaimSpecFilter(base, filter)).toBe(true);
    expect(matchesClaimSpecFilter({ ...base, id: 'WI-out' }, filter)).toBe(false);
    expect(matchesClaimSpecFilter({ ...base, title: 'P2P transport bug' }, filter)).toBe(false);
  });

  it('treats an unknown not-yet-minted id as outside a fixed cohort', () => {
    expect(matchesClaimSpecFilter({ ...base, id: null }, { field: 'id', op: 'in', value: ['WI-7'] })).toBe(false);
  });

  it('mirrors priority inversion and array membership semantics from the SQL compiler', () => {
    expect(matchesClaimSpecFilter(base, { field: 'priority', op: '>', value: 5 })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'plan_item', op: '=', value: 'P-016' })).toBe(true);
    expect(matchesClaimSpecFilter(base, { field: 'paths', op: 'glob', value: '*scheduler*' })).toBe(true);
  });

  it('hydrates issue plan/risk/path vocabulary from the canonical payload shape', () => {
    const subject = claimSpecSubjectFromWorkItem({
      id: 'EI-9',
      harness: 'papercusp',
      kind: 'bug',
      family: 'issue',
      title: 'issue',
      summary: 'body',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      createdBy: null,
      severity: 'major',
      parent: null,
      payload: {
        plan_item: { plan_slug: 'ops', item_id: 'P-9' },
        paths: ['packages/operator-core/lib/x.ts'],
        risk_tier: 'high',
      },
      rank: null,
      rankWriter: null,
      rankUpdatedAt: null,
      priority: null,
      origin: 'local',
      auditVerdict: null,
      verifiedAuthorGithubUserId: null,
      terminalOwner: null,
      terminalCompletionRef: null,
      terminalCompletionEvidence: null,
      completionAuthority: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      closedAt: null,
      goalId: null,
    });
    expect(subject).toMatchObject({ plan: 'ops', planItem: ['P-9'], riskTier: 'high' });
    expect(subject.paths).toEqual(['packages/operator-core/lib/x.ts']);
  });

  it('returns an explicit wind-down verdict instead of generic-backlog advice', () => {
    const miss = fleetScopedMiss({
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet',
        spec: { specVersion: '1.0', specId: 'bugs-rev4', revision: 4, view: {}, rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] } },
        revision: 4,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    }, ['WI-out']);
    expect(miss).toMatchObject({ windDown: true, quarantinedIds: ['WI-out'], fleetScope: { fleet: 'bugs' } });
    expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    expect(miss.advice).toMatch(/loop:end/);
  });

  it('releases every incompatible pre-existing claim in one reconciliation sweep and alerts once', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'id', op: 'in', value: ['WI-in'] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    });
    admissionMocks.listFleetAssignments.mockResolvedValue([
      { source: 'work_item_claim', workItemId: 'WI-out-1' },
      { source: 'work_item_claim', workItemId: 'WI-in' },
      { source: 'work_item_claim', workItemId: 'WI-out-2' },
      { source: 'work_item_claim', workItemId: 'WI-out-1' }, // de-duped, not dripped into a later wake
    ]);
    admissionMocks.getWorkItem.mockImplementation(async (id: string) => ({
      id,
      family: 'issue',
      kind: 'bug',
      title: id,
      summary: id,
      state: 'wip',
      assignee: 'su-member',
      payload: {},
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }));
    admissionMocks.releaseWorkItem.mockImplementation(async (id: string) => ({ id }));

    const result = await reconcileFleetScopeClaims({
      ownerId: 'su-member',
      workspaceId: 'papercusp-workspace',
      identity: { ownerId: 'su-member' } as never,
    });

    expect(result.quarantinedIds).toEqual(['WI-out-1', 'WI-out-2']);
    expect(admissionMocks.releaseWorkItem).toHaveBeenCalledTimes(2);
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(1, 'WI-out-1', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.releaseWorkItem).toHaveBeenNthCalledWith(2, 'WI-out-2', {
      expectedAssignee: 'su-member',
    });
    expect(admissionMocks.sendMessage).toHaveBeenCalledOnce();
    expect(admissionMocks.sendMessage.mock.calls[0]?.[1]).toMatchObject({
      to: ['@fleet-leader:bugs'],
      summary: 'quarantined 2 out-of-scope fleet claim(s)',
    });
  });

  // EI-16710: featureMatchesRecord must key the workspace match off the EXPLICITLY
  // threaded scope.workspaceId — never an ambient/global resolver — or a genuinely
  // in-scope feature-family item spuriously fails to match (and, in the live path,
  // reconcileFleetScopeClaims wrongly releases + re-arms the cooldown on the member's
  // own valid claim every single call).
  it('EI-16710: a feature-family item matches scope using the caller-supplied workspaceId, not an ambient global', async () => {
    admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
    admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'active', controlReason: null });
    admissionMocks.getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'kind', op: '=', value: 'feature' } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    });
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.getWorkItem.mockResolvedValue({
      id: 'WI-feat',
      family: 'feature',
      kind: 'feature',
      title: 'WI-feat',
      summary: 'WI-feat',
      state: 'todo',
      assignee: null,
      payload: {},
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    // The outer EXISTS query's own raw SQL text contains `workspace_id =`; the nested
    // harness_slug/TRUE fragment does not — keying off that isolates exactly what
    // value the outer query received for `workspaceId`, independent of any ambient
    // resolver the (buggy) old code might otherwise have consulted.
    admissionMocks.sql.mockImplementation((strings: readonly string[], ...values: unknown[]) => {
      if (strings.some((s) => s.includes('workspace_id ='))) {
        return Promise.resolve([{ matched: values[0] === 'papercusp-workspace' }]);
      }
      return 'FRAGMENT';
    });

    const admission = await admitWorkItemForFleetTarget({
      target: 'su-member',
      workItemId: 'WI-feat',
      workspaceId: 'papercusp-workspace',
    });

    expect(admission).toMatchObject({ allowed: true, scoped: true });
    expect(admissionMocks.sql).toHaveBeenCalled();
  });

  // EI-12832: while a fleet is winding-down (paused via fleet:pause / fleet:wind-down),
  // a member must not acquire NEW work — the by-id claim path (admitWorkItemForFleetTarget)
  // must consult the durable control_state, not just spec-match. Regression: a compliant
  // stand-down release woke a parked member which then claimed the released item because
  // it was in-spec and the claim path never checked the pause.
  describe('EI-12832: fleet pause gates the claim/assign admission path', () => {
    const fleetSpec: ClaimSpecRecord = {
      source: 'fleet' as const,
      spec: {
        specVersion: '1.0',
        specId: 'bugs-rev4',
        revision: 4,
        view: { filter: { field: 'id', op: 'in', value: ['WI-in'] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      revision: 4,
      updatedBy: 'su-leader',
      updatedAt: 'now',
    };
    const issueItem = {
      id: 'WI-in',
      family: 'issue',
      kind: 'bug',
      title: 'WI-in',
      summary: 'WI-in',
      state: 'open',
      assignee: null,
      payload: {},
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };

    beforeEach(() => {
      admissionMocks.latestFleetMembership.mockResolvedValue({ fleetSlug: 'bugs', fleetRole: 'member' });
      admissionMocks.getClaimSpecRecord.mockResolvedValue(fleetSpec);
    });

    it('refuses a member by-id claim while its fleet is winding-down (paused), before any item read', async () => {
      admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'winding-down', controlReason: 'owner pause' });

      const admission = await admitWorkItemForFleetTarget({
        target: 'su-member',
        workItemId: 'WI-in',
        workspaceId: 'papercusp-workspace',
      });

      expect(admission).toMatchObject({ allowed: false, code: 'fleet_winding_down', scope: { fleetSlug: 'bugs' } });
      expect((admission as { reason: string }).reason).toMatch(/winding-down/);
      expect((admission as { reason: string }).reason).toMatch(/owner pause/);
      // The pause short-circuits admission BEFORE the item read — the claim never reaches spec-match.
      expect(admissionMocks.getWorkItem).not.toHaveBeenCalled();
    });

    it('allows the SAME in-spec claim once the fleet is active again (the fix is control-state-conditional)', async () => {
      admissionMocks.getFleet.mockResolvedValue({ fleetSlug: 'bugs', controlState: 'active', controlReason: null });
      admissionMocks.getWorkItem.mockResolvedValue(issueItem);

      const admission = await admitWorkItemForFleetTarget({
        target: 'su-member',
        workItemId: 'WI-in',
        workspaceId: 'papercusp-workspace',
      });

      expect(admission).toMatchObject({ allowed: true, scoped: true });
      expect(admissionMocks.getWorkItem).toHaveBeenCalledWith('WI-in', undefined);
    });

    it('fleetScopedMiss surfaces a paused stand-down verdict for the self-select path', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause' },
      );
      expect(miss).toMatchObject({ windDown: true, paused: true, fleetScope: { fleet: 'bugs' } });
      expect(miss.error).toMatch(/winding-down/);
      expect(miss.error).toMatch(/owner pause/);
      expect(miss.advice).toMatch(/fleet:resume/);
    });

    // EI-15777: the paused branch now also reports how many of the caller's OWN
    // pre-pause work-item:claimable idle-park await(s) were just cancelled server-side
    // (see the cancelClaimableAwaits call at both self-pull call sites) — and the
    // advice must tell the caller NOT to re-park one while paused, since that standing
    // wake was retired, not merely gated at the ensuing claim.
    it('EI-15777: a paused miss surfaces claimableAwaitsCancelled + the do-not-re-park advice', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause', claimableAwaitsCancelled: 2 },
      );
      expect(miss).toMatchObject({ windDown: true, paused: true, claimableAwaitsCancelled: 2 });
      expect(miss.advice).toMatch(/Do NOT re-park a work-item:claimable await while paused/);
      expect(miss.advice).toMatch(/EI-15777/);
    });

    it('EI-15777: a paused miss with no cancelled awaits still surfaces claimableAwaitsCancelled:0 (default)', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { pausedReason: 'owner pause' },
      );
      expect(miss).toMatchObject({ claimableAwaitsCancelled: 0 });
    });

    it('EI-15777: a non-paused (cooldown-only) miss never carries claimableAwaitsCancelled', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        [],
        { cooldownDiag: null },
      );
      expect(miss).not.toHaveProperty('claimableAwaitsCancelled');
    });

    it('readFleetPauseState fails OPEN when the control-state read errors (never wedges claiming)', async () => {
      admissionMocks.getFleet.mockRejectedValue(new Error('pg unavailable'));
      const state = await readFleetPauseState(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', workspaceId: 'papercusp-workspace', record: fleetSpec },
        'papercusp-workspace',
      );
      expect(state).toEqual({ windingDown: false, reason: null });
    });
  });

  // EI-13520: scheduler:get_next reported a release-cooldown exclusion as "no claimable
  // work-item matched fleet scope" — blaming the spec for a miss that was actually a
  // per-bee cooldown floor, driving a real fleet livelock of leader re-authoring a spec
  // that was never the cause. diagnoseFleetScopeCooldownMiss re-attributes the miss;
  // fleetScopedMiss surfaces it with an honest message + do-not-re-author advice.
  describe('EI-13520: cooldown-only miss re-attribution', () => {
    const cooldownScope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'bugs-rev4',
          revision: 4,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 4,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    beforeEach(() => {
      admissionMocks.claimFloorsWhereSql.mockReturnValue('FLOORS_NO_COOLDOWN');
      admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
      admissionMocks.releaseCooldownSec.mockReturnValue(300);
    });

    it('returns the cooldown-excluded count + earliest expiry + the argmin row id when rows match sans the cooldown floor', async () => {
      const releasedAt = new Date('2026-07-17T07:00:00.000Z');
      // EI-16519: the query now returns the argmin row (feature_id + last_released_at)
      // plus a `count(*) OVER()` window total, not a bare aggregate — one row back.
      admissionMocks.sql.mockResolvedValue([{ feature_id: 'WI-9001', last_released_at: releasedAt, cnt: 3 }]);

      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });

      expect(diag).toEqual({ cooldownExcluded: 3, earliestExpiryMs: releasedAt.getTime() + 300_000, earliestRowId: 'WI-9001' });
      // The defining assertion: the WITHOUT-cooldown floors call must NOT thread this
      // bee's ownerId as cooldownAssignee — that is precisely the leg being dropped.
      const floorsOpts = admissionMocks.claimFloorsWhereSql.mock.calls[0]?.[1];
      expect(floorsOpts).toMatchObject({ harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(floorsOpts?.cooldownAssignee).toBeUndefined();
    });

    it('returns null (no diagnosis) when nothing matches even without the cooldown floor', async () => {
      admissionMocks.sql.mockResolvedValue([]);
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
    });

    it('returns null when the spec has no view filter (nothing to diagnose)', async () => {
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: { ...cooldownScope, record: { ...cooldownScope.record, spec: { ...cooldownScope.record.spec, view: {} } } },
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
      expect(admissionMocks.sql).not.toHaveBeenCalled();
    });

    it('FAILS SOFT: a query error degrades to null, never throws (annotation only, like buildMissDiagnosis)', async () => {
      admissionMocks.sql.mockRejectedValue(new Error('pg unavailable'));
      const diag = await diagnoseFleetScopeCooldownMiss({
        scope: cooldownScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
      });
      expect(diag).toBeNull();
    });

    it('fleetScopedMiss reattributes a cooldown-only miss: honest message, cooldownOnly flag, do-not-re-author advice', () => {
      const miss = fleetScopedMiss(cooldownScope, [], {
        cooldownDiag: { cooldownExcluded: 3, earliestExpiryMs: Date.now() + 42_000, earliestRowId: 'WI-9001' },
      });
      expect(miss).toMatchObject({ windDown: true, cooldownOnly: true, cooldownExcluded: 3, cooldownEarliestRowId: 'WI-9001' });
      expect(miss.paused).toBeUndefined();
      expect(miss.error).toMatch(/YOUR OWN release-cooldown floor/);
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      // EI-13520's intent survives (a NORMAL one-time cooldown is not a scope/spec
      // problem — do not re-author the spec for it); EI-14615/EI-16519 only ADD the
      // livelock-vs-churn distinction below, they do not revert this.
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
      expect(miss.advice).toMatch(/do NOT re-author the claim spec/);
      expect(miss.advice).not.toMatch(/report the scoped miss to the fleet leader/);
    });

    // EI-14615/EI-16519: a cooldown-only miss whose relative `cooldownExpirySec` alone
    // can't reveal whether the SAME row keeps re-arming (a genuine livelock) or a
    // DIFFERENT one of this bee's own several recently-released rows is now the
    // earliest (ordinary churn) — so the miss surfaces both the ABSOLUTE
    // `cooldownExpiryAt` AND the specific `cooldownEarliestRowId` driving it, and the
    // advice teaches the caller to compare the ROW ID (not just the number) across polls.
    describe('EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice', () => {
      it('surfaces cooldownExpiryAt as the ISO of earliestExpiryMs (so a re-stamped window is observable across polls)', () => {
        const earliestExpiryMs = Date.parse('2026-07-17T15:09:00.000Z');
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs, earliestRowId: 'WI-9002' },
        });
        expect(miss.cooldownExpiryAt).toBe(new Date(earliestExpiryMs).toISOString());
        // cooldownExpiryAt is the absolute complement of the (still-present) relative sec.
        expect(typeof (miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBe('number');
      });

      it('surfaces cooldownEarliestRowId and teaches the SAME-id-vs-different-id distinction (EI-16519)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs: Date.now() + 300_000, earliestRowId: 'WI-9003' },
        });
        expect((miss as { cooldownEarliestRowId: string | null }).cooldownEarliestRowId).toBe('WI-9003');
        // Normal case preserved: re-poll after cooldownExpiryAt, do not re-author the spec.
        expect(miss.advice).toMatch(/re-poll/i);
        expect(miss.advice).toMatch(/cooldownExpiryAt/);
        expect(miss.advice).toMatch(/cooldownEarliestRowId/);
        expect(miss.advice).toMatch(/EI-16519/);
        // A bare advancing expiry alone is explicitly NOT treated as proof of a livelock —
        // that was EI-16475's finding (a MIN over multiple self-released rows legitimately
        // jumps forward as churn, with zero bug involved).
        expect(miss.advice).toMatch(/not.{0,40}by itself a livelock signal/i);
        expect(miss.advice).toMatch(/ordinary churn/i);
        // Escalation is now conditioned on the SAME id recurring, not on the number alone.
        expect(miss.advice).toMatch(/SAME id/);
        expect(miss.advice).toMatch(/EI-14615/);
      });

      it('cooldownExpiryAt is null-safe when earliestExpiryMs is null (defensive; WI-5303 makes it non-null in practice)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: null, earliestRowId: null },
        });
        expect(miss.cooldownOnly).toBe(true);
        expect(miss.cooldownExpiryAt).toBeNull();
        expect((miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBeNull();
      });

      it('a paused miss carries NO cooldownExpiryAt even if a cooldownDiag is passed (pause fully explains the miss)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          pausedReason: 'owner pause',
          cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000, earliestRowId: 'WI-9004' },
        });
        expect(miss.paused).toBe(true);
        expect(miss.cooldownExpiryAt).toBeUndefined();
      });
    });

    it('fleetScopedMiss keeps the ORIGINAL scope-mismatch message when cooldownDiag is null/absent (no false reattribution)', () => {
      const miss = fleetScopedMiss(cooldownScope, [], { cooldownDiag: null });
      expect(miss.cooldownOnly).toBeUndefined();
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });

    it('a paused miss NEVER reattributes to cooldown, even if a cooldownDiag is passed (pause explains the miss fully)', () => {
      const miss = fleetScopedMiss(cooldownScope, [], {
        pausedReason: 'owner pause',
        cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000, earliestRowId: 'WI-9005' },
      });
      expect(miss.paused).toBe(true);
      expect(miss.cooldownOnly).toBeUndefined();
      expect(miss.error).toMatch(/winding-down/);
    });
  });

  // WI-5561: scheduler:get_next's fleet-scoped miss path gave ZERO diagnosis when the
  // whole issue-family pool was floor-gated (federation-detector / needs-human /
  // claim-hold / observation-lane / …), leaving a fleet member (and the leader they'd
  // report a false "scope/spec bug" to) with nothing but a bare "no claimable
  // work-item matched fleet scope". diagnoseFleetScopeIssueFloorMiss reuses the exact
  // aggregateIssueClaimExclusions floor-breakdown the non-fleet miss path already gets
  // via buildMissDiagnosis; fleetScopedMiss surfaces it honestly instead of the bare
  // message.
  describe('WI-5561: issue-family floor-breakdown miss re-attribution', () => {
    const issueScope = {
      ownerId: 'su-member',
      fleetSlug: 'bug-drain-200k',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'bugs-rev1',
          revision: 1,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const floorGatedBreakdown = {
      matchedByFilter: 302,
      claimable: 0,
      excluded: {
        taken: 0,
        claimHold: 33,
        needsHuman: 80,
        observationLane: 21,
        externalBlocker: 0,
        planLaneReserved: 0,
        federationDetector: 169,
        loopNoise: 0,
        alreadyCompleted: 0,
        crossMachineRig: 0,
        blockedDep: 0,
        cooldown: 0,
        remoteOrigin: 0,
      },
    };

    it('returns the floor breakdown when the spec matches issue-family rows, threading harness/assignee/states/rigAvailable', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(floorGatedBreakdown);

      const diag = await diagnoseFleetScopeIssueFloorMiss({
        scope: issueScope,
        harness: 'papercusp',
        workspaceId: 'papercusp-workspace',
        rigAvailable: true,
      });

      expect(diag).toEqual(floorGatedBreakdown);
      const [filterArg, optsArg] = admissionMocks.aggregateIssueClaimExclusions.mock.calls[0] ?? [];
      expect(filterArg).toEqual(issueScope.record.spec.view.filter);
      expect(optsArg).toMatchObject({
        harness: 'papercusp',
        assignee: 'su-member',
        rigAvailable: true,
        states: ['open'],
      });
    });

    it('falls back to the spec\'s own `states` when no explicit states are passed', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(floorGatedBreakdown);
      await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      const optsArg = admissionMocks.aggregateIssueClaimExclusions.mock.calls[0]?.[1];
      expect(optsArg?.states).toEqual(['open']);
    });

    it('EI-18663622382734446: returns the breakdown (NOT null) when the filter matches zero issue-family rows — the spec-empty case must be distinguishable from a diagnosis failure', async () => {
      const zeroMatch = { matchedByFilter: 0, claimable: 0, excluded: floorGatedBreakdown.excluded };
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue(zeroMatch);
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(diag).toEqual(zeroMatch);
    });

    it('FAILS SOFT: a query error degrades to null, never throws (annotation only, like diagnoseFleetScopeCooldownMiss)', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockRejectedValue(new Error('pg unavailable'));
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(diag).toBeNull();
    });

    it('returns null when the workspace cannot be resolved (nothing to diagnose)', async () => {
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: null });
      expect(diag).toBeNull();
      expect(admissionMocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    });

    it('fleetScopedMiss surfaces excludedBreakdown + excludedBreakdownSummary + floor-gated advice when an issueBreakdown is present', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: floorGatedBreakdown });
      expect(miss.windDown).toBe(true);
      expect(miss.excludedBreakdown).toEqual(floorGatedBreakdown);
      expect(miss.excludedBreakdownSummary).toMatch(/federationDetector=169/);
      expect(miss.excludedBreakdownSummary).toMatch(/needsHuman=80/);
      expect(miss.excludedBreakdownSummary).toMatch(/claimHold=33/);
      expect(miss.excludedBreakdownSummary).toMatch(/observationLane=21/);
      // zero-count buckets are dropped from the summary, not padded in
      expect(miss.excludedBreakdownSummary).not.toMatch(/taken=0/);
      expect(miss.advice).toMatch(/FLOOR-GATED miss \(WI-5561/);
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
    });

    // EI-18741523426513509: `spec_matches_nothing` asserts a CAUSE (the spec's filter is wrong);
    // a floor-gated miss is an EFFECT (real rows matched, but every one is presently excluded by
    // a transient claim floor) with the OPPOSITE remedy — await/re-poll, never rewrite the spec.
    // These assert the two are named with distinct, machine-checkable reason tokens.
    it('EI-18741523426513509: sets reason `all_matches_gated` (NOT spec_matches_nothing) when the spec matched real rows but every one is floor-excluded', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: floorGatedBreakdown });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.error).toMatch(/POOL BLOCKED, NOT SPEC-BROKEN/);
      expect(miss.advice).toMatch(/reason: "all_matches_gated"/);
      // the advice explicitly disambiguates from spec_matches_nothing (a DIFFERENT reason token
      // with the opposite remedy) rather than ever claiming/escalating a spec-authoring bug itself
      expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW \(EI-18663622382734446\)/);
    });

    // The exact recurrence this ticket documents: a plan-lane `externalBlocker` gate (not any
    // other floor) is the sole reason every matched row is excluded — the member must still get
    // the transient token, not a spec-authoring escalation, and not a bare undefined reason.
    it('EI-18741523426513509 recurrence guard: an uncleared plan-lane externalBlocker gate (the live 2026-07-26 repro) returns `all_matches_gated`, never `spec_matches_nothing`', () => {
      const externalBlockerOnlyBreakdown = {
        matchedByFilter: 2,
        claimable: 0,
        excluded: {
          taken: 0,
          claimHold: 0,
          needsHuman: 0,
          observationLane: 0,
          externalBlocker: 2,
          planLaneReserved: 0,
          federationDetector: 0,
          loopNoise: 0,
          alreadyCompleted: 0,
          crossMachineRig: 0,
          blockedDep: 0,
          cooldown: 0,
          remoteOrigin: 0,
        },
      };
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: externalBlockerOnlyBreakdown });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.excludedBreakdownSummary).toMatch(/externalBlocker=2/);
      expect(miss.windDown).toBe(true);
    });

    it('fleetScopedMiss keeps the ORIGINAL scope-mismatch message + omits excludedBreakdown when issueBreakdown is null/absent', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: null });
      expect(miss.excludedBreakdown).toBeUndefined();
      expect(miss.excludedBreakdownSummary).toBeUndefined();
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });

    it('a paused miss NEVER surfaces the floor breakdown, even if an issueBreakdown is passed (pause explains the miss fully)', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: floorGatedBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.excludedBreakdown).toBeUndefined();
      expect(miss.error).toMatch(/winding-down/);
    });

    it('a cooldown-only miss and a floor breakdown can co-occur (both are independent, non-paused annotations)', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-9010' },
        issueBreakdown: floorGatedBreakdown,
      });
      expect(miss.cooldownOnly).toBe(true);
      expect(miss.excludedBreakdown).toEqual(floorGatedBreakdown);
      // cooldown's message takes precedence when both are present (fleetScopedMiss's
      // `error` branches on cooldown before breakdown), but the breakdown data itself
      // still rides along on the response for the caller to inspect.
      expect(miss.error).toMatch(/YOUR OWN release-cooldown floor/);
    });
  });

  // EI-18663622382734446: a claim-spec that matches ZERO rows is indistinguishable from a
  // drained queue at the member's end unless fleetScopedMiss names the case loudly. Live
  // incident: spec `p2p-release-lane@8` matched 0 of 1250 rows for 4.5h while two members
  // separately, in good faith, reported "floor-gated, not a spec bug" — because the miss they
  // could actually observe (windDown:true, a bare message) is the SAME shape a genuine drain
  // produces. These tests assert the zero-match case gets its own loud, escalate-worthy shape.
  describe('EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain', () => {
    // EI-19393442073558754: deliberately an ID-ALLOWLIST filter, NOT a plan-scoped one —
    // a plan/plan-item predicate now gets the softer `nonIssueSpecEmpty` framing (see
    // that describe block below), since a plan-scoped spec can correctly, structurally
    // admit ONLY feature-family rows for long stretches (D-009). A stale id allowlist has
    // no such family correlation, so it stays a genuine, loudly-named spec-authoring bug.
    const issueScope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-lane',
          revision: 8,
          view: { filter: { field: 'id', op: 'in' as const, value: ['WI-9001', 'WI-9002'] } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const zeroMatchBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      excluded: {
        taken: 0,
        claimHold: 0,
        needsHuman: 0,
        observationLane: 0,
        externalBlocker: 0,
        planLaneReserved: 0,
        federationDetector: 0,
        loopNoise: 0,
        alreadyCompleted: 0,
        crossMachineRig: 0,
        blockedDep: 0,
        cooldown: 0,
        remoteOrigin: 0,
      },
    };

    it('sets a distinct top-level reason + loud error + escalate advice, but still windDown:true (correct to stop pulling)', () => {
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });
      expect(miss.reason).toBe('spec_matches_nothing');
      // EI-18741523426513509: a genuinely empty spec (matchedByFilter === 0) must never also
      // carry the floor-gated token — the two are mutually exclusive by construction (floorGated
      // requires matchedByFilter > 0).
      expect(miss.reason).not.toBe('all_matches_gated');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/spec_matches_nothing/);
      expect(miss.excludedBreakdown).toEqual(zeroMatchBreakdown);
      // The old (pre-fix) summary text actively said the OPPOSITE of the truth for this case
      // ("not a scope/spec bug — re-authoring the claim spec will not help"); assert it is gone.
      expect(miss.excludedBreakdownSummary).not.toMatch(/re-authoring the claim spec will not help/);
      expect(miss.excludedBreakdownSummary).toMatch(/SPEC ITSELF is the problem/);
    });

    it('EI-20186990913643457: reports successful exhaustion when every status-floor-free match is terminal', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 2 },
      });

      expect(miss.reason).toBe('spec_exhausted');
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/SPEC EXHAUSTED/);
      expect(miss.error).toMatch(/successful drain/);
      expect(miss.error).not.toMatch(/ESCALATE/);
      expect(miss.advice).toMatch(/LANE COMPLETE/);
      expect(miss.advice).toMatch(/Do NOT escalate, widen, or re-author/);
      expect(miss.excludedBreakdownSummary).toMatch(/all 2 are terminal/);
      expect((miss as { terminalExhaustion?: unknown }).terminalExhaustion).toEqual({
        matchedByFilter: 2,
        terminalMatchedByFilter: 2,
      });
    });

    it('keeps the spec-authoring verdict when the status-floor-free matches are mixed terminal and active', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        issueBreakdown: zeroMatchBreakdown,
        terminalExhaustion: { matchedByFilter: 2, terminalMatchedByFilter: 1 },
      });

      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/ESCALATE to your fleet leader NOW/);
      expect(miss.advice).toMatch(/spec_matches_nothing/);
    });

    it('is mutually exclusive with the divergent (claim-path bug) case by construction', () => {
      // divergent requires claimable > 0, which cannot coexist with matchedByFilter === 0
      // (claimable is a subset of matchedByFilter) — assert the miss never claims both.
      const miss = fleetScopedMiss(issueScope, [], { issueBreakdown: zeroMatchBreakdown });
      expect(miss.error).not.toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
    });

    it('a paused miss suppresses specEmpty just like every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroMatchBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
      expect(miss.excludedBreakdown).toBeUndefined();
    });

    it('cooldown never masks specEmpty — a truly empty spec takes precedence in the error/advice', () => {
      const miss = fleetScopedMiss(issueScope, [], {
        cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-1' },
        issueBreakdown: zeroMatchBreakdown,
      });
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.error).toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.advice).toMatch(/ESCALATE to your fleet leader NOW/);
    });
  });

  // WI-7151 (EI-19318364531323846): a plan-scoped spec whose promoted items are feature-family
  // (D-009 — every plans:start promotion mints one) made the issue-family-only breakdown above
  // report a confident `matchedByFilter: 0` and therefore `reason: 'spec_matches_nothing'` +
  // `windDown: true` even when real, unclaimed, spec-matching feature-family rows exist. These
  // pin the fix: a positive `featureFamilyMatched` suppresses `specEmpty` entirely and reports
  // the honest, non-drain, non-spec-authoring verdict instead.
  describe('WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot)', () => {
    const planScope = {
      ownerId: 'su-member',
      fleetSlug: 'opencode-omp-research',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'fleet-launch-opencode-omp-research-plan',
          revision: 1,
          view: { filter: { field: 'plan', op: '=' as const, value: 'opencode-omp-token-reduction-research-2026-08-02' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 1,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    const zeroIssueFamilyBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      excluded: {
        taken: 0,
        claimHold: 0,
        needsHuman: 0,
        observationLane: 0,
        externalBlocker: 0,
        planLaneReserved: 0,
        federationDetector: 0,
        loopNoise: 0,
        alreadyCompleted: 0,
        crossMachineRig: 0,
        blockedDep: 0,
        cooldown: 0,
        remoteOrigin: 0,
      },
    };

    it('suppresses specEmpty/spec_matches_nothing when a tier-1 (feature-family) match exists', () => {
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.reason).toBe('issue_family_diagnosis_blind_spot');
      expect((miss as { featureFamilyMatched?: number }).featureFamilyMatched).toBe(8);
      expect(miss.error).toMatch(/ISSUE-FAMILY DIAGNOSIS BLIND SPOT/);
      expect(miss.error).not.toMatch(/SPEC-AUTHORING problem/);
      // A real candidate exists — the member must NOT stand down.
      expect(miss.windDown).toBe(false);
      expect(miss.advice).toMatch(/PULL AGAIN/);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW \(EI-18663622382734446\)/);
      expect(miss.excludedBreakdownSummary).toMatch(/8 FEATURE-family row/);
    });

    // EI-19393442073558754: this used to fall back to `spec_matches_nothing` (asserted as
    // "no behavior change") — that was itself the false-alarm class this ticket fixes.
    // `planScope`'s filter references `plan` and carries no kind restriction, so a
    // non-positive featureFamilyMatched must NOT be reported as a spec-authoring bug —
    // it is an ordinary drain (still windDown:true — correct to stop pulling — just not
    // framed as "your spec is broken, escalate now").
    it('reports `ordinary_drain` (never spec_matches_nothing) when featureFamilyMatched confirms the tier-1 pool is ALSO empty (0)', () => {
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      expect(miss.reason).toBe('ordinary_drain');
      expect(miss.reason).not.toBe('spec_matches_nothing');
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/ORDINARY DRAIN/);
      expect(miss.error).not.toMatch(/SPEC MATCHES NOTHING/);
      expect(miss.error).toMatch(/genuinely empty right now/);
      expect((miss as { featureFamilyMatched?: number | null }).featureFamilyMatched).toBe(0);
      expect(miss.advice).not.toMatch(/ESCALATE to your fleet leader NOW/);
    });

    it('reports `ordinary_drain` (never spec_matches_nothing) when featureFamilyMatched is unavailable (null/undefined)', () => {
      for (const fam of [null, undefined] as const) {
        const miss = fleetScopedMiss(planScope, [], {
          issueBreakdown: zeroIssueFamilyBreakdown,
          featureFamilyMatched: fam,
        });
        expect(miss.reason).toBe('ordinary_drain');
        expect(miss.windDown).toBe(true);
        expect(miss.error).toMatch(/ORDINARY DRAIN/);
        expect(miss.error).toMatch(/could not be confirmed/);
        expect((miss as { featureFamilyMatched?: number | null }).featureFamilyMatched).toBeNull();
      }
    });

    it('a paused miss suppresses the feature-family verdict too, same as every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(planScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
    });

    it('a paused miss suppresses `ordinary_drain` too, same as every other breakdown-derived signal', () => {
      const miss = fleetScopedMiss(planScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      expect(miss.paused).toBe(true);
      expect(miss.reason).toBeUndefined();
    });

    it('has no effect on a non-zero issueBreakdown.matchedByFilter (only relevant to the matchedByFilter===0 case)', () => {
      // A caller should never pass featureFamilyMatched alongside a nonzero matchedByFilter in
      // practice (get_next.ts only computes it when matchedByFilter===0) — but the guard itself
      // must still be inert here rather than accidentally suppressing an unrelated floorGated verdict.
      const floorGatedBreakdown = { ...zeroIssueFamilyBreakdown, matchedByFilter: 5, claimable: 0 };
      const miss = fleetScopedMiss(planScope, [], {
        issueBreakdown: floorGatedBreakdown,
        featureFamilyMatched: 8,
      });
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.reason).not.toBe('issue_family_diagnosis_blind_spot');
    });
  });

  // EI-19393442073558754: the narrower scoping of `nonIssueSpecEmpty`/`ordinary_drain` —
  // gated specifically on a `plan`/`plan_item` predicate (D-009's documented family
  // correlation), NOT on "any filter lacking a kind restriction". Pins the two edge cases
  // the plan-predicate heuristic must get right: a NESTED plan predicate is still detected,
  // and an explicit issue-family kind restriction on a plan-scoped spec overrides it back to
  // the loud `spec_matches_nothing` (that spec really can only ever match the issue family,
  // so a genuine 0 there really is a spec-authoring signal).
  describe('EI-19393442073558754: plan-predicate scoping edge cases', () => {
    const zeroIssueFamilyBreakdown = {
      matchedByFilter: 0,
      claimable: 0,
      excluded: {
        taken: 0,
        claimHold: 0,
        needsHuman: 0,
        observationLane: 0,
        externalBlocker: 0,
        planLaneReserved: 0,
        federationDetector: 0,
        loopNoise: 0,
        alreadyCompleted: 0,
        crossMachineRig: 0,
        blockedDep: 0,
        cooldown: 0,
        remoteOrigin: 0,
      },
    };

    function scopeWithFilter(filter: FilterNode) {
      return {
        ownerId: 'su-member',
        fleetSlug: 'test-fleet',
        fleetRole: 'member' as const,
        workspaceId: 'papercusp-workspace',
        record: {
          source: 'fleet' as const,
          spec: {
            specVersion: '1.0',
            specId: 'test-spec',
            revision: 1,
            view: { filter },
            rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          },
          revision: 1,
          updatedBy: 'su-leader',
          updatedAt: 'now',
        },
      };
    }

    it('detects a plan predicate NESTED inside an `all` (not just a bare top-level leaf)', () => {
      const nestedScope = scopeWithFilter({
        all: [
          { field: 'harness', op: '=' as const, value: 'papercusp' },
          { field: 'plan', op: '=' as const, value: 'some-plan' },
        ],
      });
      const miss = fleetScopedMiss(nestedScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      expect(miss.reason).toBe('ordinary_drain');
    });

    it('detects `plan_item` (not just `plan`) as the family-correlated field', () => {
      const planItemScope = scopeWithFilter({ field: 'plan_item', op: '=' as const, value: 'P-001' });
      const miss = fleetScopedMiss(planItemScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      expect(miss.reason).toBe('ordinary_drain');
    });

    it('an explicit issue-family kind restriction on a plan-scoped spec overrides back to spec_matches_nothing', () => {
      const kindRestrictedPlanScope = scopeWithFilter({
        all: [
          { field: 'plan', op: '=' as const, value: 'some-plan' },
          { field: 'kind', op: 'in' as const, value: ['bug', 'change', 'task'] },
        ],
      });
      const miss = fleetScopedMiss(kindRestrictedPlanScope, [], {
        issueBreakdown: zeroIssueFamilyBreakdown,
        featureFamilyMatched: 0,
      });
      // This spec can ONLY ever match the issue family (its own kind leaf says so), so a
      // confirmed-empty tier-1 count doesn't matter — the issue-family zero really is the
      // whole story, and really is a genuine spec-authoring signal.
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.reason).not.toBe('ordinary_drain');
      expect(miss.windDown).toBe(true);
    });

    it('a filter with NO plan/plan_item predicate anywhere (id-only) keeps the loud spec_matches_nothing verdict', () => {
      const idOnlyScope = scopeWithFilter({ field: 'id', op: 'in' as const, value: ['WI-1', 'WI-2'] });
      const miss = fleetScopedMiss(idOnlyScope, [], { issueBreakdown: zeroIssueFamilyBreakdown });
      expect(miss.reason).toBe('spec_matches_nothing');
      expect(miss.reason).not.toBe('ordinary_drain');
    });
  });

  // EI-18666093519248020: the INVARIANT behind the four recurrences of the claim-path/read-path
  // divergence class (EI-10062 -> WI-4309 -> WI-5275 -> WI-5822). Each was a different way for the
  // claim path's narrowing to diverge from the spec filter; each surfaced to members as
  // `windDown:true` + "FLOOR-GATED miss ... checkpoint, release, loop:end" while their lane still
  // had claimable rows. The mechanism kept getting fixed; the invariant was never asserted, so
  // recurrence #4 was as invisible as #1 — found only when a member hand-compared a get_next miss
  // against work_items:claimable and saw `claimable: 19` inside the very response telling it to
  // stand down. These tests assert that a miss can never again certify a drain the oracle contradicts.
  describe('EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain', () => {
    const divergentScope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-lane',
          revision: 9,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
          states: ['open'],
        },
        revision: 9,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    // The live reproduction, verbatim from the 2026-07-26 p2p-release pull that found this:
    // 22 rows matched the spec filter, 19 survived every floor, and get_next still reported
    // windDown + floor-gated. A by-id claim on one of the 19 then succeeded.
    const divergentBreakdown = {
      matchedByFilter: 22,
      claimable: 19,
      excluded: {
        taken: 0,
        claimHold: 1,
        needsHuman: 1,
        observationLane: 0,
        externalBlocker: 0,
        planLaneReserved: 0,
        federationDetector: 0,
        loopNoise: 0,
        alreadyCompleted: 0,
        crossMachineRig: 0,
        blockedDep: 0,
        cooldown: 1,
        remoteOrigin: 0,
      },
    };

    // WI-5947: a survivor count alone is only a SUSPICION — it is read after the claim attempt,
    // so lane churn reproduces it with a healthy claim path. The loud divergence verdict is now
    // gated on the caller having CONFIRMED it by re-asking the claim path. These cases all
    // describe that confirmed shape; the unconfirmed shape is covered in its own block below.
    const confirmed = { issueBreakdown: divergentBreakdown, divergenceRecheck: 'confirmed-twice' as const };

    it('does NOT set windDown when the oracle still reports claimable rows (the harmful half)', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.windDown).toBe(false);
    });

    it('names the divergence in `error` instead of claiming the scope matched nothing', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.error).toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
      expect(miss.error).toMatch(/19 of 22/);
      expect(miss.error).toMatch(/NOT drained and NOT floor-gated/);
      // the old bare message must NOT be what a diverging member is told
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      // WI-5947: and it must say WHY this is not just churn, or the reader cannot weigh it
      expect(miss.error).toMatch(/CONFIRMED across TWO claim attempts/);
    });

    it('advice tells the member to keep working (claim by id) and to report a claim-path bug — never to stand down', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.advice).toMatch(/DO NOT STAND DOWN/);
      expect(miss.advice).toMatch(/work_items:claimable/);
      expect(miss.advice).toMatch(/work_items:claim/);
      expect(miss.advice).toMatch(/CLAIM-PATH BUG/);
      // must not carry the floor-gated stand-down instruction
      expect(miss.advice).not.toMatch(/FLOOR-GATED miss \(WI-5561\)/);
      expect(miss.advice).not.toMatch(/loop:end/);
    });

    it('WI-5947: the report instruction is framed as an observation to re-verify, not a settled diagnosis', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      // the reader must be told to quote the CONFIRMATION, since that is what separates a real
      // divergence from churn — a bare claimable count is exactly what produced false reports
      expect(miss.advice).toMatch(/confirmed-twice/);
      expect(miss.advice).toMatch(/not as a settled\s+diagnosis|not as a settled diagnosis/);
      // the old text pre-supplied an excuse for why a maintainer could not reproduce it
      // ("it just has not DEPLOYED yet"), which insulated a false report from correction
      expect(miss.advice).not.toMatch(/has not DEPLOYED yet/);
      expect(miss.advice).not.toMatch(/pre-fix release checkout/);
    });

    it('WI-5947: warns that the by-id workaround can itself return an empty list under churn', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      // the advice routes through work_items:claimable, whose row list is read separately from
      // its count — so under the same churn it can come back empty and read as "broken too"
      expect(miss.advice).toMatch(/EMPTY under a churning lane/);
      expect(miss.advice).toMatch(/WI-5947/);
    });

    it('the breakdown summary says the pool is NOT floor-gated, so the floor counts are not misread as the cause', () => {
      const miss = fleetScopedMiss(divergentScope, [], confirmed);
      expect(miss.excludedBreakdown).toEqual(divergentBreakdown);
      expect(miss.excludedBreakdownSummary).toMatch(/NOT floor-gated/);
      expect(miss.excludedBreakdownSummary).toMatch(/19 of them survive ALL floors/);
      expect(miss.excludedBreakdownSummary).not.toMatch(/genuinely floor-gated/);
    });

    it('a divergence outranks a cooldown re-attribution (never renders as do-not-escalate cooldown noise)', () => {
      const miss = fleetScopedMiss(divergentScope, [], {
        cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: Date.now() + 5_000, earliestRowId: 'WI-9011' },
        ...confirmed,
      });
      expect(miss.windDown).toBe(false);
      expect(miss.error).toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
      expect(miss.advice).toMatch(/DO NOT STAND DOWN/);
    });

    // WI-5947 — the regression this fix exists for. An UNCONFIRMED survivor reading (the shape
    // every caller produced before the re-check existed, and the shape a degraded retry still
    // produces) must NOT be dressed up as a claim-path defect: that is what sent agents to file
    // fabricated bugs against healthy code, carrying what looked like a clean reproduction.
    describe('WI-5947 — survivors reported but NOT confirmed by a second claim attempt', () => {
      it('does not pronounce a divergence, and does not tell anyone to file a claim-path bug', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.error).not.toMatch(/CLAIM-PATH\/READ-PATH DIVERGENCE/);
        expect(miss.advice).not.toMatch(/CLAIM-PATH BUG/);
        expect(miss.advice).not.toMatch(/EI-10062/);
      });

      it('still refuses to certify a drain — an unconfirmed reading is not evidence of an empty lane', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.windDown).toBe(false);
      });

      it('names the real likely cause (the pool moved) and gives the one useful action: pull again', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.error).toMatch(/POOL CHANGED UNDER YOU/);
        expect(miss.error).toMatch(/19 of 22/);
        expect(miss.advice).toMatch(/PULL AGAIN/);
        expect(miss.advice).toMatch(/scheduler:get_next again/);
        // and must not push the member toward the two wrong remedies
        expect(miss.advice).not.toMatch(/re-author the claim spec\b(?!.*do NOT)/);
        expect(miss.advice).not.toMatch(/loop:end/);
      });

      it('stamps the provenance so a relayed report carries its own confidence level', () => {
        const unconfirmed = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect((unconfirmed as { divergenceRecheck?: string }).divergenceRecheck).toBe('unconfirmed');
        const conf = fleetScopedMiss(divergentScope, [], confirmed);
        expect((conf as { divergenceRecheck?: string }).divergenceRecheck).toBe('confirmed-twice');
        // absent entirely when there were no survivors to be suspicious about
        const drained = fleetScopedMiss(divergentScope, [], { issueBreakdown: { ...divergentBreakdown, claimable: 0 } });
        expect((drained as { divergenceRecheck?: string }).divergenceRecheck).toBeUndefined();
      });

      it('the breakdown summary frames the survivors as a later instant, not a floor story', () => {
        const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: divergentBreakdown });
        expect(miss.excludedBreakdownSummary).toMatch(/the pool moved/);
        expect(miss.excludedBreakdownSummary).not.toMatch(/genuinely floor-gated/);
      });
    });

    // The other side of the guard: a GENUINE floor-gated drain must be untouched, or the fix
    // would trade a false stand-down for a fleet that never stands down at all.
    it('claimable === 0 keeps the existing floor-gated verdict verbatim (windDown + stand-down advice)', () => {
      const genuinelyDrained = { ...divergentBreakdown, claimable: 0 };
      const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: genuinelyDrained });
      expect(miss.windDown).toBe(true);
      // EI-18741523426513509: this shape (matchedByFilter > 0, claimable === 0, not
      // divergent/unconfirmed/paused/cooldown) is exactly the floor-gated case, which now gets
      // its own named reason + error instead of the old generic "no claimable work-item matched"
      // message that was indistinguishable-by-shape from a diagnosis failure.
      expect(miss.reason).toBe('all_matches_gated');
      expect(miss.error).toMatch(/POOL BLOCKED, NOT SPEC-BROKEN/);
      expect(miss.advice).toMatch(/FLOOR-GATED miss \(WI-5561/);
      expect(miss.excludedBreakdownSummary).toMatch(/genuinely floor-gated/);
      expect(miss.excludedBreakdownSummary).not.toMatch(/NOT floor-gated/);
    });

    it('a PAUSED fleet still stands down even though a divergent breakdown was passed (pause is a real stand-down)', () => {
      const miss = fleetScopedMiss(divergentScope, [], {
        pausedReason: 'owner pause',
        issueBreakdown: divergentBreakdown,
      });
      expect(miss.paused).toBe(true);
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/winding-down/);
      expect(miss.excludedBreakdown).toBeUndefined();
    });

    it('a miss with NO breakdown at all is unchanged (windDown, original message)', () => {
      const miss = fleetScopedMiss(divergentScope, [], { issueBreakdown: null });
      expect(miss.windDown).toBe(true);
      expect(miss.error).toMatch(/NOT allowed to fall through to the generic backlog/);
    });
  });

  // EI-18221674485894260: a fleet-scope refusal must POINT AT the concrete widen tool
  // (scheduler:set_claim_spec) so a leader never has to hunt a tool ToolSearch/tools:find
  // failed to surface. The prior body said only "Re-steer the member's claim spec" —
  // naming neither the tool nor the call shape.
  describe('EI-18221674485894260: fleet-scope refusal names the one-call widen action', () => {
    const scope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release-verify',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-verify-lane',
          revision: 20,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 20,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };
    const violation: Extract<FleetScopeAdmission, { allowed: false }> = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'work-item WI-5700 does not match p2p-release-verify-lane@20 for fleet \'p2p-release-verify\'',
      scope,
    };

    it('fleetScopeLeaderRemedy names scheduler:set_claim_spec, the fleet slug, and the current spec ref (unambiguous, not "@N") for a scope violation', () => {
      const remedy = fleetScopeLeaderRemedy(violation);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/fleet: "p2p-release-verify"/);
      // EI-18676258006299036: "<specId>@<revision>" reads as a size/replica count in ops
      // tooling — a member misread it as a live-member count. Render unambiguously instead.
      expect(remedy).toMatch(/p2p-release-verify-lane \(spec rev 20\)/);
      expect(remedy).not.toMatch(/p2p-release-verify-lane@20/);
      // A live scope violation is NOT a pause — it must never route the leader at fleet:resume.
      expect(remedy).not.toMatch(/fleet:resume/);
    });

    it('fleetScopeLeaderRemedy routes a fleet_winding_down refusal at fleet:resume, NOT a spec widen', () => {
      const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        code: 'fleet_winding_down',
        reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
      };
      const remedy = fleetScopeLeaderRemedy(paused);
      expect(remedy).toMatch(/fleet:resume \{ fleet: "p2p-release-verify" \}/);
      // Widening a PAUSED fleet's spec would recruit a member that must be standing down.
      expect(remedy).not.toMatch(/scheduler:set_claim_spec/);
    });

    it('fleetScopeLeaderRemedy still names the widen tool for a fleet_scope_missing (no authored spec) refusal', () => {
      const missing: Extract<FleetScopeAdmission, { allowed: false }> = {
        allowed: false,
        scoped: true,
        code: 'fleet_scope_missing',
        reason: 'fleet member su-member belongs to \'p2p-release-verify\' but has no explicit spec',
        scope: { ...scope, record: { ...scope.record, source: 'default' as const } },
      };
      const remedy = fleetScopeLeaderRemedy(missing);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/fleet: "p2p-release-verify"/);
    });

    it('notifyFleetScopeRefusal sends the leader a body carrying the factual reason AND the concrete widen action', async () => {
      await notifyFleetScopeRefusal(
        { ownerId: 'su-member' } as never,
        violation,
        'work_items:claim WI-5700 → su-member',
      );
      expect(admissionMocks.sendMessage).toHaveBeenCalledOnce();
      const payload = admissionMocks.sendMessage.mock.calls[0]?.[1] as { to: string[]; summary: string; body: string; category: string };
      expect(payload.to).toEqual(['@fleet-leader:p2p-release-verify']);
      expect(payload.category).toBe('fleet-scope-admission');
      // The factual mismatch is preserved…
      expect(payload.body).toMatch(/does not match p2p-release-verify-lane@20/);
      // …AND the leader now gets the one-call widen action instead of "re-steer somehow".
      expect(payload.body).toMatch(/scheduler:set_claim_spec/);
      expect(payload.body).not.toMatch(/Re-steer the member's claim spec or route the work elsewhere\./);
    });
  });

  // WI-6326 (residual half of EI-18784357226895330): "route the work elsewhere" named an
  // exit with no liveness check — a refused member found the fleet was themself plus one
  // idle member and had to escalate by hand. hasLiveFleetRouteTarget + the code-conditional
  // remedy text close that gap.
  describe('WI-6326: the "route elsewhere" exit is code-conditional on a real presence read', () => {
    const scope = {
      ownerId: 'su-member',
      fleetSlug: 'p2p-release-verify',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'p2p-release-verify-lane',
          revision: 20,
          view: { filter: { field: 'kind', op: '=' as const, value: 'bug' } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 20,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };
    const violation: Extract<FleetScopeAdmission, { allowed: false }> = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'work-item WI-5700 does not match p2p-release-verify-lane@20 for fleet \'p2p-release-verify\'',
      scope,
    };

    describe('hasLiveFleetRouteTarget', () => {
      it('reports false when every OTHER row in the fleet is present-but-not-alive or absent', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-leader', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: false },
        ]);
        // Excludes the caller itself (su-member) — the question is whether ANYONE ELSE
        // can receive routed work, not whether the caller is alive (it obviously is).
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(false);
      });

      it('reports true when another member/leader in the fleet is present and alive', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-other', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
        ]);
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(true);
      });

      it('ignores rows from a DIFFERENT fleet', async () => {
        admissionMocks.listFleetAssignments.mockResolvedValue([
          { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-other', fleetSlug: 'some-other-fleet', holderPresent: true, holderAlive: true },
        ]);
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBe(false);
      });

      it('degrades to null (unknown) on a lookup failure rather than a false negative', async () => {
        admissionMocks.listFleetAssignments.mockRejectedValue(new Error('pg unavailable'));
        await expect(hasLiveFleetRouteTarget('p2p-release-verify', 'papercusp-workspace', 'su-member')).resolves.toBeNull();
      });
    });

    describe('fleetScopeLeaderRemedy liveRouteTarget wiring', () => {
      it('keeps the original unconditional wording when a live target exists', () => {
        const remedy = fleetScopeLeaderRemedy(violation, true);
        expect(remedy).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
      });

      it('keeps the original unconditional wording when liveness is UNKNOWN (null/undefined) — never asserts a false negative', () => {
        expect(fleetScopeLeaderRemedy(violation, null)).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
        expect(fleetScopeLeaderRemedy(violation)).toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
      });

      it('replaces the "route elsewhere" exit with an honest closed-exit statement + the ledger fallback when no live target exists', () => {
        const remedy = fleetScopeLeaderRemedy(violation, false);
        expect(remedy).not.toMatch(/\(Or route the work elsewhere \/ complete it yourself\.\)/);
        expect(remedy).toMatch(/Do NOT rely on "route the work elsewhere"/);
        expect(remedy).toMatch(/no other live agent/);
        expect(remedy).toMatch(/stays filed, unassigned, on the ledger/);
        // The widen action is still named regardless — that exit was never closed.
        expect(remedy).toMatch(/scheduler:set_claim_spec/);
      });

      it('never applies the liveness note to a fleet_winding_down refusal (that branch never mentions "route elsewhere")', () => {
        const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
          ...violation,
          code: 'fleet_winding_down',
          reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
        };
        const remedy = fleetScopeLeaderRemedy(paused, false);
        expect(remedy).toMatch(/fleet:resume/);
        expect(remedy).not.toMatch(/Do NOT rely on "route the work elsewhere"/);
      });
    });

    it('notifyFleetScopeRefusal returns the liveRouteTarget verdict AND reflects it in the leader message body', async () => {
      // Only the refused member itself (the excluded owner) is present in the fleet —
      // the exact repro shape (fleet was themself plus one idle member).
      admissionMocks.listFleetAssignments.mockResolvedValue([
        { source: 'presence', workspaceId: 'papercusp-workspace', agentId: 'su-member', fleetSlug: 'p2p-release-verify', holderPresent: true, holderAlive: true },
      ]);
      const result = await notifyFleetScopeRefusal(
        { ownerId: 'su-member' } as never,
        violation,
        'work_items:claim WI-5700 → su-member',
      );
      // EI-19484346966003625 (R1): `classRefusal` is null because no `harness` was passed —
      // the class reading is opt-in per call site, so a caller that cannot name a harness
      // gets exactly the pre-change behaviour rather than a partial or guessed diagnosis.
      // Kept as an EXACT shape assertion on purpose: it is what caught this field's arrival.
      expect(result).toEqual({ liveRouteTarget: false, classRefusal: null });
      const payload = admissionMocks.sendMessage.mock.calls[0]?.[1] as { body: string };
      expect(payload.body).toMatch(/Do NOT rely on "route the work elsewhere"/);
      expect(payload.body).not.toContain('CLASS REFUSAL');
    });

    it('notifyFleetScopeRefusal skips the liveness lookup entirely for a fleet_winding_down refusal', async () => {
      const paused: Extract<FleetScopeAdmission, { allowed: false }> = {
        ...violation,
        code: 'fleet_winding_down',
        reason: 'fleet \'p2p-release-verify\' is winding-down (paused)',
      };
      const result = await notifyFleetScopeRefusal({ ownerId: 'su-member' } as never, paused, 'work_items:claim WI-5700 → su-member');
      // EI-19484346966003625 (R1): a PAUSED fleet skips the class reading too, and for the
      // same reason it skips the liveness lookup — its remedy is "stand down", so a class
      // diagnosis could only ever argue for a spec widen the member must not act on.
      expect(result).toEqual({ liveRouteTarget: null, classRefusal: null });
      expect(admissionMocks.listFleetAssignments).not.toHaveBeenCalled();
    });
  });

  // EI-18674160393981819: a harness-scoped fleet's claim spec typically narrows on
  // kind/plan/tags only — harness scoping comes from the caller's OWN `args.harness`, never
  // from a spec leaf (the claimable payload's `harness` field is payload-only per
  // claim-spec-payload-filter.ts). Without folding the caller's harness into the derived
  // payload_filter, the miss advice recommended an events:await that fired on every OTHER
  // harness's claimable bug too (observed live: a papercusp-scoped fleet woken by an
  // oddsmith-hive bug). fleetScopedMiss must AND the caller's harness into `payloadFilter`
  // whenever it is passed, regardless of what the spec's own view.filter narrows on.
  describe('EI-18674160393981819: payloadFilter is scoped to the caller\'s own harness', () => {
    const kindOnlyScope = {
      ownerId: 'su-member',
      fleetSlug: 'nonp2p-bug-drain',
      fleetRole: 'member' as const,
      workspaceId: 'papercusp-workspace',
      record: {
        source: 'fleet' as const,
        spec: {
          specVersion: '1.0',
          specId: 'nonp2p-bug-drain-0725',
          revision: 5,
          view: { filter: { field: 'kind' as const, op: 'in' as const, value: ['bug'] } },
          rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
        },
        revision: 5,
        updatedBy: 'su-leader',
        updatedAt: 'now',
      },
    };

    it('ANDs the caller harness into a spec-derived payloadFilter (kind-only spec, the real nonp2p-bug-drain shape)', () => {
      const miss = fleetScopedMiss(kindOnlyScope, [], { harness: 'papercusp' });
      expect(miss.payloadFilter).toEqual({
        all: [{ harness: { equals: 'papercusp' } }, { kind: { in: ['bug'] } }],
      });
    });

    it('falls back to a harness-only filter when the spec narrows on nothing payload-filterable', () => {
      const noFilterScope = {
        ...kindOnlyScope,
        record: {
          ...kindOnlyScope.record,
          spec: { ...kindOnlyScope.record.spec, view: {} },
        },
      };
      const miss = fleetScopedMiss(noFilterScope, [], { harness: 'papercusp' });
      expect(miss.payloadFilter).toEqual({ all: [{ harness: { equals: 'papercusp' } }] });
    });

    it('omits payloadFilter entirely when no harness is known AND the spec narrows on nothing payload-filterable (no unsound narrowing)', () => {
      const noFilterScope = {
        ...kindOnlyScope,
        record: {
          ...kindOnlyScope.record,
          spec: { ...kindOnlyScope.record.spec, view: {} },
        },
      };
      const miss = fleetScopedMiss(noFilterScope, []);
      expect(miss.payloadFilter).toBeUndefined();
    });

    it('a cross-harness claimable event never matches the derived filter (the actual regression: an oddsmith-hive bug woke a papercusp fleet)', async () => {
      const { evaluateDataCondition } = await import('@papercusp/rules');
      const miss = fleetScopedMiss(kindOnlyScope, [], { harness: 'papercusp' });
      const crossHarnessPayload = { id: 'WI-5854', kind: 'bug', harness: 'oddsmith-hive' };
      const sameHarnessPayload = { id: 'WI-1', kind: 'bug', harness: 'papercusp' };
      expect(evaluateDataCondition(miss.payloadFilter!, crossHarnessPayload)).toBe(false);
      expect(evaluateDataCondition(miss.payloadFilter!, sameHarnessPayload)).toBe(true);
    });
  });
});

/**
 * EI-18862608742257943: itemMatchesRawClaimSpec — the SAME feature/issue-family branch
 * as the private itemMatchesScope (exercised above via admitWorkItemForFleetTarget), but
 * against a RAW ClaimSpec with no live FleetScopeContext/fleet-membership required. This
 * is what lets fleet:launch-on-plan check, BEFORE any member has joined a brand-new
 * fleet, whether the claim spec it is about to apply actually admits a work-item its own
 * kickoff brief names.
 */
describe('itemMatchesRawClaimSpec (EI-18862608742257943 — pre-launch kickoff-vs-spec check)', () => {
  beforeEach(() => {
    admissionMocks.sql.mockReset();
  });

  const issueSpec: ClaimSpecRecord['spec'] = {
    specVersion: '1.0',
    specId: 'nonp2p-bugs',
    revision: 6,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it('matches an issue-family item purely (no SQL call) when its kind is in-spec', async () => {
    const item = {
      id: 'WI-6502',
      family: 'issue',
      kind: 'bug',
      title: 'A bug',
      summary: '',
      state: 'open',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    await expect(itemMatchesRawClaimSpec(item, issueSpec, 'papercusp-workspace')).resolves.toBe(true);
    expect(admissionMocks.sql).not.toHaveBeenCalled();
  });

  it('does NOT match an issue-family item whose kind is outside the spec (the exact live repro shape)', async () => {
    const item = {
      id: 'WI-9',
      family: 'issue',
      kind: 'task',
      title: 'A task',
      summary: '',
      state: 'open',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    const taskLessSpec: ClaimSpecRecord['spec'] = {
      ...issueSpec,
      view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } },
    };
    await expect(itemMatchesRawClaimSpec(item, taskLessSpec, 'papercusp-workspace')).resolves.toBe(false);
  });

  it('routes a feature-family item through the SQL EXISTS check, keyed on the passed workspaceId', async () => {
    const item = {
      id: 'WI-feat',
      family: 'feature',
      kind: 'feature',
      title: 'WI-feat',
      summary: '',
      state: 'todo',
      assignee: null,
    } as unknown as Parameters<typeof itemMatchesRawClaimSpec>[0];
    admissionMocks.compileFilter.mockReturnValue('FILTER_FRAGMENT');
    admissionMocks.sql.mockImplementation((strings: readonly string[], ...values: unknown[]) => {
      if (strings.some((s) => s.includes('workspace_id ='))) {
        return Promise.resolve([{ matched: values[0] === 'papercusp-workspace' }]);
      }
      return 'FRAGMENT';
    });
    await expect(
      itemMatchesRawClaimSpec(item, { ...issueSpec, view: { filter: { field: 'kind', op: '=', value: 'feature' } } }, 'papercusp-workspace'),
    ).resolves.toBe(true);
    expect(admissionMocks.sql).toHaveBeenCalled();
  });
});
