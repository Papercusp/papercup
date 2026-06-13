/**
 * composite-peer-rpc-transport.test.ts — the fall-through transport
 * (shared-hive-hardening-2026-06-13 D-005). Pins: unreachable falls through to
 * the next transport; the first reachable result wins (later transports not
 * tried); a NON-unreachable error short-circuits immediately (never masked);
 * all-unreachable → PeerUnreachableError; nullish entries are filtered; empty →
 * PeerUnreachableError.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompositePeerRpcTransport } from '../composite-peer-rpc-transport';
import { PeerUnreachableError, type PeerRpcTransport } from '../peer-rpc-transport';
import type { PeerRef } from '../lock-authority';

const peer = { devicePubkey: 'pk', machineLabel: 'box' } as PeerRef;
const req = { harnessSlug: 'h', kind: 'lock.acquire', payload: {} };

const reachable = (value: unknown): PeerRpcTransport => ({ rpc: vi.fn(async () => value) });
const unreachable = (): PeerRpcTransport => ({
  rpc: vi.fn(async () => {
    throw new PeerUnreachableError('nope', peer);
  }),
});
const failing = (msg: string): PeerRpcTransport => ({
  rpc: vi.fn(async () => {
    throw new Error(msg);
  }),
});

describe('CompositePeerRpcTransport', () => {
  it('returns the first transport result and does not try later transports', async () => {
    const first = reachable('A');
    const second = reachable('B');
    const t = new CompositePeerRpcTransport([first, second]);
    await expect(t.rpc(peer, req)).resolves.toBe('A');
    expect(second.rpc).not.toHaveBeenCalled();
  });

  it('falls through PeerUnreachableError to the next transport', async () => {
    const first = unreachable();
    const second = reachable('B');
    const t = new CompositePeerRpcTransport([first, second]);
    await expect(t.rpc(peer, req)).resolves.toBe('B');
    expect(first.rpc).toHaveBeenCalledOnce();
    expect(second.rpc).toHaveBeenCalledOnce();
  });

  it('throws PeerUnreachableError when every transport is unreachable (fail-open)', async () => {
    const t = new CompositePeerRpcTransport([unreachable(), unreachable()]);
    await expect(t.rpc(peer, req)).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('rethrows a non-unreachable error immediately (a reachable authority failed)', async () => {
    const first = failing('lock store down');
    const second = reachable('B');
    const t = new CompositePeerRpcTransport([first, second]);
    const err = await t.rpc(peer, req).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PeerUnreachableError);
    expect(String(err)).toMatch(/lock store down/);
    expect(second.rpc).not.toHaveBeenCalled();
  });

  it('filters nullish entries and throws PeerUnreachableError when none remain', async () => {
    const t = new CompositePeerRpcTransport([undefined as unknown as PeerRpcTransport, null as unknown as PeerRpcTransport]);
    await expect(t.rpc(peer, req)).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('skips a nullish entry but still uses the reachable one', async () => {
    const ok = reachable('ok');
    const t = new CompositePeerRpcTransport([undefined as unknown as PeerRpcTransport, ok]);
    await expect(t.rpc(peer, req)).resolves.toBe('ok');
  });
});
