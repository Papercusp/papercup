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
  fleetScopedMiss,
  readFleetPauseState,
  reconcileFleetScopeClaims,
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
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', record: fleetSpec },
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
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', record: fleetSpec },
        [],
        { pausedReason: 'owner pause', claimableAwaitsCancelled: 2 },
      );
      expect(miss).toMatchObject({ windDown: true, paused: true, claimableAwaitsCancelled: 2 });
      expect(miss.advice).toMatch(/Do NOT re-park a work-item:claimable await while paused/);
      expect(miss.advice).toMatch(/EI-15777/);
    });

    it('EI-15777: a paused miss with no cancelled awaits still surfaces claimableAwaitsCancelled:0 (default)', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', record: fleetSpec },
        [],
        { pausedReason: 'owner pause' },
      );
      expect(miss).toMatchObject({ claimableAwaitsCancelled: 0 });
    });

    it('EI-15777: a non-paused (cooldown-only) miss never carries claimableAwaitsCancelled', () => {
      const miss = fleetScopedMiss(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', record: fleetSpec },
        [],
        { cooldownDiag: null },
      );
      expect(miss).not.toHaveProperty('claimableAwaitsCancelled');
    });

    it('readFleetPauseState fails OPEN when the control-state read errors (never wedges claiming)', async () => {
      admissionMocks.getFleet.mockRejectedValue(new Error('pg unavailable'));
      const state = await readFleetPauseState(
        { ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member', record: fleetSpec },
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
        cooldownDiag: { cooldownExcluded: 3, earliestExpiryMs: Date.now() + 42_000 },
      });
      expect(miss).toMatchObject({ windDown: true, cooldownOnly: true, cooldownExcluded: 3 });
      expect(miss.paused).toBeUndefined();
      expect(miss.error).toMatch(/YOUR OWN release-cooldown floor/);
      expect(miss.error).not.toMatch(/NOT allowed to fall through to the generic backlog/);
      // EI-13520's intent survives (a NORMAL one-time cooldown is not a scope/spec
      // problem — do not re-author the spec for it); EI-14615 only ADDS the livelock
      // exception below, it does not revert this.
      expect(miss.advice).toMatch(/not a scope\/spec mismatch/);
      expect(miss.advice).toMatch(/do NOT re-author the claim spec/);
      expect(miss.advice).not.toMatch(/report the scoped miss to the fleet leader/);
    });

    // EI-14615: a cooldown-only miss whose window is being externally re-stamped by a
    // fleet round-robin reports a perpetually-fresh ~300s and never clears. The relative
    // `cooldownExpirySec` alone can't reveal this (it reads the same ~Ns every poll), so
    // the miss now also surfaces the ABSOLUTE `cooldownExpiryAt` the member can compare
    // across polls, and the advice tells them to escalate to the leader when it advances.
    describe('EI-14615: absolute cooldown expiry + livelock-aware advice', () => {
      it('surfaces cooldownExpiryAt as the ISO of earliestExpiryMs (so a re-stamped window is observable across polls)', () => {
        const earliestExpiryMs = Date.parse('2026-07-17T15:09:00.000Z');
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs },
        });
        expect(miss.cooldownExpiryAt).toBe(new Date(earliestExpiryMs).toISOString());
        // cooldownExpiryAt is the absolute complement of the (still-present) relative sec.
        expect(typeof (miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBe('number');
      });

      it('advice keeps the NORMAL re-poll path AND adds the livelock escalation keyed on the expiry advancing (EI-14615)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 2, earliestExpiryMs: Date.now() + 300_000 },
        });
        // Normal case preserved: re-poll after cooldownExpiryAt, do not re-author the spec.
        expect(miss.advice).toMatch(/re-poll/i);
        expect(miss.advice).toMatch(/cooldownExpiryAt/);
        // Livelock case added: an ADVANCING expiry is a livelock → DO escalate to the leader.
        expect(miss.advice).toMatch(/ADVANCED/);
        expect(miss.advice).toMatch(/EI-14615/);
        expect(miss.advice).toMatch(/report it to your leader/i);
      });

      it('cooldownExpiryAt is null-safe when earliestExpiryMs is null (defensive; WI-5303 makes it non-null in practice)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          cooldownDiag: { cooldownExcluded: 1, earliestExpiryMs: null },
        });
        expect(miss.cooldownOnly).toBe(true);
        expect(miss.cooldownExpiryAt).toBeNull();
        expect((miss as { cooldownExpirySec: number | null }).cooldownExpirySec).toBeNull();
      });

      it('a paused miss carries NO cooldownExpiryAt even if a cooldownDiag is passed (pause fully explains the miss)', () => {
        const miss = fleetScopedMiss(cooldownScope, [], {
          pausedReason: 'owner pause',
          cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000 },
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
        cooldownDiag: { cooldownExcluded: 5, earliestExpiryMs: Date.now() + 1_000 },
      });
      expect(miss.paused).toBe(true);
      expect(miss.cooldownOnly).toBeUndefined();
      expect(miss.error).toMatch(/winding-down/);
    });
  });
});
