/**
 * Unit tests for the P-016 φ+SWIM authority eviction monitor
 * (shared-hive-hardening-2026-06-13). Deterministic: the φ detectors are fed via
 * controlled presence timestamps and the relay probe is injected — no transport,
 * no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayProbe } from '@papercusp/failure-detector';
import {
  AuthorityEvictionMonitor,
  peerLabel,
  setAuthorityEvictionMonitor,
  getAuthorityEvictionMonitor,
  __resetAuthorityEvictionMonitorForTests,
  type PresenceObservation,
} from '../peer-eviction';
import { selectAuthorityFromRows, type PeerRef, type SelfSwarmIdentity } from '../lock-authority';
import { PeerUnreachableError } from '../peer-rpc-transport';

const T0 = 1_700_000_000_000;
const PK = { x: 'aaa-x', y: 'mmm-y', self: 'zzz-self' };

function peer(pk: string): PeerRef {
  return { devicePubkey: pk, githubUserId: 1, machineLabel: pk };
}
function obs(pk: string, lastSeenMs: number): PresenceObservation {
  return { peer: peer(pk), lastSeenMs };
}

/** Prime a peer's φ detector with a tight ~1s heartbeat cadence so a later
 *  `nowMs` (long silence) yields a high φ deterministically. */
function primeBeats(m: AuthorityEvictionMonitor, pk: string): void {
  m.observe([obs(pk, T0)], T0);
  m.observe([obs(pk, T0 + 1_000)], T0 + 1_000);
  m.observe([obs(pk, T0 + 2_000)], T0 + 2_000);
}

const SILENT_NOW = T0 + 60_000; // 58s since the last beat → φ ≫ threshold

afterEach(() => {
  __resetAuthorityEvictionMonitorForTests();
  vi.restoreAllMocks();
});

describe('peerLabel', () => {
  it('prefers machineLabel, falls back to a pubkey slice', () => {
    expect(peerLabel({ devicePubkey: 'abcdefghij', githubUserId: 1, machineLabel: 'box-1' })).toBe('box-1');
    expect(peerLabel({ devicePubkey: 'abcdefghij', githubUserId: 1, machineLabel: '' })).toBe('abcdefgh');
  });
});

describe('observe + phi', () => {
  it('φ is low right after a beat and high after a long silence', () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    expect(m.phi(PK.x, T0 + 2_000)).toBeLessThan(8); // just beat
    expect(m.phi(PK.x, SILENT_NOW)).toBeGreaterThan(8); // long silence
  });

  it('an unobserved peer has φ 0', () => {
    const m = new AuthorityEvictionMonitor();
    expect(m.phi('never-seen', SILENT_NOW)).toBe(0);
  });
});

describe('decide — the relay-confirmation safety policy', () => {
  const aliveProbe: RelayProbe<PeerRef> = async () => true;
  const deadProbe: RelayProbe<PeerRef> = async () => false;
  const unreachableProbe: RelayProbe<PeerRef> = async () => {
    throw new PeerUnreachableError('relay unreachable');
  };

  it('low φ → keep (alive-direct), no probe', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const probe = vi.fn(deadProbe);
    const d = await m.decide(peer(PK.x), [peer(PK.y)], probe, T0 + 2_000);
    expect(d).toEqual({ evict: false, reason: 'alive-direct' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('high φ but NO relays → keep (the 90s floor; never evict without a witness)', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const d = await m.decide(peer(PK.x), [], deadProbe, SILENT_NOW);
    expect(d.evict).toBe(false);
  });

  it('high φ but every relay unreachable (we are blind) → keep (inconclusive)', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const d = await m.decide(peer(PK.x), [peer(PK.y)], unreachableProbe, SILENT_NOW);
    expect(d.evict).toBe(false);
  });

  it('high φ + a relay vouches ALIVE → keep (alive-indirect) — the SWIM win', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const d = await m.decide(peer(PK.x), [peer(PK.y)], aliveProbe, SILENT_NOW);
    expect(d).toEqual({ evict: false, reason: 'alive-indirect' });
  });

  it('high φ + a reachable relay confirms DEAD → evict (confirmed-dead)', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const d = await m.decide(peer(PK.x), [peer(PK.y)], deadProbe, SILENT_NOW);
    expect(d).toEqual({ evict: true, reason: 'confirmed-dead' });
  });

  it('one relay alive outweighs another reporting dead (one ack clears suspicion)', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const mixed: RelayProbe<PeerRef> = async (relay) => relay.devicePubkey === PK.y; // y=alive, others=dead
    const d = await m.decide(peer(PK.x), [peer(PK.y), peer('relay-2')], mixed, SILENT_NOW);
    expect(d.evict).toBe(false);
  });
});

describe('refresh — evicted set per scope', () => {
  it('evicts a crashed peer that relays confirm dead; never probes/evicts self', async () => {
    const probed: string[] = [];
    const m = new AuthorityEvictionMonitor({
      relayProbe: () => async (_relay, target) => {
        probed.push(target.devicePubkey);
        return false; // every relay reports the target dead
      },
    });
    primeBeats(m, PK.x); // x is silent/high-φ
    m.observe([obs(PK.y, SILENT_NOW), obs(PK.self, SILENT_NOW)], SILENT_NOW); // y + self fresh
    const evicted = await m.refresh('scope-1', [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW), obs(PK.self, SILENT_NOW)], PK.self, SILENT_NOW);
    expect([...evicted]).toEqual([PK.x]);
    expect(probed).not.toContain(PK.self); // self is never a probe target
  });

  it('clears an eviction once the peer recovers (φ drops below threshold)', async () => {
    const m = new AuthorityEvictionMonitor({ relayProbe: () => async () => false });
    primeBeats(m, PK.x);
    let evicted = await m.refresh('s', [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)], PK.self, SILENT_NOW);
    expect([...evicted]).toEqual([PK.x]);
    // x beats again → φ drops → next refresh clears it.
    m.observe([obs(PK.x, SILENT_NOW)], SILENT_NOW);
    evicted = await m.refresh('s', [obs(PK.x, SILENT_NOW), obs(PK.y, SILENT_NOW)], PK.self, SILENT_NOW + 1);
    expect([...evicted]).toEqual([]);
  });
});

describe('beforeSelect — hot path: sync read + throttled background refresh', () => {
  it('returns empty on first call, then the evicted set after the background refresh', async () => {
    let resolveProbe!: () => void;
    const gate = new Promise<void>((r) => (resolveProbe = r));
    const m = new AuthorityEvictionMonitor({
      relayProbe: () => async (_r, target) => {
        await gate;
        return target.devicePubkey === PK.x ? false : true; // x dead
      },
    });
    primeBeats(m, PK.x);
    const observations = [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)];
    // First call: sync, empty (the probe hasn't resolved).
    expect([...m.beforeSelect('s', observations, PK.self, SILENT_NOW)]).toEqual([]);
    // Let the background probe complete, then the cache has x.
    resolveProbe();
    await vi.waitFor(() => expect([...m.excludedPubkeys('s')]).toEqual([PK.x]));
  });

  it('throttles refreshes (a second call within the window does not re-probe)', async () => {
    let refreshes = 0;
    const m = new AuthorityEvictionMonitor({
      refreshThrottleMs: 10_000,
      relayProbe: () => async () => {
        refreshes++;
        return false;
      },
    });
    primeBeats(m, PK.x);
    const observations = [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)];
    m.beforeSelect('s', observations, PK.self, SILENT_NOW);
    m.beforeSelect('s', observations, PK.self, SILENT_NOW + 100); // within throttle
    await vi.waitFor(() => expect(refreshes).toBeGreaterThan(0));
    expect(refreshes).toBe(1); // only the first call probed
  });
});

describe('selection integration: an excluded pubkey is not the authority', () => {
  const rows = [
    { device_pubkey: PK.x, github_user_id: 1, machine_label: 'x', last_seen_ms: SILENT_NOW },
    { device_pubkey: PK.y, github_user_id: 2, machine_label: 'y', last_seen_ms: SILENT_NOW },
  ];
  const self: SelfSwarmIdentity = { githubUserId: 3, devicePubkey: PK.self };

  it('without eviction, the lowest pubkey (x) is the authority', () => {
    const r = selectAuthorityFromRows(rows, self, SILENT_NOW, 90_000);
    expect(r.peer?.devicePubkey).toBe(PK.x);
  });

  it('with x excluded (relay-confirmed dead), the next pubkey (y) becomes authority', () => {
    const r = selectAuthorityFromRows(rows, self, SILENT_NOW, 90_000, new Set([PK.x]));
    expect(r.peer?.devicePubkey).toBe(PK.y);
  });

  it('self is never excluded even if its pubkey is in the excluded set', () => {
    const r = selectAuthorityFromRows(rows, self, SILENT_NOW, 90_000, new Set([PK.x, PK.y, PK.self]));
    // x + y excluded → only self remains → isSelf.
    expect(r.isSelf).toBe(true);
  });
});

describe('module singleton', () => {
  it('install / read / reset', () => {
    expect(getAuthorityEvictionMonitor()).toBeNull();
    const m = new AuthorityEvictionMonitor();
    setAuthorityEvictionMonitor(m);
    expect(getAuthorityEvictionMonitor()).toBe(m);
    __resetAuthorityEvictionMonitorForTests();
    expect(getAuthorityEvictionMonitor()).toBeNull();
  });
});

// ── Deeper branch coverage (depth pass, su-7f3e0376) ────────────────────────
describe('deeper edges — replay resistance, hot-path quiet, re-entrancy, partial-signal', () => {
  it('observe ignores a stale/out-of-order lastSeenMs (no spurious heartbeat corrupts φ)', () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x); // beats at T0, +1000, +2000
    expect(m.phi(PK.x, SILENT_NOW)).toBeGreaterThan(8); // long silence → high φ
    // A replayed / out-of-order presence row (lastSeenMs <= last recorded) must NOT register as a
    // fresh beat — else a stale row would falsely "revive" a dead peer and suppress its eviction.
    m.observe([obs(PK.x, T0 + 1_500)], SILENT_NOW); // 1500 <= last-seen 2000 → skipped
    expect(m.phi(PK.x, SILENT_NOW)).toBeGreaterThan(8); // φ unchanged — still high
    // Positive control: a genuinely newer beat DOES reset φ low.
    m.observe([obs(PK.x, SILENT_NOW)], SILENT_NOW);
    expect(m.phi(PK.x, SILENT_NOW)).toBeLessThan(8);
  });

  it('beforeSelect stays OFF the probe path when the pool is healthy (no suspect, no prior eviction)', async () => {
    let probes = 0;
    const m = new AuthorityEvictionMonitor({ relayProbe: () => async () => { probes++; return false; } });
    const fresh = [obs(PK.x, SILENT_NOW), obs(PK.y, SILENT_NOW)]; // everyone just beat → low φ
    m.observe(fresh, SILENT_NOW);
    expect([...m.beforeSelect('s', fresh, PK.self, SILENT_NOW)]).toEqual([]);
    await new Promise((r) => setTimeout(r, 20)); // give any (wrongly-triggered) background refresh a tick
    expect(probes).toBe(0); // healthy pool never probes — byte-identical to staleness-only selection
  });

  it('a high-φ SELF never triggers an eviction probe (we never evict ourselves)', async () => {
    let probes = 0;
    const m = new AuthorityEvictionMonitor({ relayProbe: () => async () => { probes++; return false; } });
    primeBeats(m, PK.self); // self is the silent / high-φ one
    m.observe([obs(PK.y, SILENT_NOW)], SILENT_NOW); // y is fresh
    const observations = [obs(PK.self, T0 + 2_000), obs(PK.y, SILENT_NOW)];
    expect([...m.beforeSelect('s', observations, PK.self, SILENT_NOW)]).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toBe(0); // self being suspicious is excluded from the refresh trigger
  });

  it('refresh is re-entrancy-guarded per scope — a concurrent refresh does not double-probe', async () => {
    let resolveProbe!: () => void;
    const gate = new Promise<void>((r) => (resolveProbe = r));
    let probeRounds = 0;
    const m = new AuthorityEvictionMonitor({
      relayProbe: () => async () => { probeRounds++; await gate; return false; },
    });
    primeBeats(m, PK.x); // x silent / high-φ
    const observations = [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)];
    const first = m.refresh('s', observations, PK.self, SILENT_NOW); // in-flight, gated on the probe
    const second = await m.refresh('s', observations, PK.self, SILENT_NOW); // re-entrant → returns the cache now
    expect([...second]).toEqual([]); // no eviction yet — the second call did NOT run a probe round
    resolveProbe();
    expect([...(await first)]).toEqual([PK.x]); // the first refresh completes + evicts x
    expect(probeRounds).toBe(1); // only the first refresh probed (no storm)
  });

  it('decide evicts on a PARTIAL signal: ≥1 reachable relay confirms dead even if another is unreachable', async () => {
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    // relay y is reachable and reports dead; relay-2 is unreachable (no signal, not a "dead" vote).
    const mixed: RelayProbe<PeerRef> = async (relay) => {
      if (relay.devicePubkey === PK.y) return false; // reachable → reports dead
      throw new PeerUnreachableError('relay-2 unreachable');
    };
    const d = await m.decide(peer(PK.x), [peer(PK.y), peer('relay-2')], mixed, SILENT_NOW);
    // A single reachable dead-witness is a real signal (not our blindness) → evict.
    expect(d).toEqual({ evict: true, reason: 'confirmed-dead' });
  });
});
