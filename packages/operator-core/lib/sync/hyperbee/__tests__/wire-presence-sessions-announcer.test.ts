/**
 * WI-10002534 — the P-005 SESSION-grain announcer must be ONE per (workspace,
 * gossip topic) per process, never one per harness handle or per re-wire.
 *
 * Measured on the P-203 rig (parent WI-10002529): the tower wired 39 harness
 * handles onto ONE gossip topic, and each armed its own sessions announcer over
 * the SAME workspace-wide roster (`listPresence({ workspaceId })`). Every change
 * therefore went out as ~39 duplicate full-set frames, and the receiver — keyed on
 * (workspace, owner, machine) with harness_slug outside the key — rewrote every
 * row once per frame. The same code also leaked one announcer per re-wire of a
 * single handle (the only clear was the handle's close hook).
 *
 * Hermetic: identity, roster, fleet enrichment and the gossip transport are
 * mocked, and every timer goes through the injected setIntervalFn seam, so the
 * test counts exactly the announcers that are live.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastSessions = vi.fn(async () => true);

vi.mock('../presence-gossip-wiring', () => ({
  registerPresenceGossipTopic: async () => {},
  broadcastPresencePut: async () => true,
  broadcastPresenceDel: async () => true,
  broadcastSessions: (...a: unknown[]) => broadcastSessions(...(a as [])),
}));

vi.mock('../local-announce-identity', () => ({
  resolveLocalAnnounceIdentity: async () => ({
    keychainId: '42:machine',
    devicePubkeyBase64: 'pk',
    githubUserId: 42,
    githubLogin: 'owner',
    attestationGistId: '',
  }),
  resolveLocalAnnounceIdentityFromHiveMembers: async () => null,
}));

vi.mock('../../../federated-pot-scope', () => ({
  listHiveMembersForLocalPot: async () => [],
}));

let roster: Array<{ ownerId: string; intent: string | null }> = [];
vi.mock('../../../agent-tools/coordination/presence', () => ({
  listPresence: async () => roster,
}));

vi.mock('../../../agent-tools/coordination/presence-fleet', () => ({
  fetchPresenceFleet: async () => new Map(),
}));

import {
  wirePresenceAnnounceForHarness,
  __resetSessionAnnouncersForTests,
  type PresenceWireHandle,
} from '../wire-presence';

const SESSION_TICK_MS = 10_000;
const PRESENCE_TICK_MS = 5_000;

/** A timer seam that records every armed interval so the test can count the live ones. */
function timers() {
  let next = 1;
  const live = new Map<number, { cb: () => void; ms: number }>();
  return {
    setIntervalFn: (cb: () => void, ms: number) => {
      const id = next++;
      live.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: (h: ReturnType<typeof setInterval>) => {
      live.delete(h as unknown as number);
    },
    liveSessionAnnouncers: () => [...live.values()].filter((t) => t.ms === SESSION_TICK_MS),
  };
}

function handle(harnessSlug: string, topicHex: string) {
  const closeHooks: Array<() => void | Promise<void>> = [];
  const h: PresenceWireHandle = {
    workspaceId: 'ws',
    harnessSlug,
    ownLog: { keyHex: `log-${harnessSlug}` },
    append: async () => {},
    swarm: { topicHex },
    registerCloseHook: (hook) => {
      closeHooks.push(hook);
      return () => {};
    },
  };
  return {
    h,
    close: async () => {
      for (const hook of closeHooks) await hook();
    },
  };
}

function wire(h: PresenceWireHandle, t: ReturnType<typeof timers>) {
  return wirePresenceAnnounceForHarness(h, {
    presenceGossip: true,
    intervalMs: PRESENCE_TICK_MS,
    resolvePotSlug: async () => 'pot',
    resolveRunsRoutines: async () => null,
    resolveActiveRoutines: async () => null,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
    now: () => 1_000_000,
    onError: (err) => tickErrors.push(err),
  });
}

/** A tick swallows its own errors into onError — surface them so a failing tick is loud. */
const tickErrors: unknown[] = [];

/** Fire every live sessions announcer once — one real 10s tick — and let it settle. */
async function tickAll(t: ReturnType<typeof timers>) {
  // One announcer at a time: each tick awaits dynamic imports, so wait for its
  // broadcast before firing the next.
  for (const a of t.liveSessionAnnouncers()) {
    const before = broadcastSessions.mock.calls.length;
    a.cb();
    await vi.waitFor(() => {
      expect(tickErrors.map(String)).toEqual([]);
      expect(broadcastSessions.mock.calls.length).toBe(before + 1);
    });
  }
}

beforeEach(() => {
  broadcastSessions.mockClear();
  tickErrors.length = 0;
  roster = [
    { ownerId: 'su-a', intent: 'x' },
    { ownerId: 'su-b', intent: 'y' },
  ];
  // Guarded so the same file measures the pre-fix code too (the distinguishing run).
  if (typeof __resetSessionAnnouncersForTests === 'function') __resetSessionAnnouncersForTests();
});

describe('sessions announcer is one per (workspace, topic) — WI-10002534', () => {
  it('re-wiring the SAME handle N times leaves exactly one live announcer', async () => {
    const t = timers();
    const { h } = handle('repo-a', 'topic-1');
    for (let i = 0; i < 5; i++) await wire(h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
  });

  it('N harness handles on ONE topic share one announcer → one frame per tick', async () => {
    const t = timers();
    for (const slug of ['papercusp', 'papercusp/libs/a', 'papercusp/libs/b']) {
      await wire(handle(slug, 'topic-1').h, t);
    }
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
    const [topic, sessions] = broadcastSessions.mock.calls[0] as unknown as [string, unknown[]];
    expect(topic).toBe('topic-1');
    expect(sessions).toHaveLength(2);
  });

  it('harnesses on DIFFERENT topics each keep their own announcer', async () => {
    const t = timers();
    await wire(handle('repo-a', 'topic-1').h, t);
    await wire(handle('repo-b', 'topic-2').h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(2);
    await tickAll(t);
    const topics = broadcastSessions.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(topics).toEqual(['topic-1', 'topic-2']);
  });

  it('closing one of two sharing handles keeps announcing; closing the last stops it', async () => {
    const t = timers();
    const a = handle('repo-a', 'topic-1');
    const b = handle('repo-b', 'topic-1');
    await wire(a.h, t);
    await wire(b.h, t);
    await a.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
    await b.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(0);
  });

  it('a harness re-wired after its handle closed announces again (no stale refcount)', async () => {
    const t = timers();
    const a = handle('repo-a', 'topic-1');
    await wire(a.h, t);
    await a.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(0);
    const a2 = handle('repo-a', 'topic-1');
    await wire(a2.h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
  });
});
