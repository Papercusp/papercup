/**
 * delegated-spawn-honor.test.ts — the P-009 honor path on the contributing
 * host (projection-driven cross-machine launch).
 *
 * What a regression here breaks: a host spawns for a request it never should
 * have honored (gate off, stale request after a late owner opt-in, someone
 * else's request, a revoked delegation), two concurrent projection applies
 * double-spawn the same request, a refusal goes silent (no disposition /
 * receipt — D-004), or the M19 re-derivation drifts from the publish-side
 * offer-id hash and every legitimate request starts refusing seat_ref_unknown.
 *
 * Pure DI — no PG, no keychain, no desktop spawn.
 * Run: cd packages/operator-core && npx vitest run lib/p2p/delegated-spawn-honor.test.ts
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  SPAWN_REQUEST_HONOR_WINDOW_MS,
  classifyRuntimeProbe,
  defaultVerifyLocalMemberBoot,
  byocBillingModeForRoute,
  byocSeatAxisCap,
  evaluateSpawnRequestTarget,
  honorSpawnRequestFromProjection,
  probeAgentBinResolvable,
  type DelegatedSpawnHonorDeps,
  type PotSeatCandidate,
} from './delegated-spawn-honor';
import {
  honorAccountRoutingMode,
  probeLocalClaudeLogin,
  loginEvidenceWasProbed,
  classifyHonorSpawnFailure,
  resolveHonorAccount,
} from './honor-account-resolution';
import { seatOfferId } from './offer-store-publish';
import { computeSeatAvailability, resolveSeatLaunch, type SeatSlot } from '../fleet/seat-accounting';
import type { WorkOfferStoreRecord } from './offer-store-schema';

const WS = 'ws-1';
const HOME = 'hive-home';
const UID_A = 1567022; // the requesting fleet owner (remote)
const UID_B = 279242982; // THIS host (the seat-offer publisher)
const PK_B = 'pk-b-device';
const NOW = 1_751_600_000_000;

const TARGET_OFFER_ID = seatOfferId({
  fleetSlug: 'alpha',
  model: 'haiku',
  effort: 'low',
  account: 'AUTO',
  devicePubkey: PK_B,
});

const SLOT: SeatSlot = { ref: 'haiku:low:AUTO', model: 'haiku', effort: 'low', account: 'AUTO', quantity: 3 };

// ── P-003: pot-scoped fixtures ───────────────────────────────────────────────
const POT_SLUG = 'design-pot';
const POT_SLOT: SeatSlot = { ref: 'sonnet:high:AUTO', model: 'sonnet', effort: 'high', account: 'AUTO', quantity: 5 };
const POT_TARGET_OFFER_ID = seatOfferId({
  potSlug: POT_SLUG,
  model: 'sonnet',
  effort: 'high',
  account: 'AUTO',
  devicePubkey: PK_B,
});
const TRUSTED_POT_CANDIDATE: PotSeatCandidate = { slot: POT_SLOT, potSlug: POT_SLUG, audience: 'trusted-members' };
const WHOLE_POT_CANDIDATE: PotSeatCandidate = { slot: POT_SLOT, potSlug: POT_SLUG, audience: 'whole-pot' };

function requestRecord(over: {
  status?: 'open' | 'paused' | 'cancelled';
  payload?: Partial<NonNullable<WorkOfferStoreRecord['spawnRequest']>>;
} = {}): WorkOfferStoreRecord {
  return {
    offerId: 'spawnreq-0123456789abcdef',
    publisherGithubUserId: UID_A,
    fleetSlug: 'alpha',
    potSlug: null,
    kind: 'spawn_request',
    status: over.status ?? 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: null,
    spawnRequest: {
      targetPublisherGithubUserId: UID_B,
      targetOfferId: TARGET_OFFER_ID,
      count: 2,
      planSlug: 'plan-x-2026-07-04',
      requesterOwnerId: 'su-a',
      requestedAtMs: NOW - 60_000,
      launchContext: null,
      ...over.payload,
    },
    recordVersion: 1,
  };
}

describe('evaluateSpawnRequestTarget (pure)', () => {
  const base = { selfGithubUserId: UID_B, selfDevicePubkey: PK_B, slots: [SLOT], nowMs: NOW };

  it('matches this host via the M19 offer-id re-derivation', () => {
    const res = evaluateSpawnRequestTarget({ record: requestRecord(), ...base });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.slot.ref).toBe('haiku:low:AUTO');
  });

  it("silently skips what is not this host's to judge (wrong kind / not open / another target)", () => {
    const seat = { ...requestRecord(), kind: 'seat' as const, spawnRequest: null };
    expect(evaluateSpawnRequestTarget({ record: seat, ...base })).toMatchObject({
      ok: false,
      code: 'not_spawn_request',
      disposition: null,
    });
    expect(evaluateSpawnRequestTarget({ record: requestRecord({ status: 'cancelled' }), ...base })).toMatchObject({
      ok: false,
      code: 'not_open',
      disposition: null,
    });
    expect(
      evaluateSpawnRequestTarget({
        record: requestRecord({ payload: { targetPublisherGithubUserId: 42 } }),
        ...base,
      }),
    ).toMatchObject({ ok: false, code: 'not_target', disposition: null });
  });

  it('refuses a stale request (the late-flag-flip fence) and a future-dated one', () => {
    expect(
      evaluateSpawnRequestTarget({
        record: requestRecord({ payload: { requestedAtMs: NOW - SPAWN_REQUEST_HONOR_WINDOW_MS - 1 } }),
        ...base,
      }),
    ).toMatchObject({ ok: false, code: 'expired', disposition: 'refused:expired' });
    expect(
      evaluateSpawnRequestTarget({
        record: requestRecord({ payload: { requestedAtMs: NOW + 11 * 60_000 } }),
        ...base,
      }),
    ).toMatchObject({ ok: false, code: 'expired', disposition: 'refused:expired' });
  });

  it('refuses when no local delegation matches (revoked since / different device)', () => {
    expect(
      evaluateSpawnRequestTarget({ record: requestRecord(), ...base, slots: [] }),
    ).toMatchObject({ ok: false, code: 'seat_ref_unknown', disposition: 'refused:seat_ref_unknown' });
    expect(
      evaluateSpawnRequestTarget({ record: requestRecord(), ...base, selfDevicePubkey: 'other-device' }),
    ).toMatchObject({ ok: false, code: 'seat_ref_unknown', disposition: 'refused:seat_ref_unknown' });
  });

  it('a fleet-scoped match carries potMatch: null (P-003 — no audience concept)', () => {
    const res = evaluateSpawnRequestTarget({ record: requestRecord(), ...base });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.potMatch).toBeNull();
  });

  it('matches a POT-scoped candidate via the potSlug-scope re-derivation and surfaces potMatch (P-003)', () => {
    const potRecord = requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } });
    const res = evaluateSpawnRequestTarget({
      record: potRecord,
      selfGithubUserId: UID_B,
      selfDevicePubkey: PK_B,
      slots: [SLOT], // present but doesn't match — proves the pot leg is tried independently
      potSlots: [TRUSTED_POT_CANDIDATE],
      nowMs: NOW,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slot.ref).toBe('sonnet:high:AUTO');
      expect(res.potMatch).toEqual({ potSlug: POT_SLUG, audience: 'trusted-members' });
    }
  });

  it('tries every pot candidate — a non-matching one first does not block a later match', () => {
    const otherPotSlot: SeatSlot = { ref: 'opus:xhigh:AUTO', model: 'opus', effort: 'xhigh', account: 'AUTO', quantity: 1 };
    const otherCandidate: PotSeatCandidate = { slot: otherPotSlot, potSlug: 'other-pot', audience: 'whole-pot' };
    const potRecord = requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } });
    const res = evaluateSpawnRequestTarget({
      record: potRecord,
      selfGithubUserId: UID_B,
      selfDevicePubkey: PK_B,
      slots: [],
      potSlots: [otherCandidate, TRUSTED_POT_CANDIDATE],
      nowMs: NOW,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.potMatch).toEqual({ potSlug: POT_SLUG, audience: 'trusted-members' });
  });

  it('no fleet OR pot candidate matches ⇒ seat_ref_unknown', () => {
    const potRecord = requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } });
    const res = evaluateSpawnRequestTarget({
      record: potRecord,
      selfGithubUserId: UID_B,
      selfDevicePubkey: PK_B,
      slots: [SLOT],
      potSlots: [{ ...TRUSTED_POT_CANDIDATE, potSlug: 'wrong-pot' }],
      nowMs: NOW,
    });
    expect(res).toMatchObject({ ok: false, code: 'seat_ref_unknown', disposition: 'refused:seat_ref_unknown' });
  });
});

// ── IO orchestration ─────────────────────────────────────────────────────────

const ALLOTMENT = {
  resourceKind: 'agent_slot',
  quantity: 3,
  axis: { model: 'haiku', effort: 'low', account: 'AUTO' },
  resourceRef: 'haiku:low:AUTO',
  fleetSlug: 'alpha',
};
const AVAILABILITY = [{ ...SLOT, consumed: 0, available: 3 }];

function row(record: WorkOfferStoreRecord = requestRecord()) {
  return {
    publisher_github_user_id: record.publisherGithubUserId,
    offer_id: record.offerId,
    record_json: JSON.stringify(record),
    // Every fixture in this file is a fleet-scoped spawn_request (fleetSlug: 'alpha',
    // never null) — the cast matches honorSpawnRequestFromProjection's row.fleet_slug: string.
    fleet_slug: record.fleetSlug as string,
  };
}

function deps(over: Partial<Record<keyof DelegatedSpawnHonorDeps, any>> = {}) {
  const setDisposition = vi.fn(async () => true);
  const spawnMembers = vi.fn(async () => ({ opened: 2, failed: 0, firstError: null }));
  // The `_args` parameter is load-bearing for TYPES, not behaviour: declared
  // zero-arg, the mock's calls are typed `[]`, so reading back the emitted
  // receipt (`emitReceipt.mock.calls[0]![0]`) is a TS2493 tuple-index error.
  // The honored-receipt tests assert on the emitted payload's CONTENT, so they
  // need that read (EI-19333624101736074).
  const emitReceipt = vi.fn(async (_args?: any) => ({ ok: true }) as any);
  // Passing runtime probe by default so honor tests never depend on whether the
  // TEST host has `claude`/`omp` on its login PATH (WI-5306). The absent-runtime
  // path is covered by its own test that injects a failing probe.
  const probeAgentRuntime = vi.fn(async () => ({ resolved: true, detail: 'ok' }));
  // Pass-through account resolution by default (WI-5316) so honor tests neither hit
  // PG (the real pool loader) nor depend on the TEST host's login — the account the
  // seat pins survives verbatim. The downgrade/refuse paths get their own tests.
  const resolveHonorAccount = vi.fn(async (requestedAccount: string) => ({ ok: true as const, account: requestedAccount }));
  // P-003: default pass-through — no existing (fleet-scoped) test's potMatch is ever
  // non-null, so these are never invoked by them; the audience-gate tests below
  // override with fail cases.
  const isTrustedUser = vi.fn(async () => true);
  const isPotMember = vi.fn(async () => true);
  const verifyLocalMemberBoot = vi.fn(async () => ({
    observed: true,
    detail: "member su-boot took a tool-backed turn in 'alpha' locally",
  }));
  // P-017: the fixture seat is `AUTO`, and seatLaunchOpts maps AUTO→'auto', so
  // EVERY honor test here routes through the gateway pool ⇒ billing mode
  // 'pool-with-attribution' ⇒ the M17 single-owner reading is consulted. Default
  // it to a readable single-owner pool for the same reason probeAgentRuntime and
  // resolveHonorAccount are defaulted: these tests are pure DI (no PG), and the
  // real reader dynamic-imports the account-resolver. The unknown-pool refusal
  // and its positive control get their own tests below.
  const resolveBillingPool = vi.fn(async () => ({ singleOwner: true }));
  const d: DelegatedSpawnHonorDeps = {
    hostAccepts: vi.fn(async () => true),
    resolveActor: vi.fn(async () => ({ githubUserId: UID_B })) as any,
    resolveDevicePubkey: vi.fn(async () => PK_B),
    listAllotments: vi.fn(async () => [ALLOTMENT]) as any,
    availabilityForFleet: vi.fn(async () => AVAILABILITY) as any,
    setDisposition,
    spawnMembers,
    emitReceipt,
    getBuildInfo: vi.fn(() => ({ sha: 'buildabc', version: '0.0.13' })),
    probeAgentRuntime,
    resolveHonorAccount,
    isTrustedUser,
    isPotMember,
    verifyLocalMemberBoot,
    resolveBillingPool,
    nowMs: () => NOW,
    ...over,
  };
  return {
    d,
    setDisposition,
    spawnMembers,
    emitReceipt,
    probeAgentRuntime,
    resolveHonorAccount,
    isTrustedUser,
    isPotMember,
    verifyLocalMemberBoot,
    resolveBillingPool,
  };
}

const ARGS = { workspaceId: WS, potHomeSlug: HOME, row: row() };

// ── P-003: pot-scoped honor IO fixtures ──────────────────────────────────────
const POT_ALLOTMENT = (audience: 'trusted-members' | 'whole-pot') => ({
  resourceKind: 'agent_slot',
  quantity: 5,
  axis: { model: 'sonnet', effort: 'high', account: 'AUTO' },
  resourceRef: 'sonnet:high:AUTO',
  fleetSlug: null,
  potSlug: POT_SLUG,
  audience,
});
const POT_AVAILABILITY = [{ ...POT_SLOT, consumed: 0, available: 5 }];

/** listAllotments mock that mirrors the real store: a fleetSlug-filtered call
 *  sees only fleet rows; the whole-board call (P-003, no filter) sees everything. */
function potAwareListAllotments(audience: 'trusted-members' | 'whole-pot') {
  return vi.fn(async (a: { fleetSlug?: string; potSlug?: string }) =>
    a.fleetSlug ? [ALLOTMENT] : [ALLOTMENT, POT_ALLOTMENT(audience)],
  );
}

const potRow = row(requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } }));

describe('honorSpawnRequestFromProjection', () => {
  it('gate OFF ⇒ total silence: no disposition, no receipt, no spawn', async () => {
    const { d, setDisposition, spawnMembers, emitReceipt } = deps({ hostAccepts: vi.fn(async () => false) });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'gate_off' });
    expect(setDisposition).not.toHaveBeenCalled();
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(emitReceipt).not.toHaveBeenCalled();
  });

  it('honors: claim → spawn → honored, with the seat pins from the matched slot', async () => {
    const { d, setDisposition, spawnMembers } = deps();
    const res = await honorSpawnRequestFromProjection(ARGS, d);
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(setDisposition).toHaveBeenNthCalledWith(1, WS, HOME, UID_A, 'spawnreq-0123456789abcdef', 'honoring', undefined, undefined);
    expect(setDisposition).toHaveBeenNthCalledWith(2, WS, HOME, UID_A, 'spawnreq-0123456789abcdef', 'honored', { expect: 'honoring' }, undefined);
    expect(spawnMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        fleetSlug: 'alpha',
        planSlug: 'plan-x-2026-07-04',
        count: 2,
        seatRef: 'haiku:low:AUTO',
        launch: { model: 'haiku:low', account: 'auto' },
        requesterOwnerId: 'su-a',
        potHomeSlug: HOME,
        workspaceId: WS,
      }),
    );
  });

  // EI-19333624101736074: the success must FEDERATE. local_disposition is
  // host-local, so without this receipt a completed honor is indistinguishable
  // from a request nobody picked up.
  it('honors ⇒ emits a federated kind=honored receipt naming the account (EI-19333624101736074)', async () => {
    const { d, emitReceipt } = deps();
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(emitReceipt).toHaveBeenCalledOnce();
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'honored',
        offerId: 'spawnreq-0123456789abcdef',
        action: 'delegated-seat:spawn',
        workspaceId: WS,
        potSlug: HOME,
        requester: expect.objectContaining({ ref: 'su-a', githubUserId: UID_A }),
      }),
    );
    // A success carries NO structured refusal — that is what keeps it out of
    // the refused-op counters and out of p2p:trace's refusal reading.
    const emitted = emitReceipt.mock.calls[0]![0] as { refusal?: unknown; detail: string };
    expect(emitted.refusal).toBeUndefined();
    expect(emitted.detail).toContain("account='auto'");
    expect(emitted.detail).toContain('opened 2/2');
    expect(emitted.detail).toContain('[responder-build sha=buildabc version=0.0.13]');
  });

  it('honors with an auto→default downgrade ⇒ the receipt names the substitution', async () => {
    const resolveHonorAccount = vi.fn(async () => ({
      ok: true as const,
      account: 'default',
      note: "downgraded --account=auto → default: this host's gateway pool is empty",
    }));
    const { d, emitReceipt } = deps({ resolveHonorAccount });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    const emitted = emitReceipt.mock.calls[0]![0] as { kind: string; detail: string };
    expect(emitted.kind).toBe('honored');
    expect(emitted.detail).toContain("account='default'");
    expect(emitted.detail).toContain('gateway pool is empty');
  });

  it('the honored receipt carries first-turn evidence and reports a partial open', async () => {
    const { d, emitReceipt } = deps({
      spawnMembers: vi.fn(async () => ({ opened: 1, failed: 1, firstError: 'second window failed' })),
    });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'honored', opened: 1, failed: 1, committedSeats: 1 });
    const emitted = emitReceipt.mock.calls[0]![0] as { detail: string };
    expect(emitted.detail).toContain('opened 1/2');
    expect(emitted.detail).toContain('1 FAILED to open');
    expect(emitted.detail).toMatch(/first-turn check CONFIRMED/i);
  });

  describe('all-platform first-turn verification (D-029 / WI-35786)', () => {
    it('member CONFIRMED by a tool call: honors and the receipt names the proof', async () => {
      const verifyLocalMemberBoot = vi.fn(async () => ({
        observed: true,
        detail: "member su-abc took a tool-backed turn in 'alpha' locally",
      }));
      const { d, setDisposition, emitReceipt } = deps({ verifyLocalMemberBoot });
      expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
      expect(verifyLocalMemberBoot).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, fleetSlug: row().fleet_slug, sinceMs: NOW }),
      );
      expect(setDisposition).toHaveBeenLastCalledWith(WS, HOME, UID_A, row().offer_id, 'honored', { expect: 'honoring' }, undefined);
      const emitted = emitReceipt.mock.calls[0]![0] as { detail: string };
      expect(emitted.detail).toMatch(/first-turn check CONFIRMED/i);
      expect(emitted.detail).toContain('tool-backed turn');
    });

    it('presence/window without a tool call: fails closed and federates member_boot_unconfirmed', async () => {
      const verifyLocalMemberBoot = vi.fn(async () => ({
        observed: false,
        detail: "member su-phantom registered presence in 'alpha', but no tool invocation was attributed",
      }));
      const { d, setDisposition, emitReceipt } = deps({ verifyLocalMemberBoot });
      expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({
        outcome: 'refused',
        code: 'member_boot_unconfirmed',
      });
      expect(setDisposition).toHaveBeenLastCalledWith(
        WS,
        HOME,
        UID_A,
        row().offer_id,
        'refused:member_boot_unconfirmed',
        { expect: 'honoring' },
        undefined,
      );
      expect(emitReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'refusal',
          refusal: expect.objectContaining({
            code: 'member_boot_unconfirmed',
            detail: expect.stringContaining('no tool invocation was attributed'),
          }),
        }),
      );
    });

    it('presence/window followed by an exit-zero OAuth failure: attributes account_unfulfillable', async () => {
      const resolveHonorAccount = vi.fn(async () => ({
        ok: true as const,
        account: 'default',
        downgradedFrom: 'auto' as const,
        loginEvidence: 'assumed-darwin-keychain' as const,
      }));
      const verifyLocalMemberBoot = vi.fn(async () => ({
        observed: false,
        ownerId: 'su-dead-member',
        detail: "member su-dead-member registered presence in 'alpha', but no tool invocation was attributed",
        failureDetail: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }));
      const { d, setDisposition, emitReceipt } = deps({ resolveHonorAccount, verifyLocalMemberBoot });

      expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({
        outcome: 'refused',
        code: 'account_unfulfillable',
      });
      expect(setDisposition).toHaveBeenLastCalledWith(
        WS,
        HOME,
        UID_A,
        row().offer_id,
        'refused:account_unfulfillable',
        { expect: 'honoring' },
        undefined,
      );
      expect(emitReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'refusal',
          refusal: expect.objectContaining({
            code: 'account_unfulfillable',
            detail: expect.stringMatching(/could not AUTHENTICATE/),
          }),
        }),
      );
    });

    it('an all-fail spawn never calls verifyLocalMemberBoot (refusal path is unaffected)', async () => {
      const verifyLocalMemberBoot = vi.fn(async () => ({ observed: true, detail: 'unused' }));
      const { d } = deps({
        verifyLocalMemberBoot,
        spawnMembers: vi.fn(async () => ({ opened: 0, failed: 2, firstError: 'no display' })),
      });
      expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'refused', code: 'spawn_failed' });
      expect(verifyLocalMemberBoot).not.toHaveBeenCalled();
    });
  });

  describe('defaultVerifyLocalMemberBoot first-turn oracle', () => {
    it('refuses a fresh presence-only row with no attributed tool invocation', async () => {
      const startedAt = new Date(NOW + 1);
      await expect(
        defaultVerifyLocalMemberBoot({
          workspaceId: WS,
          fleetSlug: 'alpha',
          sinceMs: NOW,
          windowMs: 0,
          listPresence: vi.fn(async () => [
            {
              ownerId: 'su-phantom',
              startedAt,
              heartbeatAt: new Date(NOW + 2),
              lastToolCallAt: null,
            },
          ]),
        }),
      ).resolves.toMatchObject({ observed: false, detail: expect.stringMatching(/presence.*no tool invocation/i) });
    });

    it('carries a fresh member transcript failure into the post-spawn verdict', async () => {
      const startedAt = new Date(NOW + 1);
      const readMemberFailure = vi.fn(async () =>
        'Failed to authenticate: OAuth session expired and could not be refreshed',
      );
      await expect(
        defaultVerifyLocalMemberBoot({
          workspaceId: WS,
          fleetSlug: 'alpha',
          sinceMs: NOW,
          windowMs: 0,
          listPresence: vi.fn(async () => [
            {
              ownerId: 'su-dead-member',
              startedAt,
              heartbeatAt: new Date(NOW + 2),
              lastToolCallAt: null,
            },
          ]),
          readMemberFailure,
        }),
      ).resolves.toMatchObject({
        observed: false,
        ownerId: 'su-dead-member',
        failureDetail: expect.stringMatching(/OAuth session expired/),
      });
      expect(readMemberFailure).toHaveBeenCalledWith('su-dead-member');
    });

    it('accepts only when the fresh owner has a post-start attributed tool invocation', async () => {
      const startedAt = new Date(NOW + 1);
      const lastToolCallAt = new Date(NOW + 2);
      await expect(
        defaultVerifyLocalMemberBoot({
          workspaceId: WS,
          fleetSlug: 'alpha',
          sinceMs: NOW,
          windowMs: 0,
          listPresence: vi.fn(async () => [
            {
              ownerId: 'su-real',
              startedAt,
              heartbeatAt: lastToolCallAt,
              lastToolCallAt,
            },
          ]),
        }),
      ).resolves.toMatchObject({ observed: true, detail: expect.stringMatching(/tool-backed turn/i) });
    });
  });

  it('a lost claim race ⇒ already_claimed, no spawn (double-apply cannot double-spawn)', async () => {
    const { d, spawnMembers } = deps({ setDisposition: vi.fn(async () => false) });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'already_claimed' });
    expect(spawnMembers).not.toHaveBeenCalled();
  });

  it('an all-fail spawn ⇒ refused:spawn_failed + a federated receipt (D-004 loud)', async () => {
    const { d, setDisposition, emitReceipt } = deps({
      spawnMembers: vi.fn(async () => ({ opened: 0, failed: 2, firstError: 'no display' })),
    });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'refused', code: 'spawn_failed' });
    expect(setDisposition).toHaveBeenLastCalledWith(WS, HOME, UID_A, 'spawnreq-0123456789abcdef', 'refused:spawn_failed', { expect: 'honoring' }, undefined);
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        action: 'delegated-seat:spawn',
        offerId: 'spawnreq-0123456789abcdef',
        refusal: expect.objectContaining({ code: 'spawn_failed' }),
      }),
    );
    const emitted = emitReceipt.mock.calls[0]![0] as { detail: string };
    expect(emitted.detail).toContain('no display');
    expect(emitted.detail).toContain('[responder-build sha=buildabc version=0.0.13]');
  });

  it('an identity-less responder emits explicit unknown build evidence on a real refusal path', async () => {
    const { d, emitReceipt } = deps({
      getBuildInfo: vi.fn(() => ({ sha: null, version: '0.0.13' })),
      availabilityForFleet: vi.fn(async () => [{ ...SLOT, consumed: 3, available: 0 }]) as any,
    });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'refused', code: 'seats_exhausted' });
    const emitted = emitReceipt.mock.calls[0]![0] as { detail: string };
    expect(emitted.detail).toContain('[responder-build sha=unknown version=0.0.13]');
  });

  it('a member that BOOTS and dies on auth ⇒ refused:account_unfulfillable, not spawn_failed (EI-19331694139523035)', async () => {
    // The live rig failure end-to-end: the pool is empty, honor substitutes the
    // local login, the member launches, joins, then dies on auth. Before this the
    // requester was told `honored (1 member(s) opened)`; now the honoring host
    // refuses with the code that names WHICH knob to turn.
    const resolveHonorAccount = vi.fn(async () => ({
      ok: true as const,
      account: 'default',
      downgradedFrom: 'auto' as const,
      loginEvidence: 'credentials-file' as const,
      note: 'downgraded --account=auto → default',
    }));
    const { d, setDisposition, emitReceipt } = deps({
      resolveHonorAccount,
      spawnMembers: vi.fn(async () => ({
        opened: 0,
        failed: 2,
        firstError:
          'headless member launched but its agent command died at boot (exit 1) — log tail: ' +
          'Failed to authenticate: OAuth session expired and could not be refreshed',
      })),
    });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({
      outcome: 'refused',
      code: 'account_unfulfillable',
    });
    expect(setDisposition).toHaveBeenLastCalledWith(
      WS, HOME, UID_A, 'spawnreq-0123456789abcdef', 'refused:account_unfulfillable', { expect: 'honoring' }, undefined,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        refusal: expect.objectContaining({
          code: 'account_unfulfillable',
          detail: expect.stringContaining('SUBSTITUTED its local system login'),
        }),
      }),
    );
  });

  it('exhausted seats ⇒ refused with the seat-accounting code + receipt, no spawn', async () => {
    const { d, spawnMembers, emitReceipt } = deps({
      availabilityForFleet: vi.fn(async () => [{ ...SLOT, consumed: 3, available: 0 }]) as any,
    });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({ outcome: 'refused', code: 'seats_exhausted' });
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(emitReceipt).toHaveBeenCalledOnce();
  });

  it('a stale request ⇒ refused:expired + receipt, no spawn', async () => {
    const stale = requestRecord({ payload: { requestedAtMs: NOW - SPAWN_REQUEST_HONOR_WINDOW_MS - 1 } });
    const { d, spawnMembers, emitReceipt } = deps();
    expect(await honorSpawnRequestFromProjection({ ...ARGS, row: row(stale) }, d)).toEqual({
      outcome: 'refused',
      code: 'expired',
    });
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(emitReceipt).toHaveBeenCalledOnce();
  });

  it("someone else's request ⇒ silent skip (no disposition, no receipt)", async () => {
    const other = requestRecord({ payload: { targetPublisherGithubUserId: 42 } });
    const { d, setDisposition, emitReceipt } = deps();
    expect(await honorSpawnRequestFromProjection({ ...ARGS, row: row(other) }, d)).toEqual({
      outcome: 'skipped',
      reason: 'not_target',
    });
    expect(setDisposition).not.toHaveBeenCalled();
    expect(emitReceipt).not.toHaveBeenCalled();
  });

  it('a host missing the seat agent CLI ⇒ refused:agent_runtime_missing + receipt, never claimed or spawned (WI-5306)', async () => {
    const probeAgentRuntime = vi.fn(async () => ({ resolved: false, detail: "this host cannot run a 'claude' member" }));
    const { d, setDisposition, spawnMembers, emitReceipt } = deps({ probeAgentRuntime });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({
      outcome: 'refused',
      code: 'agent_runtime_missing',
    });
    // Probed with the model resolved from the matched slot (haiku:low here).
    expect(probeAgentRuntime).toHaveBeenCalledWith('haiku:low');
    // Refused straight from the null disposition — the 'honoring' claim never runs,
    // so a phantom spawn can never happen.
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(setDisposition).toHaveBeenCalledTimes(1);
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HOME,
      UID_A,
      'spawnreq-0123456789abcdef',
      'refused:agent_runtime_missing',
      undefined,
      undefined,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        action: 'delegated-seat:spawn',
        offerId: 'spawnreq-0123456789abcdef',
        refusal: expect.objectContaining({ code: 'agent_runtime_missing' }),
      }),
    );
  });

  it('an unfulfillable seat account ⇒ refused:account_unfulfillable + receipt, never claimed or spawned (WI-5316)', async () => {
    const resolveHonorAccount = vi.fn(async () => ({
      ok: false as const,
      code: 'account_unfulfillable' as const,
      detail: "seat requests --account=auto but this host has no registered claude pool account AND no usable local login",
    }));
    const { d, setDisposition, spawnMembers, emitReceipt } = deps({ resolveHonorAccount });
    expect(await honorSpawnRequestFromProjection(ARGS, d)).toEqual({
      outcome: 'refused',
      code: 'account_unfulfillable',
    });
    // Resolved with the account the seat pins ('auto' here) + this workspace.
    expect(resolveHonorAccount).toHaveBeenCalledWith('auto', WS);
    // Refused from the null disposition, before the 'honoring' claim — no phantom spawn.
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(setDisposition).toHaveBeenCalledTimes(1);
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HOME,
      UID_A,
      'spawnreq-0123456789abcdef',
      'refused:account_unfulfillable',
      undefined,
      undefined,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        action: 'delegated-seat:spawn',
        refusal: expect.objectContaining({ code: 'account_unfulfillable' }),
      }),
    );
  });

  it('a downgraded account (auto→default) threads into the spawn launch, not the raw seat account (WI-5316)', async () => {
    const resolveHonorAccount = vi.fn(async () => ({
      ok: true as const,
      account: 'default',
      downgradedFrom: 'auto' as const,
      note: 'downgraded --account=auto → default: no registered claude pool account',
    }));
    const { d, spawnMembers } = deps({ resolveHonorAccount });
    const res = await honorSpawnRequestFromProjection(ARGS, d);
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(spawnMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        // the seat is AUTO, but the honor-resolved account overrides it
        seatRef: 'haiku:low:AUTO',
        launch: { model: 'haiku:low', account: 'default' },
      }),
    );
  });
});

// ── P-003: the audience gate ─────────────────────────────────────────────────

describe('honorSpawnRequestFromProjection — the P-003 audience gate', () => {
  it("a pot-scoped offer with audience 'trusted-members': requester on the trust list ⇒ honored, checked via isTrustedUser (not isPotMember)", async () => {
    const { d, isTrustedUser, isPotMember, spawnMembers } = deps({
      listAllotments: potAwareListAllotments('trusted-members'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any,
    });
    const res = await honorSpawnRequestFromProjection({ ...ARGS, row: potRow }, d);
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(isTrustedUser).toHaveBeenCalledWith(WS, UID_A); // UID_A = the requester (spawn_request publisher)
    expect(isPotMember).not.toHaveBeenCalled();
    expect(spawnMembers).toHaveBeenCalledWith(expect.objectContaining({ seatRef: 'sonnet:high:AUTO' }));
  });

  it("a pot-scoped offer with audience 'whole-pot': requester is a pot member ⇒ honored, checked via isPotMember (not isTrustedUser)", async () => {
    const { d, isTrustedUser, isPotMember } = deps({
      listAllotments: potAwareListAllotments('whole-pot'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any,
    });
    const res = await honorSpawnRequestFromProjection({ ...ARGS, row: potRow }, d);
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(isPotMember).toHaveBeenCalledWith(WS, POT_SLUG, UID_A);
    expect(isTrustedUser).not.toHaveBeenCalled();
  });

  it("'trusted-members' refused ⇒ audience_refused, LOUD receipt, no claim/spawn (D-002/D-003 fail-closed)", async () => {
    const { d, setDisposition, spawnMembers, emitReceipt } = deps({
      listAllotments: potAwareListAllotments('trusted-members'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any,
      isTrustedUser: vi.fn(async () => false),
    });
    const res = await honorSpawnRequestFromProjection({ ...ARGS, row: potRow }, d);
    expect(res).toEqual({ outcome: 'refused', code: 'audience_refused' });
    // Refused straight from the null disposition — no 'honoring' claim, no phantom spawn.
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(setDisposition).toHaveBeenCalledTimes(1);
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HOME,
      UID_A,
      'spawnreq-0123456789abcdef',
      'refused:audience_refused',
      undefined,
      undefined,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        action: 'delegated-seat:spawn',
        offerId: 'spawnreq-0123456789abcdef',
        refusal: expect.objectContaining({ code: 'audience_refused' }),
      }),
    );
  });

  it("'whole-pot' refused (not a pot member) ⇒ audience_refused, LOUD receipt, no claim/spawn", async () => {
    const { d, spawnMembers, emitReceipt } = deps({
      listAllotments: potAwareListAllotments('whole-pot'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any,
      isPotMember: vi.fn(async () => false),
    });
    const res = await honorSpawnRequestFromProjection({ ...ARGS, row: potRow }, d);
    expect(res).toEqual({ outcome: 'refused', code: 'audience_refused' });
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ refusal: expect.objectContaining({ code: 'audience_refused' }) }),
    );
  });

  it('a FLEET-scoped request never calls the audience gate (potMatch null ⇒ skipped entirely)', async () => {
    const { d, isTrustedUser, isPotMember, spawnMembers } = deps();
    const res = await honorSpawnRequestFromProjection(ARGS, d); // ARGS.row is the fleet-scoped fixture
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
    expect(isTrustedUser).not.toHaveBeenCalled();
    expect(isPotMember).not.toHaveBeenCalled();
    expect(spawnMembers).toHaveBeenCalled();
  });

  // WI-5408: trust-revoked-BETWEEN-offer-and-claim. The offer is published once
  // while the requester is trusted; the audience gate is re-consulted on EVERY
  // claim against the LIVE trust state (delegated-spawn-honor.ts §Gate 2.5/3.5:
  // "a trust revocation takes effect on the very next claim with no offer
  // republish"). Two distinct requests from the SAME requester drawing the SAME
  // pot offer, with trust flipped between them, prove the gate is not cached at
  // offer time: request-1 (trusted) is honored, request-2 (trust since revoked)
  // fail-closes with a loud receipt — no republish needed.
  it('trust revoked between two claims of one pot offer ⇒ first honored, second audience_refused (live per-claim re-read)', async () => {
    const isTrustedUser = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { d, spawnMembers, emitReceipt, setDisposition } = deps({
      listAllotments: potAwareListAllotments('trusted-members'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any, // seats never the cause here
      isTrustedUser,
    });

    const first = await honorSpawnRequestFromProjection(
      { ...ARGS, row: row(requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } })) },
      d,
    );
    expect(first).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });

    // A SECOND, distinct spawn-request (different offer id) from the SAME requester
    // (UID_A) for the SAME pot offer — trust has since been revoked.
    const secondRecord = {
      ...requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } }),
      offerId: 'spawnreq-second-claim-0002',
    };
    const second = await honorSpawnRequestFromProjection({ ...ARGS, row: row(secondRecord) }, d);
    expect(second).toEqual({ outcome: 'refused', code: 'audience_refused' });

    // The gate was consulted PER CLAIM with the same requester subject both times —
    // the second read saw the revocation (nothing about the offer changed).
    expect(isTrustedUser).toHaveBeenCalledTimes(2);
    expect(isTrustedUser).toHaveBeenNthCalledWith(1, WS, UID_A);
    expect(isTrustedUser).toHaveBeenNthCalledWith(2, WS, UID_A);
    // Only the first claim spawned; the revoked claim never did, and it disposed loud.
    expect(spawnMembers).toHaveBeenCalledTimes(1);
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HOME,
      UID_A,
      'spawnreq-second-claim-0002',
      'refused:audience_refused',
      undefined,
      undefined,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ refusal: expect.objectContaining({ code: 'audience_refused' }) }),
    );
  });
});

// ── WI-5408: the over-draw race (two fleets racing one pot offer) ─────────────
//
// Two DIFFERENT fleets each send a spawn-request drawing on the SAME pot seat
// offer. Their spawn-request records carry DIFFERENT offer ids, so Gate 5's
// per-offer atomic claim (setDisposition WHERE NULL) does NOT serialize them —
// what protects the pot's seat cap is Gate 4 (resolveSeatLaunch over
// seatAvailabilityForFleet). This pins that the honor path REFUSES THE LOSER
// LOUDLY (seats_exhausted + federated receipt, no spawn) once the winner's
// members have consumed the shared seats.
//
// SCOPE (honest): this proves the honor path RESPECTS the availability gate. The
// hard "exactly one wins under a genuinely simultaneous race" guarantee is
// consumeSeatAtBoot's atomic conditional INSERT (seat-accounting.ts; its live
// cap enforcement is a PG-integration concern), re-enforced at each member boot
// regardless of this pre-check. The pure cap-math invariant behind it is the
// property test below.
describe('honorSpawnRequestFromProjection — WI-5408 over-draw race (two fleets, one pot offer)', () => {
  const potReqRow = (offerId: string, fleetSlug: string) =>
    row({
      ...requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID } }),
      offerId,
      fleetSlug,
    });

  it('winner honored; the loser (seats already consumed) is refused seats_exhausted LOUD, never spawns', async () => {
    // availabilityForFleet: full for the winner, exhausted by the time the loser is
    // evaluated (the winner's members have taken the shared pot seats).
    const availabilityForFleet = vi
      .fn()
      .mockResolvedValueOnce(POT_AVAILABILITY) // fleet 'alpha' (winner): 5 free
      .mockResolvedValue([{ ...POT_SLOT, consumed: 5, available: 0 }]); // fleet 'beta' (loser): 0 free
    const { d, spawnMembers, emitReceipt, setDisposition } = deps({
      listAllotments: potAwareListAllotments('trusted-members'),
      availabilityForFleet: availabilityForFleet as any,
    });

    const winner = await honorSpawnRequestFromProjection(
      { ...ARGS, row: potReqRow('spawnreq-alpha-0001', 'alpha') },
      d,
    );
    expect(winner).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });

    const loser = await honorSpawnRequestFromProjection(
      { ...ARGS, row: potReqRow('spawnreq-beta-0002', 'beta') },
      d,
    );
    expect(loser).toEqual({ outcome: 'refused', code: 'seats_exhausted' });

    // Exactly one spawn happened — the loser never reached the spawner.
    expect(spawnMembers).toHaveBeenCalledTimes(1);
    // The loser refused straight from the null disposition (no dangling 'honoring' claim).
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HOME,
      UID_A,
      'spawnreq-beta-0002',
      'refused:seats_exhausted',
      undefined,
      undefined,
    );
    // ...and told the requester why (D-004 no-silent-drops).
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        action: 'delegated-seat:spawn',
        offerId: 'spawnreq-beta-0002',
        refusal: expect.objectContaining({ code: 'seats_exhausted' }),
      }),
    );
  });

  it('a single over-count request (count > free) is itself refused seats_exhausted before any spawn', async () => {
    // One fleet asks for more than the pot delegated — the N+1 refusal surfaces at
    // the honor layer, loud, with no phantom spawn.
    const over = {
      ...requestRecord({ payload: { targetOfferId: POT_TARGET_OFFER_ID, count: 6 } }),
      offerId: 'spawnreq-overcount-0003',
    };
    const { d, spawnMembers, emitReceipt } = deps({
      listAllotments: potAwareListAllotments('trusted-members'),
      availabilityForFleet: vi.fn(async () => POT_AVAILABILITY) as any, // only 5 free, 6 requested
    });
    const res = await honorSpawnRequestFromProjection({ ...ARGS, row: row(over) }, d);
    expect(res).toEqual({ outcome: 'refused', code: 'seats_exhausted' });
    expect(spawnMembers).not.toHaveBeenCalled();
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ refusal: expect.objectContaining({ code: 'seats_exhausted' }) }),
    );
  });
});

// ── WI-5408: the over-draw invariant, property-based ─────────────────────────
//
// The pure cap math (resolveSeatLaunch over computeSeatAvailability) is what
// makes "exactly one spawn wins the last seat, never over-draw" true regardless
// of how many racers arrive or in what size. Assert it holds for ARBITRARY
// delegated quantities + arbitrary request sequences, not just the hand-picked
// examples above.
describe('over-draw invariant (property): the seat cap math never admits more than Q', () => {
  const REF = 'sonnet:high:AUTO';
  const slotOf = (quantity: number): SeatSlot => ({ ref: REF, model: 'sonnet', effort: 'high', account: 'AUTO', quantity });

  it('greedily honoring any request sequence against one slot never consumes more than the delegated Q', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 15 }),
        (quantity, requestCounts) => {
          const slot = slotOf(quantity);
          let consumed = 0;
          let admittedTotal = 0;
          for (const count of requestCounts) {
            const availability = computeSeatAvailability([slot], new Map([[REF, consumed]]));
            const res = resolveSeatLaunch({ availability, count, seatRef: REF });
            if (res.ok) {
              // admitted ⇒ it fit under the remaining cap
              expect(count).toBeLessThanOrEqual(quantity - consumed);
              consumed += count;
              admittedTotal += count;
            } else {
              // the slot always exists and the ref always matches here, so the ONLY
              // possible refusal is exhaustion — never a spurious other code
              expect(res.refusal.code).toBe('seats_exhausted');
            }
            // THE INVARIANT: consumption can never exceed the delegated quantity,
            // whatever order/size the racers arrive in — no over-draw is representable.
            expect(consumed).toBeLessThanOrEqual(quantity);
          }
          expect(admittedTotal).toBe(consumed);
        },
      ),
    );
  });

  it('the last free seat is won by exactly one count-1 racer; the other is refused seats_exhausted', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (quantity) => {
        const slot = slotOf(quantity);
        // down to exactly one free seat
        const oneFree = computeSeatAvailability([slot], new Map([[REF, quantity - 1]]));
        expect(resolveSeatLaunch({ availability: oneFree, count: 1, seatRef: REF }).ok).toBe(true);
        // the winner's consumption lands ⇒ zero free ⇒ the racer for the same last seat loses, loud
        const none = computeSeatAvailability([slot], new Map([[REF, quantity]]));
        expect(resolveSeatLaunch({ availability: none, count: 1, seatRef: REF })).toMatchObject({
          ok: false,
          refusal: { code: 'seats_exhausted' },
        });
      }),
    );
  });
});

// ── WI-5316: honor-time account resolution (pure) ────────────────────────────

describe('honorAccountRoutingMode (WI-5316, pure — mirrors psu accountRoutingMode)', () => {
  it('classifies the direct-login keywords as default', () => {
    for (const v of ['', 'default', 'none', 'system', 'DEFAULT', '  system  ', null, undefined]) {
      expect(honorAccountRoutingMode(v)).toBe('default');
    }
  });
  it('classifies auto / gateway as auto, everything else as a pin', () => {
    expect(honorAccountRoutingMode('auto')).toBe('auto');
    expect(honorAccountRoutingMode('GATEWAY')).toBe('auto');
    expect(honorAccountRoutingMode('aviynw6')).toBe('pin');
    expect(honorAccountRoutingMode('pool-account-3')).toBe('pin');
  });
});

describe('probeLocalClaudeLogin (WI-5316 + EI-19331694139523035)', () => {
  const home = '/home/x';
  const CRED = '/home/x/.claude/.credentials.json';
  const NOW = 1_785_662_000_000;
  const bundle = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

  it('darwin ⇒ usable, but the evidence SAYS it was assumed rather than probed', () => {
    const r = probeLocalClaudeLogin({ platform: 'darwin', fileExists: () => false });
    expect(r.usable).toBe(true);
    expect(r.evidence).toBe('assumed-darwin-keychain');
    expect(loginEvidenceWasProbed(r.evidence)).toBe(false);
    expect(r.detail).toMatch(/ASSUMED, not verified/);
  });

  it('linux/wsl with no bundle ⇒ absent (a probed negative)', () => {
    const r = probeLocalClaudeLogin({ platform: 'linux', home, fileExists: () => false });
    expect(r).toMatchObject({ usable: false, evidence: 'absent' });
    expect(loginEvidenceWasProbed(r.evidence)).toBe(true);
    expect(probeLocalClaudeLogin({ platform: 'win32', home, fileExists: () => false }).usable).toBe(false);
  });

  it('an UNEXPIRED bundle ⇒ usable, and the detail refuses to overclaim', () => {
    const r = probeLocalClaudeLogin({
      platform: 'linux',
      home,
      nowMs: NOW,
      fileExists: (p) => p === CRED,
      readFile: () => bundle({ expiresAt: NOW + 45 * 60_000, refreshToken: 'rt', subscriptionType: 'max' }),
    });
    expect(r).toMatchObject({ usable: true, evidence: 'credentials-file' });
    expect(r.detail).toMatch(/does NOT prove it authenticates/);
  });

  it('EXPIRED with NO refresh token ⇒ definitively dead, so NOT usable (refuse rather than spawn a doomed member)', () => {
    const r = probeLocalClaudeLogin({
      platform: 'linux',
      home,
      nowMs: NOW,
      fileExists: (p) => p === CRED,
      readFile: () => bundle({ expiresAt: NOW - 90 * 60_000 }),
    });
    expect(r).toMatchObject({ usable: false, evidence: 'expired-unrefreshable' });
    expect(r.detail).toMatch(/expired 90 min ago/);
  });

  it('EXPIRED but holding a refresh token ⇒ still usable (a refresh may succeed — never call it dead)', () => {
    const r = probeLocalClaudeLogin({
      platform: 'linux',
      home,
      nowMs: NOW,
      fileExists: (p) => p === CRED,
      readFile: () => bundle({ expiresAt: NOW - 90 * 60_000, refreshToken: 'rt' }),
    });
    expect(r).toMatchObject({ usable: true, evidence: 'credentials-file' });
  });

  it('unreadable / unparseable / no expiry ⇒ UNKNOWN, never "dead" (fails toward attempting the spawn)', () => {
    const unreadable = probeLocalClaudeLogin({
      platform: 'linux',
      home,
      fileExists: (p) => p === CRED,
      readFile: () => { throw new Error('EACCES'); },
    });
    expect(unreadable).toMatchObject({ usable: true, evidence: 'credentials-file-unverifiable' });
    const garbage = probeLocalClaudeLogin({ platform: 'linux', home, fileExists: (p) => p === CRED, readFile: () => 'not json' });
    expect(garbage).toMatchObject({ usable: true, evidence: 'credentials-file-unverifiable' });
    const noExpiry = probeLocalClaudeLogin({ platform: 'linux', home, fileExists: (p) => p === CRED, readFile: () => bundle({ accessToken: 'x' }) });
    expect(noExpiry).toMatchObject({ usable: true, evidence: 'credentials-file-unverifiable' });
  });

  it('THE WIN RIG CASE: a present, unexpired bundle probes usable — proving no static check can predict a working login', () => {
    // Measured 2026-08-02: expiresAt 1785661012884 (08:56:52Z), member died 08:11:25Z
    // with "OAuth session expired and could not be refreshed" — i.e. INSIDE its
    // validity window. The probe is therefore permitted to say "usable" here; it is
    // classifyHonorSpawnFailure's job to make the resulting death attributable.
    const r = probeLocalClaudeLogin({
      platform: 'linux',
      home,
      nowMs: 1_785_658_285_108, // the real spawn time, 08:11:25Z
      fileExists: (p) => p === CRED,
      readFile: () => bundle({ expiresAt: 1_785_661_012_884, refreshToken: 'rt', subscriptionType: 'max' }),
    });
    expect(r.usable).toBe(true);
  });
});

describe('resolveHonorAccount (WI-5316, pure core)', () => {
  const withPool = (ids: string[], login = true) => ({
    listPoolAccountIds: async () => ids,
    probeLocalLogin: () => (login
      ? { usable: true, evidence: 'credentials-file' as const, detail: 'bundle present' }
      : { usable: false, evidence: 'absent' as const, detail: 'no claude credentials bundle' }),
  });

  it('default route is always fulfillable (no pool needed)', async () => {
    const listPoolAccountIds = vi.fn(async () => [] as string[]);
    const probeLocalLogin = vi.fn(() => ({ usable: true, evidence: 'credentials-file' as const, detail: 'bundle present' }));
    expect(await resolveHonorAccount('default', { listPoolAccountIds, probeLocalLogin })).toEqual({
      ok: true,
      account: 'default',
    });
    expect(await resolveHonorAccount('', { listPoolAccountIds, probeLocalLogin })).toEqual({
      ok: true,
      account: 'default',
    });
    // never even probes the login — the default route does not depend on it
    expect(probeLocalLogin).not.toHaveBeenCalled();
    // never even looks at the pool
    expect(listPoolAccountIds).not.toHaveBeenCalled();
  });

  it('auto with a non-empty pool ⇒ keeps auto', async () => {
    expect(await resolveHonorAccount('auto', withPool(['acct-1']))).toEqual({ ok: true, account: 'auto' });
  });

  it('auto with an empty pool + a local login ⇒ DOWNGRADES to default, CARRYING the login evidence', async () => {
    const r = await resolveHonorAccount('auto', withPool([], true));
    // EI-19331694139523035: the evidence rides on the resolution so a later boot
    // failure can name the substitution instead of reporting a bare spawn_failed.
    expect(r).toMatchObject({ ok: true, account: 'default', downgradedFrom: 'auto', loginEvidence: 'credentials-file' });
    expect((r as { note: string }).note).toContain('auto');
    expect((r as { note: string }).note).toContain('bundle present');
  });

  it('a DEFINITIVELY DEAD credential ⇒ refuses up front rather than downgrading onto it (EI-19331694139523035)', async () => {
    const r = await resolveHonorAccount('auto', {
      listPoolAccountIds: async () => [],
      probeLocalLogin: () => ({
        usable: false,
        evidence: 'expired-unrefreshable' as const,
        detail: 'expired 90 min ago with no refresh token',
      }),
    });
    expect(r).toMatchObject({ ok: false, code: 'account_unfulfillable' });
    // the refusal explains WHAT was checked, not just that it failed
    expect((r as { detail: string }).detail).toContain('expired 90 min ago with no refresh token');
  });

  it('auto with an empty pool + NO local login ⇒ refuses account_unfulfillable', async () => {
    const r = await resolveHonorAccount('auto', withPool([], false));
    expect(r).toMatchObject({ ok: false, code: 'account_unfulfillable' });
    expect((r as { detail: string }).detail).toContain('cannot authenticate');
  });

  it('a pin present in this host pool ⇒ keeps the pin; absent ⇒ refuses (never substituted)', async () => {
    expect(await resolveHonorAccount('acct-2', withPool(['acct-1', 'acct-2']))).toEqual({ ok: true, account: 'acct-2' });
    const r = await resolveHonorAccount('acct-9', withPool(['acct-1'], true));
    expect(r).toMatchObject({ ok: false, code: 'account_unfulfillable' });
    // a pin is NOT downgraded to default even though a login exists
    expect((r as { detail: string }).detail).toContain('acct-9');
  });
});

// ── EI-19331694139523035: attributing a zero-member spawn ────────────────────

describe('classifyHonorSpawnFailure (EI-19331694139523035, pure)', () => {
  const downgraded = { account: 'default', downgradedFrom: 'auto' as const, loginEvidence: 'credentials-file' as const };

  it('THE WIN RIG FAILURE ⇒ account_unfulfillable, not a bare spawn_failed', () => {
    const r = classifyHonorSpawnFailure({
      count: 1,
      firstError:
        'headless member launched but its agent command died at boot (exit 1) — log tail: ' +
        'Failed to authenticate: OAuth session expired and could not be refreshed',
      resolved: downgraded,
    });
    expect(r.code).toBe('account_unfulfillable');
    expect(r.detail).toContain('could not AUTHENTICATE');
    // names the substitution AND the remedy the requester can act on
    expect(r.detail).toContain('SUBSTITUTED its local system login');
    expect(r.detail).toMatch(/accounts:link-start|accounts:register/);
  });

  it('THE MAC RIG FAILURE ⇒ account_unfulfillable', () => {
    const r = classifyHonorSpawnFailure({
      count: 1,
      firstError: 'Your organization has disabled Claude subscription access for Claude Code',
      resolved: { account: 'default', downgradedFrom: 'auto', loginEvidence: 'assumed-darwin-keychain' },
    });
    expect(r.code).toBe('account_unfulfillable');
    // says out loud that the substitution rested on an UNPROBED assumption
    expect(r.detail).toContain('ASSUMED rather than verified');
  });

  it("psu's own gateway refusal ⇒ account_unfulfillable", () => {
    const r = classifyHonorSpawnFailure({
      count: 2,
      firstError: '--account auto could not be honored: no registered pool account',
      resolved: { account: 'auto' },
    });
    expect(r.code).toBe('account_unfulfillable');
  });

  it('HONESTY RULE: a boot death that merely FOLLOWED a substitution is NOT reported as an account failure', () => {
    const r = classifyHonorSpawnFailure({
      count: 1,
      firstError: 'headless psu died at boot (signal SIGKILL) within 1200ms',
      resolved: downgraded,
    });
    // no auth signature ⇒ we do not manufacture a cause we did not observe
    expect(r.code).toBe('spawn_failed');
    // ...but the substitution is still surfaced, as a suspect and not a verdict
    expect(r.detail).toContain('prime suspect but was NOT confirmed');
  });

  it('an ordinary failure with no substitution ⇒ plain spawn_failed, no account noise', () => {
    const r = classifyHonorSpawnFailure({
      count: 3,
      firstError: 'no terminal emulator found',
      resolved: { account: 'default' },
    });
    expect(r.code).toBe('spawn_failed');
    expect(r.detail).toBe('all 3 member spawn(s) failed on the honoring host: no terminal emulator found');
  });

  it('a missing error string never crashes the classifier', () => {
    expect(classifyHonorSpawnFailure({ count: 1, firstError: null, resolved: { account: 'default' } })).toEqual({
      code: 'spawn_failed',
      detail: 'all 1 member spawn(s) failed on the honoring host',
    });
  });
});

// ── WI-5306: the agent-runtime preflight itself ──────────────────────────────

describe('classifyRuntimeProbe (WI-5306, pure)', () => {
  it('exit 0 (err null) ⇒ resolved', () => {
    expect(classifyRuntimeProbe('claude', null)).toEqual({
      resolved: true,
      detail: expect.stringContaining('resolvable'),
    });
  });

  it('a numeric non-zero exit ⇒ NOT resolved — a definitive command-not-found', () => {
    const r = classifyRuntimeProbe('claude', { code: 1 });
    expect(r.resolved).toBe(false);
    expect(r.detail).toContain("cannot run a 'claude' member");
    expect(r.detail).toContain('command not found');
  });

  it('names the omp local-model runner for an omp member', () => {
    expect(classifyRuntimeProbe('omp', { code: 127 }).detail).toContain('omp local-model runner');
  });

  it('ENOENT (no bash) / timeout / signal death ⇒ FAIL OPEN (resolved, inconclusive)', () => {
    expect(classifyRuntimeProbe('claude', { code: 'ENOENT', message: 'spawn bash ENOENT' }).resolved).toBe(true);
    expect(classifyRuntimeProbe('claude', { code: null, killed: true, signal: 'SIGTERM' }).resolved).toBe(true);
  });
});

describe('probeAgentBinResolvable (WI-5306, real login-shell probe)', () => {
  it('resolves a binary that IS on the login PATH (sh) and refuses one that is not', async () => {
    expect((await probeAgentBinResolvable('sh')).resolved).toBe(true);
    const missing = await probeAgentBinResolvable('papercusp-nonexistent-agent-9f8a7b');
    expect(missing.resolved).toBe(false);
    expect(missing.detail).toContain('command not found');
  }, 15_000);
});

// ── P-017 / D-045 §3f: the BYOC control plane on the honor path ──────────────
//
// What a regression here breaks: byoc-execution.ts goes back to having zero
// production callers (its whole disposition under D-045), OR — worse — it keeps
// being *called* while nothing depends on the answer, which is a `wired` verdict
// that is technically true and substantively false. Every test below therefore
// asserts a CONSEQUENCE (a spawn that does not happen, a metered number that
// tracks reality), never merely that the function ran.
describe('P-017 BYOC control plane (D-045 §3f)', () => {
  describe('byocBillingModeForRoute — the X7 authority a delegated seat runs under', () => {
    it("maps the gateway-pool route to 'pool-with-attribution' and own-credential routes to 'host-pays'", () => {
      // 'auto' spends the shared account POOL, so M17 (single-owner pools only)
      // must apply; the other two spend THIS host's own credential, where
      // host-signed receipts alone are authoritative.
      expect(byocBillingModeForRoute('auto')).toBe('pool-with-attribution');
      expect(byocBillingModeForRoute('default')).toBe('host-pays');
      expect(byocBillingModeForRoute('pinned')).toBe('host-pays');
    });
  });

  describe('byocSeatAxisCap — the seat axis the honor reserves against', () => {
    it('caps at what REMAINS on the slot, denominated in slots, clamped per-call by the host policy', () => {
      expect(byocSeatAxisCap(3, 12)).toEqual({ cap: 3, unit: 'slots', maxPerCall: 12 });
    });

    it('never emits a negative cap, and treats a non-positive policy ceiling as "no per-call clamp"', () => {
      // A leaked / over-consumed seat board can report available < 0 (WI-5317);
      // offer-budget requires a finite cap >= 0, so a negative would make every
      // reserve refuse for the wrong reason.
      expect(byocSeatAxisCap(-2, 12).cap).toBe(0);
      expect(byocSeatAxisCap(3, 0).maxPerCall).toBeNull();
    });
  });

  describe('the M17 pool gate is LOAD-BEARING — an unreadable pool stops the spawn', () => {
    it('refuses a pool-routed honor when pool ownership cannot be established, and never spawns', async () => {
      // `null` = the account-resolver read FAILED, so ownership is UNKNOWN.
      // Today defaultResolveHonorAccount swallows exactly this exception and
      // lets `--account=auto` through to a boot-time death (the WI-5316 shape);
      // billing-matrix fails it closed here instead.
      const { d, spawnMembers, setDisposition, emitReceipt } = deps({
        resolveBillingPool: vi.fn(async () => null),
      });
      const res = await honorSpawnRequestFromProjection(ARGS, d);

      expect(res).toEqual({ outcome: 'refused', code: 'pool_not_single_owner' });
      // The whole point: no members were launched.
      expect(spawnMembers).not.toHaveBeenCalled();
      // Refused from the NULL disposition — no 'honoring' claim left dangling.
      expect(setDisposition).toHaveBeenCalledWith(
        WS,
        HOME,
        UID_A,
        'spawnreq-0123456789abcdef',
        'refused:pool_not_single_owner',
        undefined,
        undefined,
      );
      // D-004: the requester learns WHY, over the one channel that crosses.
      expect(emitReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'refusal',
          refusal: expect.objectContaining({ code: 'pool_not_single_owner' }),
        }),
      );
    });

    it('POSITIVE CONTROL: the identical request DOES honor once the pool reads single-owner', async () => {
      // Without this control the refusal above proves nothing — a request
      // blocked by some unrelated gate would produce the same "did not spawn".
      const { d, spawnMembers, resolveBillingPool } = deps();
      const res = await honorSpawnRequestFromProjection(ARGS, d);

      expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
      expect(spawnMembers).toHaveBeenCalledOnce();
      // And the gate really was consulted on this path — not skipped.
      expect(resolveBillingPool).toHaveBeenCalledWith(WS);
    });

    it("does NOT consult the pool when the seat runs on this host's own credential", async () => {
      // A 'default'-routed seat is host-pays: there is no pool to attribute to,
      // so reading one would be a pointless dependency on gateway state.
      const { d, resolveBillingPool } = deps({
        resolveHonorAccount: vi.fn(async () => ({ ok: true as const, account: 'default' })),
      });
      const res = await honorSpawnRequestFromProjection(ARGS, d);

      expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
      expect(resolveBillingPool).not.toHaveBeenCalled();
    });
  });

  describe('settlement meters what BOOTED, not what was requested', () => {
    it('commits the reservation at the actually-opened count on a PARTIAL honor', async () => {
      // The reservation opens at payload.count (2). Only one member booted, so
      // the draw committed against the budget — and reported to the requester
      // being billed — must be 1, not 2.
      const { d, emitReceipt } = deps({
        spawnMembers: vi.fn(async () => ({ opened: 1, failed: 1, firstError: 'second window died' })),
      });
      const res = await honorSpawnRequestFromProjection(ARGS, d);

      expect(res).toEqual({ outcome: 'honored', opened: 1, failed: 1, committedSeats: 1 });
      const honored = emitReceipt.mock.calls.map((c: any[]) => c[0]).find((r: any) => r?.kind === 'honored');
      expect(honored.detail).toContain("Metered 1 seat(s) on axis 'local' under billing mode 'pool-with-attribution'");
    });

    it('POSITIVE CONTROL: a full honor meters every requested seat', async () => {
      // Pins the partial case above to the OPENED count specifically. Without
      // this, "committedSeats: 1" is equally consistent with a settlement that
      // always meters 1, which would under-bill every multi-seat honor.
      const { d, emitReceipt } = deps();
      const res = await honorSpawnRequestFromProjection(ARGS, d);

      expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0, committedSeats: 2 });
      const honored = emitReceipt.mock.calls.map((c: any[]) => c[0]).find((r: any) => r?.kind === 'honored');
      expect(honored.detail).toContain('Metered 2 seat(s)');
      // The requesting owner is credited the attributed contribution.
      expect(honored.detail).toContain("2 credited to 'su-a'");
    });
  });
});
