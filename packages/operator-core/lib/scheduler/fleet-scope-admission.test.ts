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
vi.mock('../fleet/assignments', () => ({
  listFleetAssignments: admissionMocks.listFleetAssignments,
}));
vi.mock('../work-items', () => ({
  getWorkItem: admissionMocks.getWorkItem,
  releaseWorkItem: admissionMocks.releaseWorkItem,
  claimFloorsWhereSql: admissionMocks.claimFloorsWhereSql,
  releaseCooldownSec: admissionMocks.releaseCooldownSec,
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
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
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

    it('returns null (a genuine scope/spec-empty miss, not a floor story) when the filter matches zero issue-family rows', async () => {
      admissionMocks.aggregateIssueClaimExclusions.mockResolvedValue({ matchedByFilter: 0, claimable: 0, excluded: floorGatedBreakdown.excluded });
      const diag = await diagnoseFleetScopeIssueFloorMiss({ scope: issueScope, harness: 'papercusp', workspaceId: 'papercusp-workspace' });
      expect(diag).toBeNull();
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
      expect(miss.advice).toMatch(/FLOOR-GATED miss \(WI-5561\)/);
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
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

    it('fleetScopeLeaderRemedy names scheduler:set_claim_spec, the fleet slug, and the current specId@revision for a scope violation', () => {
      const remedy = fleetScopeLeaderRemedy(violation);
      expect(remedy).toMatch(/scheduler:set_claim_spec/);
      expect(remedy).toMatch(/fleet: "p2p-release-verify"/);
      expect(remedy).toMatch(/p2p-release-verify-lane@20/);
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
});
