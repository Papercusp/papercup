/**
 * WI-7042 — the IO composition (`resolveDelegatedSpawnOutcome`).
 *
 * Every seam is injected, so these tests pin the DECISIONS the composition
 * makes rather than re-testing the classifier (26/26 in its own file) or the
 * pure mapper (10/10 in its own file). The decisions worth pinning are the ones
 * that can manufacture a confident wrong verdict:
 *
 *   - a REMOTE honor must never consult member evidence, and must never come
 *     back "nobody honored it";
 *   - a partial member read must fail CLOSED rather than drop a member;
 *   - the honoring device is an OBSERVATION (a receipt) before it is an
 *     INFERENCE (the seat we targeted).
 *
 * Fixtures mirror the live row measured 2026-08-02 (spawnreq-43e5a7ad370026f9,
 * fleet fed-drill) — including the shared GitHub account on BOTH sides, which is
 * what makes the account useless as a local/remote discriminator.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveDelegatedSpawnOutcome } from './delegated-spawn-outcome-resolve';
import type { StoredWorkOffer } from './offer-store';
import type { P2pReceipt } from './receipts';
import { DEFAULT_HONOR_WINDOW_MS } from './delegated-spawn-outcome';

const WS = 'papercusp-workspace';
const POT = 'papercusp';
const REQ_ID = 'spawnreq-43e5a7ad370026f9';
const SEAT_ID = 'seat-78c6bba3c96de094';
const FLEET = 'fed-drill';

/** One account owns every host here — the trap the device pubkey exists to dodge. */
const SHARED_UID = 279_242_982;
const REQUESTED_AT = 1_785_654_929_357;
/** The Win rig's device (remote) vs this host's own (local). */
const RIG_DEVICE_PK = 'nWXvaGiA5pIPrkAP9dAsauQ2G3Z7wSHc07ofgwf8sZc=';
const SELF_DEVICE_PK = 'IXfGu216EI/z1gNQG06dG9CUMUlY/clesNYQPoWXgRc=';

const recordJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    authorship: null,
    cancelReason: null,
    fleetSlug: FLEET,
    kind: 'spawn_request',
    offerId: REQ_ID,
    potSlug: null,
    publisherGithubUserId: SHARED_UID,
    recordVersion: 1,
    seat: null,
    spawnRequest: {
      count: 1,
      launchContext: null,
      planSlug: 'fed-drill-host-dossier-2026-07-17',
      requestedAtMs: REQUESTED_AT,
      requesterOwnerId: 'su-4ca244e4-540e-4acc-bb67-9335192fc85f',
      targetOfferId: SEAT_ID,
      targetPublisherGithubUserId: SHARED_UID,
      ...((over.spawnRequest as Record<string, unknown>) ?? {}),
    },
    status: 'open',
    workOffer: null,
    ...over,
  });

const offer = (over: Partial<StoredWorkOffer> = {}): StoredWorkOffer => ({
  workspaceId: WS,
  potHomeSlug: POT,
  publisherGithubUserId: SHARED_UID,
  offerId: REQ_ID,
  record: null,
  recordJson: recordJson(),
  signerDevicePubkey: SELF_DEVICE_PK,
  signature: 'sig',
  recordVersion: 1,
  fleetSlug: FLEET,
  potSlug: null,
  offerKind: 'spawn_request',
  status: 'open',
  localDisposition: null,
  fedHlc: null,
  updatedAt: REQUESTED_AT,
  ...over,
});

const seatOffer = (signer: string): StoredWorkOffer =>
  offer({ offerId: SEAT_ID, offerKind: 'seat', signerDevicePubkey: signer });

const receipt = (over: Partial<P2pReceipt> = {}): P2pReceipt => ({
  workspaceId: WS,
  potSlug: POT,
  receiptId: 'r1',
  kind: 'honored',
  offerId: REQ_ID,
  action: 'spawn',
  refusalCode: null,
  missingCapability: null,
  budgetAxis: null,
  detail: 'spawned 1 member on account default',
  requesterKind: null,
  requesterRef: null,
  requesterGithubUserId: null,
  responderGithubUserId: SHARED_UID,
  responderDevicePubkey: null,
  receiptTs: REQUESTED_AT + 2_000,
  origin: 'remote',
  ...over,
});

/** Defaults describe the LIVE case: a remote rig honored, nothing else present. */
function deps(over: Partial<Parameters<typeof resolveDelegatedSpawnOutcome>[1]> = {}) {
  return {
    listOffers: vi.fn(async () => [offer()]),
    getOffer: vi.fn(async () => seatOffer(RIG_DEVICE_PK)),
    listReceipts: vi.fn(async () => [] as P2pReceipt[]),
    selfDevicePubkey: vi.fn(async () => SELF_DEVICE_PK as string | null),
    loadMembers: vi.fn(async () => []),
    nowMs: () => REQUESTED_AT + 10_000,
    ...over,
  } as Parameters<typeof resolveDelegatedSpawnOutcome>[1];
}

describe('resolveDelegatedSpawnOutcome (WI-7042)', () => {
  it('returns null for an offerId that is not a usable spawn request', async () => {
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: 'seat-ec799e00fa1c9725' },
      deps(),
    );
    expect(r).toBeNull();
  });

  it('reads the targeted seat by its FULL primary key, never by a scan', async () => {
    const d = deps();
    await resolveDelegatedSpawnOutcome({ workspaceId: WS, potSlug: POT, offerId: REQ_ID }, d);
    // (workspace, harness, publisher_github_user_id, offer_id) — the request
    // payload carries both halves of the key, so the seat is a point read.
    expect(d.getOffer).toHaveBeenCalledWith(WS, POT, SHARED_UID, SEAT_ID);
  });

  it('a REMOTE honor never consults member evidence at all', async () => {
    const d = deps();
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      d,
    );
    expect(r!.memberEvidenceAvailable).toBe(false);
    expect(r!.honoringDevicePubkey).toBe(RIG_DEVICE_PK);
    // Structural, not incidental: rows already known to prove nothing are never
    // fetched, so no later edit can leak them into a verdict.
    expect(d.loadMembers).not.toHaveBeenCalled();
  });

  it('NEVER reports "nobody honored it" for a remote request past the honor window', async () => {
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({ nowMs: () => REQUESTED_AT + DEFAULT_HONOR_WINDOW_MS + 60_000 }),
    );
    // The regression this whole feature exists to prevent: an uninformative
    // absence rendered as a confident finding.
    expect(r!.outcome.verdict).not.toBe('no-response');
    expect(r!.outcome.verdict).toBe('indeterminate');
  });

  it('an honored receipt yields honored-unverified even with zero member evidence', async () => {
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({ listReceipts: vi.fn(async () => [receipt()]) }),
    );
    expect(r!.outcome.verdict).toBe('honored-unverified');
    expect(r!.outcome.detail).toContain('account default');
  });

  it('a refusal receipt is reported as refused, with its code', async () => {
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({
        listReceipts: vi.fn(async () => [
          receipt({ kind: 'refusal', refusalCode: 'seat_budget_exhausted' }),
        ]),
      }),
    );
    expect(r!.outcome.verdict).toBe('refused');
    expect(r!.outcome.refusalCode).toBe('seat_budget_exhausted');
  });

  it('prefers a receipt’s responder device (an observation) over the seat signer (an inference)', async () => {
    const other = 'zzzzOTHERDEVICEzzzzzzzzzzzzzzzzzzzzzzzzzzzz=';
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({ listReceipts: vi.fn(async () => [receipt({ responderDevicePubkey: other })]) }),
    );
    expect(r!.honoringDevicePubkey).toBe(other);
  });

  it('a LOCAL honor does consult members, and a live member reads honored-live', async () => {
    const d = deps({
      getOffer: vi.fn(async () => seatOffer(SELF_DEVICE_PK)),
      loadMembers: vi.fn(async () => [
        {
          ownerId: 'su-member',
          fleetSlug: FLEET,
          firstSeenMs: REQUESTED_AT + 1_000,
          lastActiveMs: REQUESTED_AT + 9_000,
          sessionState: 'live',
        },
      ]),
    });
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      d,
    );
    expect(r!.memberEvidenceAvailable).toBe(true);
    expect(d.loadMembers).toHaveBeenCalledWith(WS, FLEET);
    expect(r!.outcome.verdict).toBe('honored-live');
  });

  it('fails CLOSED when the member read cannot be fully resolved', async () => {
    // null = "some row had no liveness verdict". Dropping it could flip
    // honored-live into no-response, so the whole leg is disowned instead.
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({
        getOffer: vi.fn(async () => seatOffer(SELF_DEVICE_PK)),
        loadMembers: vi.fn(async () => null),
        nowMs: () => REQUESTED_AT + DEFAULT_HONOR_WINDOW_MS + 60_000,
      }),
    );
    expect(r!.memberEvidenceAvailable).toBe(false);
    expect(r!.outcome.verdict).not.toBe('no-response');
  });

  it('an unknown self device pubkey is fail-closed, not treated as a local honor', async () => {
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({
        getOffer: vi.fn(async () => seatOffer(SELF_DEVICE_PK)),
        selfDevicePubkey: vi.fn(async () => null),
      }),
    );
    expect(r!.memberEvidenceAvailable).toBe(false);
  });

  it('the shared GitHub account never makes a remote honor look local', async () => {
    // Publisher and target are BOTH SHARED_UID in the live data; only the device
    // pubkeys differ. This pins that the composition reads the device.
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps(),
    );
    expect(r!.request.fleetSlug).toBe(FLEET);
    expect(r!.memberEvidenceAvailable).toBe(false);
  });

  it('counts overlapping sibling requests on the same fleet as concurrent', async () => {
    const sibling = offer({
      offerId: 'spawnreq-8856ee2d9938a60b',
      recordJson: recordJson({
        offerId: 'spawnreq-8856ee2d9938a60b',
        spawnRequest: { requestedAtMs: REQUESTED_AT + 5_000 },
      }),
    });
    const r = await resolveDelegatedSpawnOutcome(
      { workspaceId: WS, potSlug: POT, offerId: REQ_ID },
      deps({ listOffers: vi.fn(async () => [offer(), sibling]) }),
    );
    expect(r!.concurrentRequests).toBe(1);
  });

  it('includes locally-disposed rows — a refused request still has an outcome', async () => {
    const d = deps();
    await resolveDelegatedSpawnOutcome({ workspaceId: WS, potSlug: POT, offerId: REQ_ID }, d);
    expect(d.listOffers).toHaveBeenCalledWith(WS, POT, {
      kind: 'spawn_request',
      includeLocallyDisposed: true,
    });
  });
});
