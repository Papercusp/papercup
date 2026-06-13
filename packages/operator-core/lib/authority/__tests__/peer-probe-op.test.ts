/**
 * Tests for the P-016 relay-side `peer.probe` op + the authority-exempt dispatch,
 * and the end-to-end relay-probe over the PeerRpcTransport seam (the single-box
 * loopback-equivalent of the SWIM eviction path; the real two-machine proof is
 * D-003 real-hardware-gated). All in-process — no HTTP, no PG.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleAuthorityRpc,
  registerAuthorityOp,
  registeredAuthorityOpKinds,
  getAuthorityExemptKinds,
  __resetAuthorityOpsForTests,
  type AuthorityOpHandler,
} from '../authority-op-registry';
import { buildPeerProbeHandler, registerPeerProbeOp } from '../peer-probe-op';
import {
  AuthorityEvictionMonitor,
  PEER_PROBE_OP_KIND,
  type PresenceObservation,
} from '../peer-eviction';
import type { PeerRef } from '../lock-authority';
import {
  setPeerRpcTransport,
  __resetPeerRpcTransportForTests,
  PeerUnreachableError,
  type PeerRpcTransport,
  type AuthorityRpcRequest,
} from '../peer-rpc-transport';

const T0 = 1_700_000_000_000;
const PK = { x: 'aaa-x', y: 'mmm-y', self: 'zzz-self' };
function peer(pk: string): PeerRef {
  return { devicePubkey: pk, githubUserId: 1, machineLabel: pk };
}
function obs(pk: string, lastSeenMs: number): PresenceObservation {
  return { peer: peer(pk), lastSeenMs };
}
function primeBeats(m: AuthorityEvictionMonitor, pk: string): void {
  m.observe([obs(pk, T0)], T0);
  m.observe([obs(pk, T0 + 1_000)], T0 + 1_000);
  m.observe([obs(pk, T0 + 2_000)], T0 + 2_000);
}
const SILENT_NOW = T0 + 60_000;

afterEach(() => {
  __resetAuthorityOpsForTests();
  __resetPeerRpcTransportForTests();
});

describe('buildPeerProbeHandler', () => {
  it('answers alive per the injected liveness check', async () => {
    const handler = buildPeerProbeHandler({ isPeerLive: (target) => target === PK.x });
    expect(await handler({ targetPubkey: PK.x }, 'scope')).toEqual({ alive: true });
    expect(await handler({ targetPubkey: PK.y }, 'scope')).toEqual({ alive: false });
  });

  it('rejects a malformed payload', async () => {
    const handler = buildPeerProbeHandler({ isPeerLive: () => true });
    await expect(handler({}, 'scope')).rejects.toThrow(/targetPubkey required/);
    await expect(handler({ targetPubkey: 123 }, 'scope')).rejects.toThrow();
  });
});

describe('peer.probe is authority-EXEMPT (a relay answers without being the authority)', () => {
  it('registerPeerProbeOp marks the kind authority-exempt', () => {
    registerPeerProbeOp({ isPeerLive: () => true });
    expect(registeredAuthorityOpKinds()).toContain(PEER_PROBE_OP_KIND);
    expect(getAuthorityExemptKinds().has(PEER_PROBE_OP_KIND)).toBe(true);
  });

  it('handleAuthorityRpc answers peer.probe even when verifyIsAuthority is false', async () => {
    registerPeerProbeOp({ isPeerLive: () => true });
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: PEER_PROBE_OP_KIND, payload: { targetPubkey: PK.x } },
      { verifyIsAuthority: async () => false }, // we are NOT the authority
    );
    expect(res).toEqual({ ok: true, result: { alive: true } });
  });

  it('a NON-exempt op IS refused when verifyIsAuthority is false (sanity)', async () => {
    const h: AuthorityOpHandler = async () => ({ done: true });
    registerAuthorityOp('lock.acquire', h); // not exempt
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'lock.acquire', payload: {} },
      { verifyIsAuthority: async () => false },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_authority');
  });
});

/**
 * A fake PeerRpcTransport that routes a `peer.probe` to the addressed RELAY's own
 * liveness view (via the REAL handleAuthorityRpc + buildPeerProbeHandler, with the
 * authority gate exempted exactly as the production route/swarm dispatch do). An
 * "offline" relay throws PeerUnreachableError (→ indirectProbe: no signal).
 */
function fakeRelayTransport(relayViews: Map<string, { alive: Set<string>; offline?: boolean }>): PeerRpcTransport {
  return {
    async rpc(relay: PeerRef, req: AuthorityRpcRequest): Promise<unknown> {
      const view = relayViews.get(relay.devicePubkey);
      if (!view || view.offline) {
        throw new PeerUnreachableError(`relay ${relay.machineLabel} offline`, relay);
      }
      const handler = buildPeerProbeHandler({ isPeerLive: (target) => view.alive.has(target) });
      const res = await handleAuthorityRpc(
        { harnessSlug: req.harnessSlug, kind: req.kind, payload: req.payload },
        { handlers: { [PEER_PROBE_OP_KIND]: handler }, verifyIsAuthority: async () => false, authorityExemptKinds: new Set([PEER_PROBE_OP_KIND]) },
      );
      if (!res.ok) throw new Error(`probe failed: ${res.error}`);
      return res.result;
    },
  };
}

describe('relay-probe over the PeerRpcTransport seam (single-box loopback-equivalent)', () => {
  it('evicts a crashed authority that the relay reports dead', async () => {
    // Relay Y is alive, and from Y's view X is NOT alive (X crashed).
    setPeerRpcTransport(fakeRelayTransport(new Map([[PK.y, { alive: new Set([PK.y, PK.self]) }]])));
    const m = new AuthorityEvictionMonitor(); // default relayProbe → transportRelayProbe → the fake transport
    primeBeats(m, PK.x); // X high-φ
    const evicted = await m.refresh('s', [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)], PK.self, SILENT_NOW);
    expect([...evicted]).toEqual([PK.x]);
  });

  it('KEEPS a suspected authority that the relay still sees alive (the SWIM false-positive guard)', async () => {
    // Y can still see X fresh — X is alive, merely unreachable from us.
    setPeerRpcTransport(fakeRelayTransport(new Map([[PK.y, { alive: new Set([PK.x, PK.y, PK.self]) }]])));
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const evicted = await m.refresh('s', [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)], PK.self, SILENT_NOW);
    expect([...evicted]).toEqual([]);
  });

  it('KEEPS when the only relay is itself unreachable (we are blind → no eviction)', async () => {
    setPeerRpcTransport(fakeRelayTransport(new Map([[PK.y, { alive: new Set(), offline: true }]])));
    const m = new AuthorityEvictionMonitor();
    primeBeats(m, PK.x);
    const evicted = await m.refresh('s', [obs(PK.x, T0 + 2_000), obs(PK.y, SILENT_NOW)], PK.self, SILENT_NOW);
    expect([...evicted]).toEqual([]);
  });
});
