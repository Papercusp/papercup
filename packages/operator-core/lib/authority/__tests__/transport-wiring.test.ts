/**
 * transport-wiring — the boot registration of the authority HTTP wire-leg
 * (P-006, coord-system-e2e-testing-2026-06-10). Asserts the addressing
 * precedence (configured resolver > env map > null), the malformed-env
 * degradation, the boot idempotency guard, and that the wired transport makes
 * routeToAuthority fail OPEN (never hard-fail) when no address resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configurePeerAddressResolver,
  resolvePeerAddress,
  wireAuthorityRpcTransport,
  PEER_ADDRESSES_ENV,
  _testing,
} from '../transport-wiring';
import {
  getPeerRpcTransport,
  setPeerRpcTransport,
  NULL_PEER_RPC_TRANSPORT,
  __resetPeerRpcTransportForTests,
} from '../peer-rpc-transport';
import { HttpPeerRpcTransport } from '../http-peer-rpc-transport';
import { routeToAuthority, type LockAuthorityDeps, type PeerRef } from '../lock-authority';

const PEER: PeerRef = { devicePubkey: 'pk-remote', githubUserId: 7, machineLabel: 'box-b' };

const ENV_BEFORE = process.env[PEER_ADDRESSES_ENV];

beforeEach(() => {
  delete process.env[PEER_ADDRESSES_ENV];
  _testing.reset();
});

afterEach(() => {
  if (ENV_BEFORE === undefined) delete process.env[PEER_ADDRESSES_ENV];
  else process.env[PEER_ADDRESSES_ENV] = ENV_BEFORE;
  _testing.reset();
  __resetPeerRpcTransportForTests();
  vi.restoreAllMocks();
});

describe('resolvePeerAddress precedence', () => {
  it('resolves null when nothing is configured', async () => {
    expect(await resolvePeerAddress(PEER)).toBeNull();
  });

  it('reads the env map by device_pubkey', async () => {
    process.env[PEER_ADDRESSES_ENV] = JSON.stringify({ 'pk-remote': 'http://10.0.0.2:3070' });
    expect(await resolvePeerAddress(PEER)).toBe('http://10.0.0.2:3070');
    expect(await resolvePeerAddress({ ...PEER, devicePubkey: 'pk-other' })).toBeNull();
  });

  it('configured resolver wins over the env map', async () => {
    process.env[PEER_ADDRESSES_ENV] = JSON.stringify({ 'pk-remote': 'http://env:3070' });
    configurePeerAddressResolver(() => 'http://mesh:3070');
    expect(await resolvePeerAddress(PEER)).toBe('http://mesh:3070');
  });

  it('falls through to the env map when the configured resolver returns null', async () => {
    process.env[PEER_ADDRESSES_ENV] = JSON.stringify({ 'pk-remote': 'http://env:3070' });
    configurePeerAddressResolver(() => null);
    expect(await resolvePeerAddress(PEER)).toBe('http://env:3070');
  });

  it('malformed env JSON warns once and resolves nothing', async () => {
    process.env[PEER_ADDRESSES_ENV] = '{not json';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await resolvePeerAddress(PEER)).toBeNull();
    expect(await resolvePeerAddress(PEER)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(PEER_ADDRESSES_ENV);
  });

  it('ignores non-string entries in the env map', async () => {
    process.env[PEER_ADDRESSES_ENV] = JSON.stringify({ 'pk-remote': 42, 'pk-ok': 'http://b:3070' });
    expect(await resolvePeerAddress(PEER)).toBeNull();
    expect(await resolvePeerAddress({ ...PEER, devicePubkey: 'pk-ok' })).toBe('http://b:3070');
  });
});

describe('wireAuthorityRpcTransport', () => {
  it('registers an HttpPeerRpcTransport', () => {
    __resetPeerRpcTransportForTests();
    wireAuthorityRpcTransport();
    expect(getPeerRpcTransport()).toBeInstanceOf(HttpPeerRpcTransport);
  });

  it('is idempotent and never clobbers a later explicit registration', () => {
    __resetPeerRpcTransportForTests();
    wireAuthorityRpcTransport();
    // A deployment rig overrides after boot…
    setPeerRpcTransport(NULL_PEER_RPC_TRANSPORT);
    // …and a second boot-path call must NOT re-register over it.
    wireAuthorityRpcTransport();
    expect(getPeerRpcTransport()).toBe(NULL_PEER_RPC_TRANSPORT);
  });

  it('routeToAuthority fails OPEN through the wired transport when no address resolves', async () => {
    __resetPeerRpcTransportForTests();
    wireAuthorityRpcTransport();

    const NOW = 1_700_000_000_000;
    const deps: LockAuthorityDeps = {
      now: () => NOW,
      resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'pk-self-zzz' }),
      fetchPresenceRows: async () => [
        { device_pubkey: 'pk-remote', github_user_id: 7, machine_label: 'box-b', last_seen_ms: NOW - 1000 },
        { device_pubkey: 'pk-self-zzz', github_user_id: 2, machine_label: 'self', last_seen_ms: NOW - 1000 },
      ],
    };
    const local = vi.fn(async () => 'local-grant');
    const res = await routeToAuthority('h-slug', {
      local,
      remote: { kind: 'lock.acquire', payload: {}, decode: (raw) => raw as string },
    }, deps);
    expect(res.via).toBe('fail-open');
    expect(res.value).toBe('local-grant');
    expect(res.warning).toContain('unreachable');
    expect(local).toHaveBeenCalledTimes(1);
  });
});
