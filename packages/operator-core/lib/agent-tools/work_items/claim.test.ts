/**
 * claim.test.ts — work_items:claim handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * success → one result with workItem; ids:[…] fan-out; a claim_conflict (EI-2197
 * classify) fails only that item and carries holder/hint; top-level ok stays true.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me' }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
const premisePort = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId }),
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
}));
// Claim-time recall port (P-008) is exercised in its own memory/claim-port.test.ts;
// mock it here so the handler test stays a hermetic unit (no real memory backend).
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('../../premises-claim-port', () => ({ getClaimTimePremises: premisePort.get }));

import { claimWorkItem, classifyClaimFailure, getWorkItem, readWorkItemClaimHoldProvenance } from '../../work-items';
import { recordClaimHoldBypassAudit, notifyClaimHoldBypass } from './claim-hold-guard';
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getM = vi.mocked(getWorkItem);
const provenanceM = vi.mocked(readWorkItemClaimHoldProvenance);
const auditM = vi.mocked(recordClaimHoldBypassAudit);
const notifyM = vi.mocked(notifyClaimHoldBypass);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
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
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined });
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
      workspaceId: undefined,
    });
  });

  it('claims MANY via ids:[…] for an explicit assignee', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], assignee: 'bee-7' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(claimM).toHaveBeenCalledWith('WI-2', 'bee-7', { harness: undefined });
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
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED', 's-bee-1', { harness: undefined });
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
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED-2', 's-bee-2', { harness: undefined });
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
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined });
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
    expect(claimM).toHaveBeenCalledWith('WI-1', 'self-service-bot', { harness: undefined });
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
      expect(claimM).toHaveBeenCalledWith('WI-HELD', 'me', { harness: undefined });
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
      expect(claimM).toHaveBeenCalledWith('WI-SEC', 'me', { harness: undefined });
      expect(auditM).toHaveBeenCalledWith('me', 'WI-SEC', expect.objectContaining({ ownerOverride: true }));
    });

    it('an unheld item is unaffected by force/ownerOverride being absent (no guard, no audit)', async () => {
      const b = await body({ id: 'WI-1' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(auditM).not.toHaveBeenCalled();
      expect(notifyM).not.toHaveBeenCalled();
    });
  });
});
