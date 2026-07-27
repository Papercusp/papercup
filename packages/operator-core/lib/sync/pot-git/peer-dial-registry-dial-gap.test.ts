/**
 * peer-dial-registry-dial-gap.test.ts — EI-18740968796318403.
 *
 * The pot-git hello channel churns constantly (measured on the live rig: 5028
 * channel opens on ONE topic, roughly one every 2.6s), and `onclose` evicts the
 * dial-registry entry. Because `resolvePotGitPeerSocket` is an INSTANTANEOUS
 * point lookup, a periodic sampler (git-sync's bootstrap leg) lands in one of
 * those gaps ~42% of the time and concludes "no live dial path" for a peer it is
 * demonstrably connected to — costing the cold-join ladder a whole 10-minute
 * tick each time. Measured duty cycle on the papercusp topic: 57.9%.
 *
 * These tests pin the fix's contract, and — critically — its COST BOUND: a peer
 * we have no recent evidence for must miss IMMEDIATELY, so the common
 * "20 candidates, 19 of them offline" dial does not stall for 20 × waitMs.
 *
 * Run: npm run test:file -- packages/operator-core/lib/sync/pot-git/peer-dial-registry-dial-gap.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serve-wiring', () => ({
  // The dial-gap logic decides WHETHER a live socket exists; what a real duplex
  // does with it is serve-wiring's business and is covered by its own tests.
  openHiveGitFetchDuplex: vi.fn((socket: unknown) => ({ destroyed: false, socket })),
}));

const { openHiveGitDuplexToDevice, resolvePotGitPeerSocket, _testing } = await import('./peer-dial-registry');

const TOPIC = Buffer.alloc(32, 7);
const TOPIC_HEX = TOPIC.toString('hex');
const DEVICE = Buffer.alloc(32, 9).toString('base64');
const OTHER_DEVICE = Buffer.alloc(32, 10).toString('base64');
const REQ = { repoKey: 'repo-under-test' };

/** Stand-in for the live swarm socket the registry stores. */
const SOCKET = { id: 'live-socket' };

function register(device = DEVICE, socket: unknown = SOCKET): void {
  let m = _testing.registryByTopic.get(TOPIC_HEX);
  if (!m) {
    m = new Map();
    _testing.registryByTopic.set(TOPIC_HEX, m);
  }
  m.set(device, socket);
  _testing.noteRegistered(TOPIC_HEX, device);
}

function deregister(device = DEVICE): void {
  _testing.registryByTopic.get(TOPIC_HEX)?.delete(device);
}

describe('EI-18740968796318403 — a dial survives a sub-second hello-channel gap', () => {
  beforeEach(() => {
    _testing.reset();
  });

  it('resolves immediately when the device is registered right now (no wait introduced)', async () => {
    register();
    const started = Date.now();
    const duplex = await openHiveGitDuplexToDevice(TOPIC, DEVICE, REQ);
    expect(duplex.destroyed).toBe(false);
    // The happy path must not have become slower.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('THE BUG: a recently-seen device that is mid-churn resolves once it re-registers, instead of a false miss', async () => {
    // The exact live sequence: hello received -> registered -> onclose evicts ->
    // the bootstrap tick samples HERE -> the channel comes back 2s later.
    register();
    deregister();
    expect(resolvePotGitPeerSocket(TOPIC, DEVICE)).toBeUndefined(); // the instant the sampler sees

    const dial = openHiveGitDuplexToDevice(TOPIC, DEVICE, { ...REQ, waitForRegistrationMs: 2_000 });
    // The channel comes back while the dial is parked.
    setTimeout(() => register(), 25);

    const duplex = await dial;
    expect(duplex.destroyed).toBe(false);
  });

  it('COST BOUND: a device never seen misses IMMEDIATELY — 19 offline candidates must not stall the tick', async () => {
    // No registration for OTHER_DEVICE has ever happened, so there is no evidence
    // it is live and nothing to wait for. This is what keeps the bootstrap leg's
    // 20-candidate loop cheap.
    const started = Date.now();
    const duplex = await openHiveGitDuplexToDevice(TOPIC, OTHER_DEVICE, { ...REQ, waitForRegistrationMs: 5_000 });
    expect(duplex.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('gives up after the budget when the device never comes back (still fail-soft, never throws)', async () => {
    register();
    deregister();
    const duplex = await openHiveGitDuplexToDevice(TOPIC, DEVICE, { ...REQ, waitForRegistrationMs: 30 });
    expect(duplex.destroyed).toBe(true);
  });

  it('does not wait for a device whose last sighting is older than the recency window', async () => {
    register();
    deregister();
    // Age the sighting past the window — a genuinely departed peer must miss fast.
    _testing.lastRegisteredAt.set(`${TOPIC_HEX}|${DEVICE}`, Date.now() - (_testing.RECENT_SIGHTING_MS + 1_000));
    const started = Date.now();
    const duplex = await openHiveGitDuplexToDevice(TOPIC, DEVICE, { ...REQ, waitForRegistrationMs: 5_000 });
    expect(duplex.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('waiters are cleared once woken, so a later dial does not resolve on a stale waiter', async () => {
    register();
    deregister();
    const dial = openHiveGitDuplexToDevice(TOPIC, DEVICE, { ...REQ, waitForRegistrationMs: 1_000 });
    setTimeout(() => register(), 10);
    await dial;
    expect(_testing.registrationWaiters.size).toBe(0);
  });
});
