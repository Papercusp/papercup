/**
 * authority-rpc-swarm-wiring.test.ts — the flag-gated boot registration
 * (shared-hive-hardening-2026-06-13 P-001 / D-005). Pins: OFF → no-op (HTTP-only
 * stands, the swarm is never constructed); ON + device identity → a composite
 * transport is registered; ON but no identity → no-op; idempotent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wireAuthorityRpcSwarmTransport, _testing } from '../authority-rpc-swarm-wiring';
import { CompositePeerRpcTransport } from '../composite-peer-rpc-transport';
import type { PeerRpcTransport } from '../peer-rpc-transport';
import type { HyperswarmLike } from '../../sync/hyperbee/swarm';

const fakeSwarm = (): HyperswarmLike =>
  ({
    on() {},
    off() {},
    join() {
      return {};
    },
    leave() {},
    connections: [],
  }) as unknown as HyperswarmLike;

const signer = { devicePubkey: 'self-pk', sign: async (b: Buffer) => b };

beforeEach(() => {
  _testing.reset();
});

describe('wireAuthorityRpcSwarmTransport', () => {
  it('is a no-op when the flag is OFF (HTTP-only stands; the swarm is never built)', async () => {
    const setTransport = vi.fn();
    const getSwarm = vi.fn(async () => fakeSwarm());
    const wired = await wireAuthorityRpcSwarmTransport({
      getFlag: async () => false,
      resolveSigner: async () => signer,
      getSwarm,
      setTransport,
    });
    expect(wired).toBe(false);
    expect(setTransport).not.toHaveBeenCalled();
    expect(getSwarm).not.toHaveBeenCalled(); // flag checked before the (heavy) swarm
  });

  it('registers a composite transport when the flag is ON and a device identity resolves', async () => {
    let registered: PeerRpcTransport | undefined;
    const wired = await wireAuthorityRpcSwarmTransport({
      getFlag: async () => true,
      resolveSigner: async () => signer,
      getSwarm: async () => fakeSwarm(),
      setTransport: (t) => {
        registered = t;
      },
    });
    expect(wired).toBe(true);
    expect(registered).toBeInstanceOf(CompositePeerRpcTransport);
  });

  it('is a no-op when ON but no device identity is resolvable (stay HTTP-only)', async () => {
    const setTransport = vi.fn();
    const wired = await wireAuthorityRpcSwarmTransport({
      getFlag: async () => true,
      resolveSigner: async () => null,
      getSwarm: async () => fakeSwarm(),
      setTransport,
    });
    expect(wired).toBe(false);
    expect(setTransport).not.toHaveBeenCalled();
  });

  it('is idempotent — a second call after a successful wire does nothing', async () => {
    const setTransport = vi.fn();
    const deps = {
      getFlag: async () => true,
      resolveSigner: async () => signer,
      getSwarm: async () => fakeSwarm(),
      setTransport,
    };
    expect(await wireAuthorityRpcSwarmTransport(deps)).toBe(true);
    expect(await wireAuthorityRpcSwarmTransport(deps)).toBe(false);
    expect(setTransport).toHaveBeenCalledOnce();
  });

  it('never throws — a swarm-construction failure leaves HTTP-only in place', async () => {
    const setTransport = vi.fn();
    const wired = await wireAuthorityRpcSwarmTransport({
      getFlag: async () => true,
      resolveSigner: async () => signer,
      getSwarm: async () => {
        throw new Error('swarm boom');
      },
      setTransport,
    });
    expect(wired).toBe(false);
    expect(setTransport).not.toHaveBeenCalled();
  });
});
