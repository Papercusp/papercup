/**
 * WI-7042 unit tests — the pure mapper + the memberEvidenceAvailable decision.
 *
 * The fixtures below mirror a REAL row measured from harness_shared.p2p_work_offers
 * on 2026-08-02 (offer spawnreq-43e5a7ad370026f9, fleet fed-drill): the
 * spawnRequest payload keys are exactly count, planSlug, launchContext,
 * requestedAtMs, targetOfferId, requesterOwnerId, targetPublisherGithubUserId.
 */
import { describe, expect, it } from 'vitest';
import {
  spawnRequestFactsFromRow,
  memberEvidenceAvailableForHonor,
  countConcurrentRequests,
} from './delegated-spawn-request-facts';
import { DEFAULT_HONOR_WINDOW_MS, type DelegatedSpawnRequestFacts } from './delegated-spawn-outcome';

/**
 * ⚠ The SHARED account id, deliberately used for BOTH publisher and target:
 * every host in this deployment runs under one GitHub account, which is exactly
 * why the account can never discriminate local from remote (see below).
 */
const SHARED_UID = 279_242_982;
const REQUESTED_AT = 1_785_654_929_357;

/** The Win rig's seat, per the live seat-offer row. */
const RIG_DEVICE_PK = 'nWXvaGiA5pIPrkAP9dAsauQ2G3Z7wSHc07ofgwf8sZc=';
/** This host's own seat signer. */
const SELF_DEVICE_PK = 'IXfGu216EI/z1gNQG06dG9CUMUlY/clesNYQPoWXgRc=';

// Field-for-field the shape of the real stored record (note `seat`, not
// `seatOffer`, and the required `recordVersion` — a hand-guessed shape was
// rejected outright by the closed-schema validator).
const record = (over: Record<string, unknown> = {}, srOver: Record<string, unknown> = {}) => ({
  authorship: null,
  cancelReason: null,
  fleetSlug: 'fed-drill',
  kind: 'spawn_request',
  offerId: 'spawnreq-43e5a7ad370026f9',
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
    targetOfferId: 'seat-78c6bba3c96de094',
    targetPublisherGithubUserId: SHARED_UID,
    ...srOver,
  },
  status: 'open',
  workOffer: null,
  ...over,
});

const row = (over: Record<string, unknown> = {}, srOver: Record<string, unknown> = {}) => ({
  offer_id: 'spawnreq-43e5a7ad370026f9',
  fleet_slug: 'fed-drill',
  record_json: JSON.stringify(record(over, srOver)),
});

describe('spawnRequestFactsFromRow (WI-7042)', () => {
  it('maps a real stored spawn_request row to classifier-ready facts', () => {
    const r = spawnRequestFactsFromRow(row());
    expect(r).not.toBeNull();
    expect(r!.facts).toEqual({
      offerId: 'spawnreq-43e5a7ad370026f9',
      fleetSlug: 'fed-drill',
      count: 1,
      requestedAtMs: REQUESTED_AT,
    });
    expect(r!.targetPublisherGithubUserId).toBe(SHARED_UID);
    expect(r!.requesterOwnerId).toBe('su-4ca244e4-540e-4acc-bb67-9335192fc85f');
    expect(r!.planSlug).toBe('fed-drill-host-dossier-2026-07-17');
    // The seat offer id is what identifies the honoring MACHINE.
    expect(r!.targetOfferId).toBe('seat-78c6bba3c96de094');
  });

  it('prefers the SIGNED record fleetSlug over the projected column', () => {
    // The column is a projection of the record; if they ever disagree, the
    // signed record is the one the honoring host actually acted on.
    const r = spawnRequestFactsFromRow({ ...row(), fleet_slug: 'some-other-fleet' });
    expect(r!.facts.fleetSlug).toBe('fed-drill');
  });

  it('falls back to the column when the record carries no fleetSlug', () => {
    const r = spawnRequestFactsFromRow({ ...row({ fleetSlug: null }), fleet_slug: 'from-column' });
    expect(r!.facts.fleetSlug).toBe('from-column');
  });

  it('returns null (never throws) for every not-a-usable-spawn-request shape', () => {
    expect(spawnRequestFactsFromRow({ ...row(), record_json: 'not json{' })).toBeNull();
    expect(spawnRequestFactsFromRow({ ...row(), record_json: '' })).toBeNull();
    expect(spawnRequestFactsFromRow(row({ kind: 'seat' }))).toBeNull();
    expect(spawnRequestFactsFromRow(row({ kind: 'work' }))).toBeNull();
    expect(spawnRequestFactsFromRow(row({ spawnRequest: null }))).toBeNull();
    // No fleet from either source ⇒ refuse rather than invent one, since fleet
    // is what member attribution is scoped by.
    expect(spawnRequestFactsFromRow({ ...row({ fleetSlug: null }), fleet_slug: null })).toBeNull();
  });
});

describe('memberEvidenceAvailableForHonor — the decision the filed item warns about', () => {
  it('is FALSE for a REMOTE honor: the requesting host holds no member trace at all', () => {
    expect(
      memberEvidenceAvailableForHonor({ honoringDevicePubkey: RIG_DEVICE_PK, selfDevicePubkey: SELF_DEVICE_PK }),
    ).toBe(false);
  });

  it('is TRUE only when this host is itself the honoring machine', () => {
    expect(
      memberEvidenceAvailableForHonor({ honoringDevicePubkey: SELF_DEVICE_PK, selfDevicePubkey: SELF_DEVICE_PK }),
    ).toBe(true);
  });

  it('fails toward FALSE when either device identity is unknown — never claims visibility it cannot support', () => {
    for (const bad of [null, undefined, '', '   ']) {
      expect(memberEvidenceAvailableForHonor({ honoringDevicePubkey: RIG_DEVICE_PK, selfDevicePubkey: bad })).toBe(false);
      expect(memberEvidenceAvailableForHonor({ honoringDevicePubkey: bad, selfDevicePubkey: SELF_DEVICE_PK })).toBe(false);
    }
  });

  /**
   * THE REGRESSION GUARD. The natural discriminator — compare the GitHub ids —
   * silently misclassifies every remote honor here, because all hosts share one
   * account. This test pins the real live values so that reintroducing the
   * account comparison fails loudly instead of resurfacing as a confident
   * "nobody honored it".
   */
  it('a REMOTE honor has IDENTICAL publisher/target GitHub ids — so the account can never be the discriminator', () => {
    const remote = spawnRequestFactsFromRow(row())!;
    expect(remote.targetPublisherGithubUserId).toBe(SHARED_UID);
    // Same account on both sides...
    expect(remote.targetPublisherGithubUserId === SHARED_UID).toBe(true);
    // ...yet it is genuinely a remote honor, which only the DEVICE reveals.
    expect(
      memberEvidenceAvailableForHonor({ honoringDevicePubkey: RIG_DEVICE_PK, selfDevicePubkey: SELF_DEVICE_PK }),
    ).toBe(false);
  });
});

describe('countConcurrentRequests', () => {
  const facts = (over: Partial<DelegatedSpawnRequestFacts> = {}): DelegatedSpawnRequestFacts => ({
    offerId: 'spawnreq-self',
    fleetSlug: 'fed-drill',
    count: 1,
    requestedAtMs: REQUESTED_AT,
    ...over,
  });

  it('counts an overlapping request on the same fleet, so attribution reports ambiguous', () => {
    const n = countConcurrentRequests({
      self: facts(),
      others: [facts({ offerId: 'spawnreq-other', requestedAtMs: REQUESTED_AT + 60_000 })],
      honorWindowMs: DEFAULT_HONOR_WINDOW_MS,
    });
    expect(n).toBe(1);
  });

  it('ignores itself, other fleets, and non-overlapping windows', () => {
    const n = countConcurrentRequests({
      self: facts(),
      others: [
        facts(),
        facts({ offerId: 'spawnreq-other-fleet', fleetSlug: 'other' }),
        facts({ offerId: 'spawnreq-long-past', requestedAtMs: REQUESTED_AT - DEFAULT_HONOR_WINDOW_MS - 1 }),
        facts({ offerId: 'spawnreq-far-future', requestedAtMs: REQUESTED_AT + DEFAULT_HONOR_WINDOW_MS + 1 }),
      ],
      honorWindowMs: DEFAULT_HONOR_WINDOW_MS,
    });
    expect(n).toBe(0);
  });

  it('treats touching endpoints as non-contending (half-open)', () => {
    const n = countConcurrentRequests({
      self: facts(),
      others: [facts({ offerId: 'spawnreq-abuts', requestedAtMs: REQUESTED_AT + DEFAULT_HONOR_WINDOW_MS })],
      honorWindowMs: DEFAULT_HONOR_WINDOW_MS,
    });
    expect(n).toBe(0);
  });
});
