/**
 * release-force-guard.test.ts — WI-4198 authority/liveness legs, deps injected.
 * The classifiers (classifyAgentPane / classifyFleetControlInvoker) run REAL —
 * they are pure — so these tests pin the actual authority semantics, including
 * the deliberate "an su pane is NOT authority over a live peer claim" decision
 * (the incident actor was an su pane leading its OWN fleet).
 */
import { describe, expect, it } from 'vitest';
import { assessForceRelease, forceRefusalHint, type ForceReleaseDeps } from './release-force-guard';

const NOW = Date.parse('2026-07-11T20:00:00Z');
const min = (n: number) => 60_000 * n;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base = { callerOwnerId: 'su-caller', holderOwnerId: 'su-holder', workspaceId: 'ws1' };

type Pres = { heartbeatAt: string; lastActiveAt: string | null; agentRole: string | null };
const deps = (over: {
  holder?: Pres | null;
  caller?: Pres | null;
  holderFleet?: string | null;
  leader?: string | null;
}): ForceReleaseDeps => ({
  now: () => NOW,
  getPresence: async (o) => (o === 'su-holder' ? (over.holder ?? null) : (over.caller ?? null)),
  latestFleetMembership: async () =>
    over.holderFleet === undefined ? null : { fleetSlug: over.holderFleet, fleetRole: 'member' },
  getFleet: async () => (over.leader === undefined ? null : { leaderOwnerId: over.leader }),
});

describe('assessForceRelease — liveness leg (a)', () => {
  it('no presence + no progress → holder-not-live (the reaper case)', async () => {
    const v = await assessForceRelease({ ...base, itemLastProgressAt: null }, deps({}));
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness).toMatchObject({ presenceFound: false, live: false, freshestAgeMs: null });
  });

  it('stale presence (heartbeat 11min) + old progress → holder-not-live, freshest signal reported', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(30)) },
      deps({ holder: { heartbeatAt: iso(min(11)), lastActiveAt: iso(min(25)), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness.live).toBe(false);
    expect(v.holderLiveness.freshestAgeMs).toBe(min(11));
  });

  it('recent ITEM progress alone keeps the claim live even when presence is gone (no silent grab mid-handover)', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(2)) },
      deps({ caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' } }),
    );
    expect(v.holderLiveness.live).toBe(true);
    expect(v.allowed).toBe(false); // worker pane, no fleet authority
  });

  it('parses PG-format timestamps (space separator, 2-digit offset)', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: '2026-07-11 15:58:41.614276-04' }, // 19:58:41Z — 79s before NOW
      deps({ caller: { heartbeatAt: iso(0), lastActiveAt: null, agentRole: 'worker' } }),
    );
    expect(v.holderLiveness.live).toBe(true);
  });
});

describe('assessForceRelease — authority legs (b)/(c) over a LIVE holder', () => {
  const liveHolder: Pres = { heartbeatAt: iso(min(1)), lastActiveAt: iso(min(1)), agentRole: 'su' };

  it("caller leading the HOLDER's fleet → leads-holder-fleet", async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        holderFleet: 'drain-f1',
        leader: 'su-caller',
      }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'leads-holder-fleet' });
  });

  it('queen pane (mug role) → queen, no fleet needed', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: liveHolder, caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'mug' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'queen' });
  });

  it('WI-4198 incident shape: su pane leading its OWN fleet, holder fleetless → REFUSED', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(1)) },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'su' },
        holderFleet: null, // holder is in no fleet — caller cannot possibly lead it
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.holderLiveness.live).toBe(true);
  });

  it("leader of a DIFFERENT fleet than the holder's → REFUSED", async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        holderFleet: 'other-fleet',
        leader: 'su-someone-else',
      }),
    );
    expect(v.allowed).toBe(false);
  });
});

describe('forceRefusalHint', () => {
  it('names all three authorizing legs so the caller coordinates instead of retrying', () => {
    const h = forceRefusalHint('su-holder');
    expect(h).toMatch(/stale/i);
    expect(h).toMatch(/queen/i);
    expect(h).toMatch(/fleet/i);
    expect(h).toMatch(/coord:send/);
  });
});
