/**
 * coord:catch-up — the audience-keyed, MEMBER-SCOPED history read
 * (fleet-broadcast-audience-history-integration-2026-06-30 P-008 / D-006).
 *
 * Exercises the membership GATE (the security boundary: you can only catch up on
 * an audience you currently belong to) and the audience-scoped read, against an
 * in-memory CoordEventLog with the PG-backed resolvers + identity stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';

// Mutable mock state (hoisted so the vi.mock factory may close over it).
const h = vi.hoisted(() => ({ members: [] as string[], callerFleet: null as string | null }));

// Fixed caller identity = 'me'.
vi.mock('../identity', async (orig) => {
  const actual = await orig<typeof import('../identity')>();
  return {
    ...actual,
    resolveAgentIdentity: () => ({
      ownerId: 'me',
      ownerLabel: 'me',
      source: 'omp-hook-session',
      workspaceId: 'default',
      userId: null,
    }),
  };
});

// Stub the PG-backed resolvers (so no getOrgPg); keep the real, pure
// canonicalizeAudienceSelector / deriveAudienceKey. Both the fleet + topic
// resolvers report `h.members` so a test controls who "belongs".
vi.mock('../audience-host', async (orig) => {
  const actual = await orig<typeof import('../audience-host')>();
  return {
    ...actual,
    hostAudienceResolvers: {
      listTargetSubscribers: async () => h.members,
      listActivePresence: async () => [],
      listTaggedTopics: async () => [],
      listFleetMembers: async () => h.members,
      listFleetLeader: async () => [],
    },
  };
});

// Fleet membership for the GATE is read directly from presence (NOT the delivery
// audience) — so a muted/digest member can still catch up. Stub it on h.callerFleet.
vi.mock('../presence-fleet', () => ({
  fetchPresenceFleet: async (ids: string[]) =>
    new Map<string, { fleetSlug: string; fleetRole: string }>(
      h.callerFleet && ids.includes('me') ? [['me', { fleetSlug: h.callerFleet, fleetRole: 'member' }]] : [],
    ),
}));

// sendMessage fires the digest sidecar for @fleet: sends; stub it so seeding doesn't
// reach getOrgPg in this in-memory test (its behavior is covered in fleet-delivery.test.ts).
// audience-host.listFleetMembers now consults getFleetDeliveryOverrides during a
// @fleet: send (delivery-mode filter); an empty Map = no overrides → all members.
vi.mock('../fleet-delivery', () => ({
  deliverFleetDigests: async () => 0,
  getFleetDeliveryOverrides: async () => new Map(),
}));

// WI-3653: sendMessage's AUTO harness_slug stamp (undefined harnessSlug → resolve
// the workspace's single shared hive) unconditionally calls resolveWorkspaceHiveScope,
// which reaches real PG (listHives) when unmocked — this in-memory test must never hit
// live infra. Same pattern as send.test.ts / messages.test.ts. Default 'none' = today's
// local-only behavior for the seeding sendMessage calls below (byte-identical envelopes).
vi.mock('../federation-scope', () => ({
  resolveWorkspaceHiveScope: async () => ({ kind: 'none' }),
}));

import catchUp from './catch-up';
import { sendMessage } from '../messages';

const ctx = { uiClientId: 'me', isSuperuser: true, workspaceId: 'default' } as never;
const sender = { ownerId: 'q', ownerLabel: 'q', source: 'omp-hook-session', workspaceId: 'default', userId: null } as never;

function run(args: Record<string, unknown>) {
  const parsed = (catchUp.args as { parse: (x: unknown) => unknown }).parse(args);
  return catchUp.handler(parsed as never, ctx);
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
function payload(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0]!.text);
}

describe('coord:catch-up — membership gate', () => {
  beforeEach(() => configureCoordLog(new InMemoryCoordLog()));
  afterEach(() => {
    resetCoordLog();
    h.members = [];
    h.callerFleet = null;
  });

  it('REJECTS a caller who is not a member of the audience', async () => {
    h.callerFleet = 'other-fleet'; // caller is in a DIFFERENT fleet
    const res = await run({ audience: '@fleet:backend' });
    expect(isError(res)).toBe(true);
  });

  it('ALLOWS a member and returns history — membership is checked from PRESENCE, not delivery (a muted member still catches up)', async () => {
    h.callerFleet = 'backend'; // caller IS a member (presence label), regardless of delivery override
    // Seed a fleet broadcast — its audience key is preserved as @fleet:backend.
    await sendMessage(sender, { to: ['@fleet:backend'], summary: 'cohort steering note' });
    const res = await run({ audience: '@fleet:backend' });
    expect(isError(res)).toBe(false);
    const out = payload(res as { content: { text: string }[] });
    expect(out.audience).toBe('@fleet:backend');
    expect(out.rows.map((r: { summary: string }) => r.summary)).toContain('cohort steering note');
  });

  it('ALLOWS * (broadcast) without a membership check', async () => {
    h.members = []; // not a member of anything
    const res = await run({ audience: '*' });
    expect(isError(res)).toBe(false);
  });

  it('REJECTS a non-selector audience value', async () => {
    const res = await run({ audience: 'not-a-selector' });
    expect(isError(res)).toBe(true);
  });

  it('canonicalizes the fleet name in the gate + query (Backend Team → backend-team)', async () => {
    h.callerFleet = 'backend-team';
    await sendMessage(sender, { to: ['@fleet:Backend Team'], summary: 'named-fleet note' });
    const res = await run({ audience: '@fleet:Backend Team' });
    expect(isError(res)).toBe(false);
    const out = payload(res as { content: { text: string }[] });
    expect(out.audience).toBe('@fleet:backend-team');
    expect(out.rows.map((r: { summary: string }) => r.summary)).toContain('named-fleet note');
  });
});

// presence-coord-unification P-003: coord:catch-up is the BLESSED audience-history
// read, and its "audience stamps persist after agent death" guarantee. The membership
// FACT death-survival (append-only fleet_membership_events + the coord_presence
// re-materialize trigger) is covered at the DB layer by
// libs/papercusp/libs/db/src/fleet-membership-append-only.integration.test.ts. These
// tests lock the coord:catch-up READ-path half: the audience-keyed history is surfaced
// by the message's PRESERVED audience stamp (on the append-only coord log), never by a
// live-presence lookup of the sender — so it survives the sender's death — and the
// member-side gate rides the projected fleet_slug that mig-430 re-materializes after death.
describe('coord:catch-up — audience-stamp death-survival (P-003)', () => {
  beforeEach(() => configureCoordLog(new InMemoryCoordLog()));
  afterEach(() => {
    resetCoordLog();
    h.members = [];
    h.callerFleet = null;
  });

  it("returns a fleet message after its SENDER has died — surfaced by the preserved audience stamp, not the sender's live membership", async () => {
    // `q` (the sender) broadcast to @fleet:backend while it was a member, then died:
    // it has NO presence row and is absent from the CURRENT member set. The only thing
    // tying its message to the fleet is the audience stamp preserved on the coord-log
    // envelope — a live-membership lookup of `q` would find nothing.
    h.members = ['me']; // current members = only the live caller; the sender `q` is gone
    h.callerFleet = 'backend'; // the caller is a member (its fleet_slug re-materialized)
    await sendMessage(sender /* ownerId 'q' */, {
      to: ['@fleet:backend'],
      summary: 'steering note from a since-dead sender',
    });

    const res = await run({ audience: '@fleet:backend' });
    expect(isError(res)).toBe(false);
    const out = payload(res as { content: { text: string }[] });
    // The dead sender's message survives — surfaced purely by the audience stamp.
    expect(out.rows.map((r: { summary: string }) => r.summary)).toContain(
      'steering note from a since-dead sender',
    );
    expect(out.rows.some((r: { from?: string }) => r.from === 'q')).toBe(true);
  });

  it('member-side gate rides the re-materialized fleet_slug: reaped (null) is denied, restored membership catches up on the preserved history', async () => {
    await sendMessage(sender, { to: ['@fleet:backend'], summary: 'history to catch up on' });

    // Reaped presence / not-yet-re-materialized fleet_slug: the gate reads null → denied.
    h.callerFleet = null;
    const denied = await run({ audience: '@fleet:backend' });
    expect(isError(denied)).toBe(true);

    // After re-register, the P-002 materialize trigger (mig 430) restores fleet_slug; the
    // same member now passes the gate and reads the still-preserved audience history.
    h.callerFleet = 'backend';
    const allowed = await run({ audience: '@fleet:backend' });
    expect(isError(allowed)).toBe(false);
    const out = payload(allowed as { content: { text: string }[] });
    expect(out.rows.map((r: { summary: string }) => r.summary)).toContain('history to catch up on');
  });
});
