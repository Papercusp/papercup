/**
 * delegated-spawn-outcome.test.ts — EI-19333624101736074.
 *
 * The state under test is the one that does NOT exist in the system today:
 * `honored-then-died`. Everything else here exists to keep that verdict honest —
 * it must not swallow a normal completed run, must not fire while the honor
 * window is still open, and must not silently credit a peer's member to this
 * request.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDelegatedSpawnOutcome,
  BOOT_DEATH_LIFETIME_MS,
  DEFAULT_HONOR_WINDOW_MS,
  type DelegatedSpawnMemberFacts,
} from './delegated-spawn-outcome';

const FLEET = 'fed-drill';
const REQUESTED_AT = 1_785_658_000_000;
const NOW_INSIDE = REQUESTED_AT + 5 * 60_000;
const NOW_AFTER = REQUESTED_AT + DEFAULT_HONOR_WINDOW_MS + 60_000;

const request = (over: Partial<Parameters<typeof classifyDelegatedSpawnOutcome>[0]['request']> = {}) => ({
  offerId: 'spawnreq-43e5a7ad370026f9',
  fleetSlug: FLEET,
  count: 1,
  requestedAtMs: REQUESTED_AT,
  ...over,
});

const member = (over: Partial<DelegatedSpawnMemberFacts> = {}): DelegatedSpawnMemberFacts => ({
  ownerId: 'su-member-1',
  fleetSlug: FLEET,
  firstSeenMs: REQUESTED_AT + 30_000,
  lastActiveMs: REQUESTED_AT + 30_000 + 10 * 60_000,
  sessionState: 'live',
  ...over,
});

describe('classifyDelegatedSpawnOutcome (EI-19333624101736074)', () => {
  it('THE LIVE WIN-RIG FAILURE ⇒ honored-then-died, the state that has no representation today', () => {
    // Measured 2026-08-02: member joined fed-drill at 08:11:25Z and died on auth
    // seconds later. Tower-side afterwards: no receipt, no disposition, an
    // aged-out presence row — previously indistinguishable from "nobody honored".
    const joined = 1_785_658_285_108;
    const r = classifyDelegatedSpawnOutcome({
      request: request({ requestedAtMs: joined - 40_000 }),
      receipts: [],
      members: [member({ firstSeenMs: joined, lastActiveMs: joined + 3_200, sessionState: 'ended' })],
      nowMs: joined + 20 * 60_000,
    });
    expect(r.verdict).toBe('honored-then-died');
    expect(r.actionable).toBe(true);
    expect(r.detail).toContain('PHANTOM HONOR');
    expect(r.detail).toContain('3200ms');
    // points at the honoring host's log, since no success receipt exists to read
    expect(r.detail).toMatch(/member log ON that host/);
    expect(r.members[0]).toMatchObject({ sessionState: 'ended', lifetimeMs: 3_200 });
  });

  it('a member that RAN and finished is honored-completed, never a phantom', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ sessionState: 'ended', lastActiveMs: REQUESTED_AT + 30_000 + 45 * 60_000 })],
      nowMs: NOW_AFTER,
    });
    expect(r.verdict).toBe('honored-completed');
    expect(r.actionable).toBe(false);
    expect(r.detail).toContain('not a phantom');
  });

  it('a member exactly AT the boot threshold is not a phantom; just under it is', () => {
    const at = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ sessionState: 'ended', lastActiveMs: REQUESTED_AT + 30_000 + BOOT_DEATH_LIFETIME_MS })],
      nowMs: NOW_AFTER,
    });
    expect(at.verdict).toBe('honored-completed');
    const under = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ sessionState: 'ended', lastActiveMs: REQUESTED_AT + 30_000 + BOOT_DEATH_LIFETIME_MS - 1 })],
      nowMs: NOW_AFTER,
    });
    expect(under.verdict).toBe('honored-then-died');
  });

  it('a live member ⇒ honored-live (sessionState, not a heartbeat boolean)', () => {
    for (const state of ['live', 'parked', 'draining']) {
      const r = classifyDelegatedSpawnOutcome({
        request: request(),
        receipts: [],
        members: [member({ sessionState: state })],
        nowMs: NOW_INSIDE,
      });
      expect(r.verdict).toBe('honored-live');
    }
  });

  it('a federated refusal wins over everything — it is the one signal that DOES cross the wire', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [
        { kind: 'refusal', code: 'account_unfulfillable', detail: 'no usable local login', tsMs: REQUESTED_AT + 1_000 },
      ],
      members: [member()],
      nowMs: NOW_INSIDE,
    });
    expect(r).toMatchObject({ verdict: 'refused', refusalCode: 'account_unfulfillable', actionable: true });
    expect(r.detail).toContain('no usable local login');
  });

  it('the EARLIEST refusal is reported when several exist', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [
        { kind: 'refusal', code: 'spawn_failed', tsMs: REQUESTED_AT + 9_000 },
        { kind: 'refusal', code: 'agent_runtime_missing', tsMs: REQUESTED_AT + 2_000 },
      ],
      members: [],
      nowMs: NOW_INSIDE,
    });
    expect(r.refusalCode).toBe('agent_runtime_missing');
  });

  it('a non-refusal receipt does not masquerade as a refusal', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [{ kind: 'excused-breach', code: 'preempted', tsMs: REQUESTED_AT + 1_000 }],
      members: [],
      nowMs: NOW_INSIDE,
    });
    expect(r.verdict).toBe('pending');
  });

  it('silence INSIDE the honor window is pending and NOT actionable — absence of evidence is not failure', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [],
      nowMs: NOW_INSIDE,
    });
    expect(r).toMatchObject({ verdict: 'pending', actionable: false, attribution: 'none' });
    expect(r.detail).toContain('55 min left');
  });

  it('silence AFTER the window ⇒ no-response, and names the likeliest cause', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [],
      nowMs: NOW_AFTER,
    });
    expect(r).toMatchObject({ verdict: 'no-response', actionable: true, shortfall: 1 });
    expect(r.detail).toContain('accept-delegated-seats');
  });

  it('a member that appeared BEFORE the request cannot have come from it', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ firstSeenMs: REQUESTED_AT - 1 })],
      nowMs: NOW_AFTER,
    });
    expect(r.verdict).toBe('no-response');
    expect(r.members).toEqual([]);
  });

  it('a member in ANOTHER fleet is never credited to this request', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ fleetSlug: 'some-other-fleet' })],
      nowMs: NOW_AFTER,
    });
    expect(r.verdict).toBe('no-response');
  });

  it('overlapping requests ⇒ attribution ambiguous, stated out loud rather than guessed', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member()],
      nowMs: NOW_INSIDE,
      concurrentRequests: 2,
    });
    expect(r.attribution).toBe('ambiguous');
    expect(r.detail).toContain('carry no request id');
    expect(r.detail).toContain('2 other spawn request(s)');
  });

  it('a single request ⇒ attribution unique, with no ambiguity caveat', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member()],
      nowMs: NOW_INSIDE,
    });
    expect(r.attribution).toBe('unique');
    expect(r.detail).not.toContain('carry no request id');
  });

  it('a SHORTFALL is reported, never rounded away — 3 seats asked, 1 member live', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request({ count: 3 }),
      receipts: [],
      members: [member()],
      nowMs: NOW_INSIDE,
    });
    expect(r).toMatchObject({ verdict: 'honored-live', shortfall: 2 });
    // a partial fill is actionable even though the verdict is a "success" one
    expect(r.actionable).toBe(true);
    expect(r.detail).toContain('Asked for 3 seat(s), observed 1');
  });

  it('a mixed batch where one member is live outranks a dead sibling', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request({ count: 2 }),
      receipts: [],
      members: [
        member({ ownerId: 'su-dead', sessionState: 'ended', lastActiveMs: REQUESTED_AT + 31_000 }),
        member({ ownerId: 'su-live', sessionState: 'live' }),
      ],
      nowMs: NOW_INSIDE,
    });
    expect(r.verdict).toBe('honored-live');
    expect(r.members).toHaveLength(2);
    expect(r.shortfall).toBe(0);
  });

  it('a custom honor window is honored for the pending/no-response boundary', () => {
    const short = { ...request(), honorWindowMs: 10 * 60_000 };
    expect(
      classifyDelegatedSpawnOutcome({ request: short, receipts: [], members: [], nowMs: REQUESTED_AT + 9 * 60_000 }).verdict,
    ).toBe('pending');
    expect(
      classifyDelegatedSpawnOutcome({ request: short, receipts: [], members: [], nowMs: REQUESTED_AT + 11 * 60_000 }).verdict,
    ).toBe('no-response');
  });

  it('a clock-skewed lastActive before firstSeen clamps to 0 rather than going negative', () => {
    const r = classifyDelegatedSpawnOutcome({
      request: request(),
      receipts: [],
      members: [member({ sessionState: 'ended', firstSeenMs: REQUESTED_AT + 60_000, lastActiveMs: REQUESTED_AT + 30_000 })],
      nowMs: NOW_AFTER,
    });
    expect(r.members[0].lifetimeMs).toBe(0);
    expect(r.verdict).toBe('honored-then-died');
  });
});
