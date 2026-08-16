/**
 * swarm-guard.test.ts — the connection-rate DoS guard (EI-20578573707248054).
 *
 * This guard had NO tests. It is process-global, it silently BANS peers for ten
 * minutes, and the failure it produces ("the topic never re-pairs", replication
 * stalls with no cause) has already sent one live investigation down the wrong
 * path (boot.ts:4777-4786, WI-5355/WI-5481).
 *
 * The case that matters is CO-LOCATED PEERS: several distinct peers reaching a
 * host from ONE egress IP — every peer in a Tier-1/Tier-2 perf mesh (all on
 * loopback), and in production any office NAT, k8s cluster egress, or cloud NAT
 * gateway. Forming a flat N-peer mesh means ~N-1 inbound connections in one
 * burst, so the guard's budget is spent by the mesh itself.
 */

import { describe, expect, it } from 'vitest';
import {
  createSwarmGuard,
  CONN_RATE,
  CONN_RATE_IP,
  DEFAULT_BAN_TTL_MS,
  SUPPORTED_MESH_PEERS,
} from '../swarm-guard';

/** Distinct peer identities, as hex keys. */
const peerKey = (i: number) => `${i.toString(16).padStart(2, '0')}`.repeat(32);

describe('swarm guard — co-located peers must not spend each other budget', () => {
  it('N distinct peers behind ONE IP each connecting ONCE are all admitted', async () => {
    // The load here is the MINIMUM a flat mesh can produce: every peer connects
    // exactly once. If that alone trips the guard, the guard caps mesh size.
    const guard = createSwarmGuard();
    const peers = CONN_RATE.capacity * 2 + 5; // comfortably above the budget
    const results: Array<{ allow: boolean; reason?: string }> = [];
    for (let i = 0; i < peers; i++) {
      results.push(await guard.recordConnection(peerKey(i), '127.0.0.1'));
    }
    const rejected = results.filter((r) => !r.allow);
    expect(
      rejected,
      `${rejected.length}/${peers} distinct peers were rejected though each connected ONCE — ` +
        `the rate bucket is shared across the IP, so co-located peers spend each other budget`,
    ).toHaveLength(0);
  });

  it('one peer bursting does NOT ban its co-located neighbours', async () => {
    const guard = createSwarmGuard();
    const noisy = peerKey(1);
    const innocent = peerKey(2);
    // One peer reconnect-storms well past the budget.
    for (let i = 0; i < CONN_RATE.capacity * 3; i++) {
      await guard.recordConnection(noisy, '10.0.0.7');
    }
    // A DIFFERENT peer that happens to share the egress IP arrives once.
    const verdict = await guard.recordConnection(innocent, '10.0.0.7');
    expect(
      verdict.allow,
      'an innocent peer sharing the egress IP was refused because a neighbour burst — ' +
        'the penalty must land on the offending KEY, not the shared IP',
    ).toBe(true);
    expect(guard.isBannedIp('10.0.0.7')).toBe(false);
    // The actual offender is still banned — the guard must not simply go soft.
    expect(guard.isBannedKey(noisy)).toBe(true);
  });

  it('still stops a genuine single-peer reconnect storm', async () => {
    // CALIBRATION: the two assertions above are only meaningful if the guard can
    // still fire at all. Without this, deleting the guard would pass them both.
    const guard = createSwarmGuard();
    const attacker = peerKey(9);
    let refused = false;
    for (let i = 0; i < CONN_RATE.capacity * 3 && !refused; i++) {
      const r = await guard.recordConnection(attacker, '203.0.113.9');
      if (!r.allow) refused = true;
    }
    expect(refused, 'a peer far exceeding the connection budget was never refused').toBe(true);
    expect(guard.isBannedKey(attacker)).toBe(true);
  });

  it('a ban expires on its own so a mistaken ban self-heals', async () => {
    let t = 1_000_000;
    const guard = createSwarmGuard({ now: () => t });
    const attacker = peerKey(3);
    for (let i = 0; i < CONN_RATE.capacity * 3; i++) {
      await guard.recordConnection(attacker, '203.0.113.1');
    }
    expect(guard.isBannedKey(attacker)).toBe(true);
    t += DEFAULT_BAN_TTL_MS + 1;
    expect(guard.isBannedKey(attacker)).toBe(false);
  });

  it('the per-IP budget is large enough for the supported mesh fan-out', () => {
    // A flat mesh of N peers produces ~N-1 inbound connections per peer during
    // formation, all from co-located addresses — so the per-IP capacity is a hard
    // ceiling on supported peers no matter what the sync substrate can do.
    // harden-shared-hive-to-256-peers targets 256; the old single bucket of 30
    // silently capped it at ~31 (D-008's measured knee: fine at 16, marginal at
    // 32, collapsed at 64 with a p95 of 601s against a 600s ban TTL).
    expect(
      CONN_RATE_IP.capacity,
      `per-IP capacity ${CONN_RATE_IP.capacity} is below the ${SUPPORTED_MESH_PEERS}-peer mesh fan-out — ` +
        `formation alone will trip the guard and ban the whole address for ${DEFAULT_BAN_TTL_MS / 60000} minutes`,
    ).toBeGreaterThanOrEqual(SUPPORTED_MESH_PEERS);
  });

  it('a genuine flood from ONE address still bans that address', () => {
    // CALIBRATION for the widened per-IP ceiling: raising it must not amount to
    // deleting it. Distinct keys each connecting once — i.e. exactly the shape
    // the co-location fix admits — but far past the per-IP ceiling.
    return (async () => {
      const guard = createSwarmGuard();
      let refused = false;
      for (let i = 0; i < CONN_RATE_IP.capacity + 50 && !refused; i++) {
        const r = await guard.recordConnection(peerKey(i % 200) + i.toString(16), '198.51.100.4');
        if (!r.allow) refused = true;
      }
      expect(refused, 'an address far past the per-IP ceiling was never refused').toBe(true);
      expect(guard.isBannedIp('198.51.100.4')).toBe(true);
    })();
  });

  it('an unidentifiable peer (no key) is still charged against the IP ceiling', async () => {
    // The IP bucket cannot be dropped: a peer with no resolvable key would
    // otherwise be accounted nowhere at all.
    const guard = createSwarmGuard();
    let refused = false;
    for (let i = 0; i < CONN_RATE_IP.capacity + 50 && !refused; i++) {
      const r = await guard.recordConnection(undefined, '198.51.100.9');
      if (!r.allow) refused = true;
    }
    expect(refused, 'a keyless peer flooding one address was never refused').toBe(true);
  });

  it('the two budgets are independent — per-key stays tight while per-IP is wide', () => {
    // The fix is only meaningful if the per-key limit did NOT get widened along
    // with the IP one; otherwise a single peer regains an enormous budget.
    expect(CONN_RATE.capacity).toBeLessThan(CONN_RATE_IP.capacity);
    expect(CONN_RATE.capacity).toBeLessThanOrEqual(30);
  });
});
