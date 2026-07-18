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
import { describe, expect, it, vi } from 'vitest';
import {
  SPAWN_REQUEST_HONOR_WINDOW_MS,
  classifyRuntimeProbe,
  evaluateSpawnRequestTarget,
  honorSpawnRequestFromProjection,
  probeAgentBinResolvable,
  type DelegatedSpawnHonorDeps,
} from './delegated-spawn-honor';
import {
  honorAccountRoutingMode,
  localClaudeLoginPresent,
  resolveHonorAccount,
} from './honor-account-resolution';
import { seatOfferId } from './offer-store-publish';
import type { SeatSlot } from '../fleet/seat-accounting';
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
    fleet_slug: record.fleetSlug,
  };
}

function deps(over: Partial<Record<keyof DelegatedSpawnHonorDeps, any>> = {}) {
  const setDisposition = vi.fn(async () => true);
  const spawnMembers = vi.fn(async () => ({ opened: 2, failed: 0, firstError: null }));
  const emitReceipt = vi.fn(async () => ({ ok: true }) as any);
  // Passing runtime probe by default so honor tests never depend on whether the
  // TEST host has `claude`/`omp` on its login PATH (WI-5306). The absent-runtime
  // path is covered by its own test that injects a failing probe.
  const probeAgentRuntime = vi.fn(async () => ({ resolved: true, detail: 'ok' }));
  // Pass-through account resolution by default (WI-5316) so honor tests neither hit
  // PG (the real pool loader) nor depend on the TEST host's login — the account the
  // seat pins survives verbatim. The downgrade/refuse paths get their own tests.
  const resolveHonorAccount = vi.fn(async (requestedAccount: string) => ({ ok: true as const, account: requestedAccount }));
  const d: DelegatedSpawnHonorDeps = {
    hostAccepts: vi.fn(async () => true),
    resolveActor: vi.fn(async () => ({ githubUserId: UID_B })) as any,
    resolveDevicePubkey: vi.fn(async () => PK_B),
    listAllotments: vi.fn(async () => [ALLOTMENT]) as any,
    availabilityForFleet: vi.fn(async () => AVAILABILITY) as any,
    setDisposition,
    spawnMembers,
    emitReceipt,
    probeAgentRuntime,
    resolveHonorAccount,
    nowMs: () => NOW,
    ...over,
  };
  return { d, setDisposition, spawnMembers, emitReceipt, probeAgentRuntime, resolveHonorAccount };
}

const ARGS = { workspaceId: WS, potHomeSlug: HOME, row: row() };

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
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0 });
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
    expect(res).toEqual({ outcome: 'honored', opened: 2, failed: 0 });
    expect(spawnMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        // the seat is AUTO, but the honor-resolved account overrides it
        seatRef: 'haiku:low:AUTO',
        launch: { model: 'haiku:low', account: 'default' },
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

describe('localClaudeLoginPresent (WI-5316)', () => {
  it('darwin ⇒ assumed present (Keychain login, not the disk bundle)', () => {
    expect(localClaudeLoginPresent({ platform: 'darwin', fileExists: () => false })).toBe(true);
  });
  it('linux/wsl ⇒ true iff ~/.claude/.credentials.json exists', () => {
    const home = '/home/x';
    expect(
      localClaudeLoginPresent({ platform: 'linux', home, fileExists: (p) => p === '/home/x/.claude/.credentials.json' }),
    ).toBe(true);
    expect(localClaudeLoginPresent({ platform: 'linux', home, fileExists: () => false })).toBe(false);
    expect(localClaudeLoginPresent({ platform: 'win32', home, fileExists: () => false })).toBe(false);
  });
});

describe('resolveHonorAccount (WI-5316, pure core)', () => {
  const withPool = (ids: string[], login = true) => ({
    listPoolAccountIds: async () => ids,
    localLoginPresent: () => login,
  });

  it('default route is always fulfillable (no pool needed)', async () => {
    const listPoolAccountIds = vi.fn(async () => [] as string[]);
    expect(await resolveHonorAccount('default', { listPoolAccountIds, localLoginPresent: () => true })).toEqual({
      ok: true,
      account: 'default',
    });
    expect(await resolveHonorAccount('', { listPoolAccountIds, localLoginPresent: () => false })).toEqual({
      ok: true,
      account: 'default',
    });
    // never even looks at the pool
    expect(listPoolAccountIds).not.toHaveBeenCalled();
  });

  it('auto with a non-empty pool ⇒ keeps auto', async () => {
    expect(await resolveHonorAccount('auto', withPool(['acct-1']))).toEqual({ ok: true, account: 'auto' });
  });

  it('auto with an empty pool + a local login ⇒ DOWNGRADES to default (the live-proven fix)', async () => {
    const r = await resolveHonorAccount('auto', withPool([], true));
    expect(r).toMatchObject({ ok: true, account: 'default', downgradedFrom: 'auto' });
    expect((r as { note: string }).note).toContain('auto');
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
