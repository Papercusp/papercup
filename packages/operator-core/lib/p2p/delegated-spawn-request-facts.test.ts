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

const SELF_UID = 1001;
const RIG_UID = 2002;
const REQUESTED_AT = 1_785_654_929_357;

const record = (over: Record<string, unknown> = {}, srOver: Record<string, unknown> = {}) => ({
  offerId: 'spawnreq-43e5a7ad370026f9',
  publisherGithubUserId: SELF_UID,
  fleetSlug: 'fed-drill',
  potSlug: null,
  kind: 'spawn_request',
  status: 'open',
  cancelReason: null,
  workOffer: null,
  authorship: null,
  seatOffer: null,
  spawnRequest: {
    targetPublisherGithubUserId: RIG_UID,
    targetOfferId: 'seat-0123456789abcdef',
    count: 1,
    planSlug: 'fed-drill-host-dossier-2026-07-17',
    requesterOwnerId: 'su-4ca244e4-540e-4acc-bb67-9335192fc85f',
    requestedAtMs: REQUESTED_AT,
    launchContext: null,
    ...srOver,
  },
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
    expect(r!.targetPublisherGithubUserId).toBe(RIG_UID);
    expect(r!.requesterOwnerId).toBe('su-4ca244e4-540e-4acc-bb67-9335192fc85f');
    expect(r!.planSlug).toBe('fed-drill-host-dossier-2026-07-17');
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
      memberEvidenceAvailableForHonor({ targetPublisherGithubUserId: RIG_UID, selfGithubUserId: SELF_UID }),
    ).toBe(false);
  });

  it('is TRUE only when this host is itself the honoring host', () => {
    expect(
      memberEvidenceAvailableForHonor({ targetPublisherGithubUserId: SELF_UID, selfGithubUserId: SELF_UID }),
    ).toBe(true);
  });

  it('fails toward FALSE on an unknown/invalid self identity — never claims visibility it cannot support', () => {
    for (const self of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      expect(
        memberEvidenceAvailableForHonor({ targetPublisherGithubUserId: RIG_UID, selfGithubUserId: self as number }),
      ).toBe(false);
    }
  });

  // The trap this exists to prevent: origin='local' is true of EVERY request we
  // published, remote ones included, so it can never be the discriminator.
  it("is decided by the TARGET, not by anything resembling the row's origin", () => {
    const remote = spawnRequestFactsFromRow(row())!;
    expect(remote.targetPublisherGithubUserId).not.toBe(SELF_UID);
    expect(
      memberEvidenceAvailableForHonor({
        targetPublisherGithubUserId: remote.targetPublisherGithubUserId,
        selfGithubUserId: SELF_UID,
      }),
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
