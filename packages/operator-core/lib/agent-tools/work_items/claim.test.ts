/**
 * claim.test.ts — work_items:claim handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * success → one result with workItem; ids:[…] fan-out; a claim_conflict (EI-2197
 * classify) fails only that item and carries holder/hint; top-level ok stays true.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const deadSessionRouting = vi.hoisted(() => ({
  lookupEndedSessions: vi.fn(async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, '2026-08-21T02:22:14.866Z'] as const)),
  ),
  resolvePresenceFleet: vi.fn(async () => ({ fleetSlug: 'drain-fleet', fleetRole: 'member' })),
}));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
const premisePort = vi.hoisted(() => ({ get: vi.fn() }));
const forceGuard = vi.hoisted(() => ({
  verdict: { allowed: true, basis: 'holder-session-ended', holderLiveness: { live: false } } as any,
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
  deriveFleetMembership: () => ({ fleetSlug: 'launch-fleet', fleetRole: 'member' }),
}));
vi.mock('../coordination/dead-session-recipient-guidance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookupEndedSessions: deadSessionRouting.lookupEndedSessions,
}));
vi.mock('../coordination/presence-fleet', () => ({
  resolvePresenceFleet: deadSessionRouting.resolvePresenceFleet,
}));
// WI-5946: readWorkItemClaimHoldProvenance/looksLikePolicyGate are real dependencies of BOTH
// claim.ts (the pre-read guard) and claim-hold-guard.ts's assessClaimHoldGuard (mocked at the
// SAME module path, so both importers see this one mock) — default "nothing held" so every
// pre-existing test in this file is unaffected; the claim-hold-specific tests below override it.
//
// PARTIAL mock (importOriginal), deliberately — NOT a hand-listed factory. A hand-listed factory
// returns `undefined` for any export claim.ts imports but the list forgot, and the tool then
// crashes on it at runtime: runBulk converts the throw into ok:false, so EVERY test in this file
// fails with "expected ok:false to equal ok:true" — an assertion that names neither the missing
// export nor the mock. That is exactly what happened here when P-013 added the
// `readUnresolvedDepBlockers` import (11 of 19 red, all one root cause). claim.checkpoint-hint.ts
// had already been converted to this form for the same reason after WI-5946; this file was the
// remaining copy. Spreading the real module means a FUTURE import claim.ts adds resolves to the
// genuine implementation instead of undefined — only the fns stubbed below are replaced.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
  readWorkItemClaimHoldProvenance: vi.fn(() => ({ heldOpen: null, parked: null, attributed: false })),
  looksLikePolicyGate: vi.fn(() => false),
}));
// Keep assessClaimHoldGuard REAL (it composes the two mocked work-items reads above — an
// integration test of the guard's own logic, not a re-mock of it); stub only the
// side-effecting audit/notify calls so a claim-hold-bypass test never touches a real
// DB/coord/attention backend.
vi.mock('./claim-hold-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claim-hold-guard')>();
  return {
    ...actual,
    recordClaimHoldBypassAudit: vi.fn(async () => {}),
    notifyClaimHoldBypass: vi.fn(async () => {}),
  };
});
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
  renderFleetDependencyEscape: vi.fn((escape: { dependency: { id: string } }) =>
    `DEPENDENCY ESCAPE: ${escape.dependency.id}`),
}));
// Claim-time recall port (P-008) is exercised in its own memory/claim-port.test.ts;
// mock it here so the handler test stays a hermetic unit (no real memory backend).
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('../../premises-claim-port', () => ({ getClaimTimePremises: premisePort.get }));
// EI-20417350647749715: keep the force takeover handler tests hermetic while the
// release-force-guard unit suite covers the real liveness/authority classifier.
vi.mock('./release-force-guard', () => ({
  assessForceRelease: vi.fn(async () => forceGuard.verdict),
  forceRefusalHint: (holder: string) => `refused:${holder}`,
  notifyForceTransition: vi.fn(async () => {}),
  recordForceTransitionAudit: vi.fn(async () => {}),
}));

import { claimWorkItem, classifyClaimFailure, getWorkItem, readWorkItemClaimHoldProvenance } from '../../work-items';
import { recordClaimHoldBypassAudit, notifyClaimHoldBypass } from './claim-hold-guard';
import { assessForceRelease, notifyForceTransition, recordForceTransitionAudit } from './release-force-guard';
import { mockResolvedTyped, mockReturnTyped } from '../../testing/typed-mock';
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getM = vi.mocked(getWorkItem);
const provenanceM = vi.mocked(readWorkItemClaimHoldProvenance);
const auditM = vi.mocked(recordClaimHoldBypassAudit);
const notifyM = vi.mocked(notifyClaimHoldBypass);
const assessForceM = vi.mocked(assessForceRelease);
const forceNotifyM = vi.mocked(notifyForceTransition);
const forceAuditM = vi.mocked(recordForceTransitionAudit);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  forceGuard.verdict = { allowed: true, basis: 'holder-session-ended', holderLiveness: { live: false } };
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(async (id: string) => ({ id, assignee: 'me' }) as never);
  // WI-5946: claim.ts now pre-reads the item (getWorkItem) BEFORE every claim, purely to check
  // payload._claimHold — default it to "not found" (a real getWorkItem miss simply means the
  // guard sees no hold, same as an unclaimed item; claimWorkItem's own compare-and-claim, not
  // this pre-read, is what actually resolves not_found for the claim itself) so every
  // pre-existing test below — none of which cares about claim-hold — is unaffected.
  getM.mockResolvedValue(null as never);
  provenanceM.mockReturnValue({ heldOpen: null, parked: null, attributed: false });
  premisePort.get.mockReset().mockResolvedValue(null);
});

describe('work_items:claim handler (keyed-array)', () => {
  it('claims one inline for the caller and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', assignee: 'me' } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('P-016 returns the ready await call when the claimed item has an active gate blocker', async () => {
    const now = '2026-08-21T00:00:00.000Z';
    claimM.mockResolvedValue({
      id: 'WI-GATED',
      assignee: 'me',
      externalBlockers: [
        {
          kind: 'gate',
          capability: 'live-dependency',
          capabilitySource: 'explicit',
          ref: 'release:green:papercusp',
          summary: 'green checkpoint must pass',
          status: 'active',
          createdAt: now,
          createdBy: 'su-leader',
          updatedAt: now,
        },
      ],
    } as never);

    const b = await body({ id: 'WI-GATED' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'WI-GATED',
      suggestedWatches: [
        {
          tool: 'events:await',
          args: { event: 'release:green:papercusp' },
        },
      ],
    });
    expect(b.results[0].suggestedWatches[0].why).toMatch(/red gate/i);
  });

  it('passes the claimed id to premise citation hydration and surfaces its advisory', async () => {
    claimM.mockResolvedValue({
      id: 'EI-aged',
      title: 'Build a replacement gate',
      summary: 'EI-aged depends on WI-4329.',
      payload: { source: 'ideation' },
      harness: 'papercusp',
      assignee: 'me',
    } as never);
    premisePort.get.mockResolvedValue({
      rendered: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      note: 'Re-check the invalidated premise before building.',
    });

    const b = await body({ id: 'EI-aged', harness: 'papercusp' });

    expect(b.results[0]).toMatchObject({
      workItem: { id: 'EI-aged' },
      premises: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      premisesNote: 'Re-check the invalidated premise before building.',
    });
    expect(premisePort.get).toHaveBeenCalledWith({
      workItem: {
        id: 'EI-aged',
        title: 'Build a replacement gate',
        summary: 'EI-aged depends on WI-4329.',
        payload: { source: 'ideation' },
      },
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
  });

  it('claims MANY via ids:[…] for an explicit assignee', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], assignee: 'bee-7' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(claimM).toHaveBeenCalledWith('WI-2', 'bee-7', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('P-016 refuses an out-of-scope named claim before mutation and alerts the leader', async () => {
    fleetAdmission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'WI-out is outside fleet-bugs@4',
      scope: {
        fleetSlug: 'bugs',
        ownerId: 'bee-7',
        fleetRole: 'member',
        record: { spec: { specId: 'fleet-bugs', revision: 4 } },
      },
    };
    const b = await body({ id: 'WI-out', assignee: 'bee-7' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-out', error: 'fleet_scope_violation' });
    expect(claimM).not.toHaveBeenCalled();
    expect(fleetAdmission.notify).toHaveBeenCalledOnce();
    // EI-18673501896258575: the caller sees the SAME concrete remedy the leader was
    // notified with — not just a bare refusal reason, so a member acting on an
    // explicit leader directive knows the scheduler:set_claim_spec fix exists.
    expect(b.results[0].hint).toMatch(/remedy: scheduler:set_claim_spec/);
  });

  it('returns the typed dependency escape produced by the refusal seam', async () => {
    fleetAdmission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'WI-blocker is outside fleet-bugs@4',
      scope: {
        fleetSlug: 'bugs', ownerId: 'bee-7', fleetRole: 'member',
        record: { spec: { specId: 'fleet-bugs', revision: 4 } },
      },
    };
    const dependencyEscape = {
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
      blockedHeldItemIds: ['WI-held'],
      member: 'bee-7',
      ownershipPreserved: true,
      routes: [
        { kind: 'spec_widen', calls: [] },
        { kind: 'outside_lane_placement', calls: [] },
        { kind: 'leader_claim', calls: [] },
      ],
    };
    fleetAdmission.notify.mockResolvedValue({
      liveRouteTarget: true,
      classRefusal: null,
      dependencyEscape,
    });
    const b = await body({ id: 'WI-blocker', assignee: 'bee-7', harness: 'papercusp' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'fleet_scope_violation',
      dependencyEscape: {
        dependency: { id: 'WI-blocker' },
        blockedHeldItemIds: ['WI-held'],
        ownershipPreserved: true,
      },
    });
    expect(b.results[0].hint).toMatch(/DEPENDENCY ESCAPE/);
  });

  it('refuses implicit claims as the shared su-loopback fallback', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-LOOPBACK' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-LOOPBACK', error: 'missing_client_identity' });
    expect(b.results[0].hint).toMatch(/real per-session or spawn owner/);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('still permits explicit assignee claims from a su-loopback caller', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-DIRECTED', assignee: 's-bee-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED', 's-bee-1', { harness: undefined, fromHolder: identity.ownerId });
  });

  // EI-8509: scripts/mcp-call.mjs mints `mcp-call-<pid>` when invoked with no
  // --client — a one-shot process with no liveness/heartbeat and no fleet cup
  // behind it. An implicit claim under that identity must be refused the same
  // way the su-loopback fallback is, so "placed" work can no longer silently
  // rot with nothing ever executing it.
  it('refuses an implicit claim under the mcp-call.mjs auto-generated fallback identity', async () => {
    identity.ownerId = 'mcp-call-12345';
    const b = await body({ id: 'WI-EPHEMERAL' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'WI-EPHEMERAL',
      error: 'ephemeral_mcp_call_identity',
    });
    expect(b.results[0].hint).toMatch(/mcp-call\.mjs/);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('still permits explicit assignee claims from an mcp-call.mjs fallback caller', async () => {
    identity.ownerId = 'mcp-call-12345';
    const b = await body({ id: 'WI-DIRECTED-2', assignee: 's-bee-2' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED-2', 's-bee-2', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('a claim_conflict fails only that item (top-level ok stays true) with holder + hint', async () => {
    claimM.mockImplementation(async (id: string) => (id === 'WI-HELD' ? null : ({ id, assignee: 'me' } as never)));
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = await body({ ids: ['WI-1', 'WI-HELD'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'claim_conflict', holder: 'peer' });
    expect(b.results[1].hint).toMatch(/Already claimed by peer/);
  });

  // EI-20731607691070897 — a HOLDER handing their own item to a named peer. Before this,
  // `claim { id, assignee: peer }` was refused as a claim_conflict against the caller
  // THEMSELVES, and the only path left (release → peer claims) drops the item to
  // UNASSIGNED and fleet-claimable in between — a real race on a fleet whose scheduler
  // hands out claimable work. There is no other transfer primitive: coord:handoff records
  // a transition note, work_items:request_release is the opposite direction, and
  // work_items:update has no assignee.
  describe('self-held transfer', () => {
    it('passes the CALLER as fromHolder, so the handoff lands in the same compare-and-claim', async () => {
      identity.ownerId = 'me';
      const b = await body({ id: 'WI-MINE', assignee: 'peer' });
      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      // fromHolder is the whole mechanism: it widens the CAS by the caller's OWN claim.
      // Without it the UPDATE matches only an unheld row and the transfer is refused.
      expect(claimM).toHaveBeenCalledWith('WI-MINE', 'peer', { harness: undefined, fromHolder: 'me' });
    });

    it('never offers a THIRD party as fromHolder — only ever the caller', async () => {
      identity.ownerId = 'me';
      await body({ id: 'WI-X', assignee: 'peer' });
      // The safety property: fromHolder is bound to identity, never to the assignee, so
      // this can only ever move a claim the CALLER already holds.
      expect(claimM).toHaveBeenCalledWith('WI-X', 'peer', expect.objectContaining({ fromHolder: 'me' }));
      expect(claimM).not.toHaveBeenCalledWith('WI-X', 'peer', expect.objectContaining({ fromHolder: 'peer' }));
    });

    it('a conflict whose holder IS the caller does not return the someone-else-holds-it hint', async () => {
      identity.ownerId = 'me';
      mockResolvedTyped(claimM, null);
      mockReturnTyped(classifyM, { reason: 'conflict', holder: 'me' });
      const b = await body({ id: 'WI-MINE', assignee: 'peer' });
      expect(b.results[0]).toMatchObject({ ok: false, error: 'claim_conflict', holder: 'me' });
      const hint = b.results[0].hint as string;
      expect(hint).toMatch(/already hold/i);
      // The two branches that actively misfire when the holder is the caller: being told
      // to coordinate with "the holder" (yourself), and to wait for the stale-claim lane
      // to free it (your own death).
      expect(hint).not.toMatch(/Already claimed by/);
      expect(hint).not.toMatch(/Coordinate with the holder via coord:send/);
      expect(hint).not.toMatch(/stale-claim reclaim lane/);
      // And it must steer AWAY from the release that opens the fleet-claimable window.
      expect(hint).toMatch(/Do NOT work_items:release/);
    });

    it('a conflict held by a PEER still returns the original hint', async () => {
      identity.ownerId = 'me';
      mockResolvedTyped(claimM, null);
      mockReturnTyped(classifyM, { reason: 'conflict', holder: 'peer' });
      const b = await body({ id: 'WI-HELD' });
      const hint = b.results[0].hint as string;
      expect(hint).toMatch(/Already claimed by peer/);
      expect(hint).toMatch(/Coordinate with the holder via coord:send/);
      expect(hint).not.toMatch(/already hold/i);
    });
  });

  // EI-20417350647749715 — force:true is a checked, atomic cross-holder takeover.
  // The handler owns the pre-read/guard/audit contract; release-force-guard.test.ts
  // owns the real liveness and authority classifier.
  describe('cross-holder force takeover', () => {
    it('authorizes a dead-holder takeover, passes expectedAssignee into the CAS, and reports/audits it', async () => {
      getM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'peer', lastProgressAt: '2026-08-20T08:00:00.000Z' } as never);
      claimM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'me', harness: 'papercusp' } as never);

      const b = await body({ id: 'WI-DEAD', force: true, reason: 'holder session ended; reclaiming for the drain' });

      expect(assessForceM).toHaveBeenCalledWith({
        callerOwnerId: 'me',
        holderOwnerId: 'peer',
        workspaceId: 'ws-1',
        itemLastProgressAt: '2026-08-20T08:00:00.000Z',
      });
      expect(claimM).toHaveBeenCalledWith('WI-DEAD', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer',
      });
      expect(b.results[0]).toMatchObject({
        ok: true,
        id: 'WI-DEAD',
        forced: {
          holder: 'peer',
          basis: 'holder-session-ended',
          reason: 'holder session ended; reclaiming for the drain',
        },
      });
      expect(forceAuditM).toHaveBeenCalledWith(
        'me',
        'WI-DEAD',
        'claim',
        expect.objectContaining({ holder: 'peer', replacementAssignee: 'me' }),
      );
      expect(forceNotifyM).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'me' }),
        expect.objectContaining({ itemId: 'WI-DEAD', holder: 'peer', operation: 'claim', replacementAssignee: 'me' }),
      );
    });

    it('requires a reason before assessing or mutating another holder\'s claim', async () => {
      getM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'peer' } as never);

      const b = await body({ id: 'WI-DEAD', force: true });

      expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-DEAD', error: 'force_requires_reason', holder: 'peer' });
      expect(assessForceM).not.toHaveBeenCalled();
      expect(claimM).not.toHaveBeenCalled();
      expect(forceAuditM).not.toHaveBeenCalled();
      expect(forceNotifyM).not.toHaveBeenCalled();
    });

    it('refuses an unauthorized takeover of a live peer and leaves the claim untouched', async () => {
      getM.mockResolvedValue({ id: 'WI-LIVE', assignee: 'peer', lastProgressAt: '2026-08-20T08:39:00.000Z' } as never);
      forceGuard.verdict = { allowed: false, holderLiveness: { live: true } };

      const b = await body({ id: 'WI-LIVE', force: true, reason: 'taking over for the drain' });

      expect(b.results[0]).toMatchObject({
        ok: false,
        id: 'WI-LIVE',
        error: 'force_unauthorized',
        holder: 'peer',
        holderLiveness: { live: true },
        hint: 'refused:peer',
      });
      expect(claimM).not.toHaveBeenCalled();
      expect(forceAuditM).not.toHaveBeenCalled();
      expect(forceNotifyM).not.toHaveBeenCalled();
    });

    it('applies a batch reason, with a per-item reason overriding it', async () => {
      getM.mockImplementation(async (id: string) => ({
        id,
        assignee: id === 'WI-A' ? 'peer-a' : 'peer-b',
        lastProgressAt: null,
      }) as never);
      claimM.mockImplementation(async (id: string, assignee: string, opts?: { expectedAssignee?: string }) => ({
        id,
        assignee,
        harness: 'papercusp',
        payload: { expectedAssignee: opts?.expectedAssignee },
      }) as never);

      const b = await body({
        items: [{ id: 'WI-A', force: true, reason: 'item-specific reason' }, { id: 'WI-B', force: true }],
        reason: 'batch takeover reason',
      });

      expect(b.counts).toEqual({ ok: 2, failed: 0 });
      expect(claimM).toHaveBeenNthCalledWith(1, 'WI-A', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer-a',
      });
      expect(claimM).toHaveBeenNthCalledWith(2, 'WI-B', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer-b',
      });
      const reasons = forceAuditM.mock.calls.map((call) => (call[3] as { reason: string }).reason).sort();
      expect(reasons).toEqual(['batch takeover reason', 'item-specific reason']);
      expect(b.results.map((result: { forced?: { reason: string } }) => result.forced?.reason).sort()).toEqual([
        'batch takeover reason',
        'item-specific reason',
      ]);
    });

    it('skips the cross-holder guard for an unclaimed or caller-held item', async () => {
      getM.mockResolvedValue({ id: 'WI-FREE', assignee: null } as never);

      const b = await body({ id: 'WI-FREE', force: true });

      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FREE' });
      expect(b.results[0].forced).toBeUndefined();
      expect(assessForceM).not.toHaveBeenCalled();
    });
  });

  it('a not-found item is classified and reported per item', async () => {
    claimM.mockResolvedValue(null as never);
    getM.mockResolvedValue(null as never);
    classifyM.mockReturnValue({ reason: 'not_found' } as never);
    const b = await body({ id: 'WI-404' });
    expect(b.results[0]).toEqual({ ok: false, id: 'WI-404', error: "work_item 'WI-404' not found" });
  });

  // EI-9274: a literal `'self'` assignee must resolve to the caller, not be stored
  // verbatim (WI-3881 was permanently orphaned this way — no live agent is ever
  // actually named "self").
  it('EI-9274: assignee:"self" resolves to the caller ownerId, not the literal string', async () => {
    const b = await body({ id: 'WI-1', assignee: 'self' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('EI-9274: assignee:"self" under the su-loopback fallback is refused the same as an omitted assignee', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-LOOPBACK-SELF', assignee: 'self' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-LOOPBACK-SELF', error: 'missing_client_identity' });
    expect(claimM).not.toHaveBeenCalled();
  });

  it('a concrete assignee ownerId literally named "self-service-bot" is passed through unchanged', async () => {
    const b = await body({ id: 'WI-1', assignee: 'self-service-bot' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'self-service-bot', { harness: undefined, fromHolder: identity.ownerId });
  });

  // WI-5946: the by-id claim path never checked payload._claimHold — reproduced live on
  // EI-1416 (a policy-tier D-003 security hold). These pin the fix: a claim-hold-parked item
  // refuses by default, force clears a plain hold, and a policy-tier reason additionally
  // requires ownerOverride — mirroring work_items:hold_open's own clear-guard exactly.
  describe('claim-hold guard (WI-5946)', () => {
    // WI-6746: the guard above is derived ENTIRELY from the pre-claim read — claimWorkItem
    // itself has no hold check (it gates on taken_by + G2/P-010 admission only). While that
    // read was swallowed with `.catch(() => null)`, a PG fault made preClaimItem null, which
    // made the refusal null, which SKIPPED the guard and claimed the item — i.e. the guard
    // vanished exactly when the database was unhealthy. Only a THROWING read distinguishes
    // the fixed version from the broken one; with a healthy read both behave identically,
    // which is why this survived in the source.
    it('FAILS CLOSED when the pre-claim read THROWS — a PG fault must not bypass the hold (WI-6746)', async () => {
      getM.mockRejectedValue(new Error('connection terminated unexpectedly'));
      provenanceM.mockReturnValue({
        heldOpen: { by: 'su-leader', reason: 'still triaging', at: '2026-07-26T00:00:00Z' },
        parked: null,
        attributed: true,
      });
      const b = await body({ id: 'WI-HELD' });
      expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'work_item_unreadable' });
      // The refusal must name the read failure — an agent told "not found" would file a
      // bug against the wrong subsystem (the exact mis-diagnosis WI-6737 was filed on).
      expect(b.results[0].hint).toMatch(/could not be read|read failed/i);
      expect(b.results[0].hint).toMatch(/connection terminated/);
      expect(claimM).not.toHaveBeenCalled();
    });

    it('an unreadable pre-claim read is NOT reported as a missing item (WI-6746)', async () => {
      getM.mockRejectedValue(new Error('statement timeout'));
      const b = await body({ id: 'WI-HELD' });
      expect(b.results[0].error).not.toMatch(/not found/i);
    });

    it('a genuine zero-row pre-claim read still proceeds to claimWorkItem (WI-6746 regression)', async () => {
      // The fail-closed refusal must trigger on `unreadable` ONLY. A real absent item keeps
      // its old path (claimWorkItem decides), or this fix would break every ordinary claim.
      getM.mockResolvedValue(null as never);
      claimM.mockResolvedValue({ id: 'WI-NEW', assignee: 'me' } as never);
      const b = await body({ id: 'WI-NEW' });
      expect(claimM).toHaveBeenCalled();
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-NEW' });
    });

    it('refuses a claim-hold-parked item with claim_hold_blocked, and never calls claimWorkItem', async () => {
      getM.mockResolvedValue({ id: 'WI-HELD', payload: { _claimHold: true } } as never);
      provenanceM.mockReturnValue({
        heldOpen: null,
        parked: { by: 'su-leader', reason: 'D-003 policy hold — do not self-pick', at: '2026-07-26T00:00:00Z' },
        attributed: true,
      });
      const b = await body({ id: 'WI-HELD' });
      expect(b.results[0]).toMatchObject({
        ok: false,
        id: 'WI-HELD',
        error: 'claim_hold_blocked',
        heldBy: 'su-leader',
        convention: 'claim_hold (durable park)',
      });
      expect(b.results[0].hint).toMatch(/force:true/);
      expect(claimM).not.toHaveBeenCalled();
      expect(auditM).not.toHaveBeenCalled();
      expect(notifyM).not.toHaveBeenCalled();
    });

    it('force:true claims past a plain (non-policy) claim-hold, and audits + notifies the holder', async () => {
      getM.mockResolvedValue({ id: 'WI-HELD', payload: { _claimHold: true } } as never);
      provenanceM.mockReturnValue({
        heldOpen: { by: 'su-leader', reason: 'still triaging', at: '2026-07-26T00:00:00Z' },
        parked: null,
        attributed: true,
      });
      const b = await body({ id: 'WI-HELD', force: true });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-HELD' });
      expect(claimM).toHaveBeenCalledWith('WI-HELD', 'me', { harness: undefined, fromHolder: identity.ownerId });
      expect(auditM).toHaveBeenCalledWith(
        'me',
        'WI-HELD',
        expect.objectContaining({ heldBy: 'su-leader', convention: 'held_open (lease)' }),
      );
      expect(notifyM).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'me' }),
        expect.objectContaining({ itemId: 'WI-HELD', heldBy: 'su-leader' }),
      );
    });

    it('a policy-tier hold reason refuses force:true alone (requires ownerOverride too)', async () => {
      getM.mockResolvedValue({ id: 'WI-SEC', payload: { _claimHold: true } } as never);
      provenanceM.mockReturnValue({
        heldOpen: null,
        parked: {
          by: 'su-leader',
          reason: 'D-003 explicit policy-tier human gate — owner sign-off required',
          at: '2026-07-26T00:00:00Z',
        },
        attributed: true,
      });
      const looksLikePolicyGateM = vi.mocked((await import('../../work-items')).looksLikePolicyGate);
      looksLikePolicyGateM.mockReturnValue(true);
      const forced = await body({ id: 'WI-SEC', force: true });
      expect(forced.results[0]).toMatchObject({
        ok: false,
        id: 'WI-SEC',
        error: 'policy_gate_requires_owner_override',
      });
      expect(claimM).not.toHaveBeenCalled();

      const overridden = await body({ id: 'WI-SEC', force: true, ownerOverride: true });
      expect(overridden.results[0]).toMatchObject({ ok: true, id: 'WI-SEC' });
      expect(claimM).toHaveBeenCalledWith('WI-SEC', 'me', { harness: undefined, fromHolder: identity.ownerId });
      expect(auditM).toHaveBeenCalledWith('me', 'WI-SEC', expect.objectContaining({ ownerOverride: true }));
    });

    it('routes a session-shaped dead holder to the durable role and fleet selectors', async () => {
      const deadHolder = 'su-d3192c05-9dfe-4778-bc29-70c13783bb5d';
      vi.mocked((await import('../../work-items')).looksLikePolicyGate).mockReturnValue(false);
      getM.mockResolvedValue({ id: 'WI-DEAD-HOLD', payload: { _claimHold: true } } as never);
      provenanceM.mockReturnValue({
        heldOpen: null,
        parked: { by: deadHolder, reason: 'still triaging', at: '2026-07-26T00:00:00Z' },
        attributed: true,
      });

      const b = await body({ id: 'WI-DEAD-HOLD' });

      expect(b.results[0]).toMatchObject({ error: 'claim_hold_blocked', heldBy: deadHolder });
      expect(deadSessionRouting.lookupEndedSessions).toHaveBeenCalledWith([deadHolder], 'ws-1');
      expect(deadSessionRouting.resolvePresenceFleet).toHaveBeenCalledWith(
        'me',
        { fleetSlug: 'launch-fleet', fleetRole: 'member' },
      );
      expect(b.results[0].hint).toMatch(/@role:<slot>/);
      expect(b.results[0].hint).toMatch(/@fleet-leader:drain-fleet/);
      expect(claimM).not.toHaveBeenCalled();
    });

    it('an unheld item is unaffected by force/ownerOverride being absent (no guard, no audit)', async () => {
      const b = await body({ id: 'WI-1' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(auditM).not.toHaveBeenCalled();
      expect(notifyM).not.toHaveBeenCalled();
    });
  });
});
