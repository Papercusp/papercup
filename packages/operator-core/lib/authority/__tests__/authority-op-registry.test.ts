/**
 * Unit tests for the authority-op registry + handleAuthorityRpc (the receiving
 * side) and HttpPeerRpcTransport's error mapping (the sending side, with an
 * injected fetch — no real server). Phase 2 remote leg.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerAuthorityOp,
  registeredAuthorityOpKinds,
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
} from '../authority-op-registry';
import { HttpPeerRpcTransport } from '../http-peer-rpc-transport';
import { PeerUnreachableError } from '../peer-rpc-transport';
import type { PeerRef } from '../lock-authority';

const PEER: PeerRef = { devicePubkey: 'pubAAA', githubUserId: 1, machineLabel: 'm1' };

afterEach(() => __resetAuthorityOpsForTests());

describe('authority-op registry + handleAuthorityRpc', () => {
  it('dispatches a registered op to its handler and returns the result', async () => {
    registerAuthorityOp('lock.acquire', async (payload, harness) => ({ granted: true, payload, harness }));
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: { path: 'x' } });
    expect(res).toEqual({ ok: true, result: { granted: true, payload: { path: 'x' }, harness: 'h' } });
  });

  it('rejects an unknown kind', async () => {
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'nope', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_kind');
  });

  it('refuses when this machine is not the authority (verifyIsAuthority false)', async () => {
    registerAuthorityOp('claim.lease', async () => 'leased');
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'claim.lease', payload: {} },
      { verifyIsAuthority: () => false },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_authority');
  });

  it('runs the op when verifyIsAuthority is true', async () => {
    registerAuthorityOp('claim.lease', async () => 'leased');
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'claim.lease', payload: {} },
      { verifyIsAuthority: async () => true },
    );
    expect(res).toEqual({ ok: true, result: 'leased' });
  });

  it('returns handler_error (never throws) when the handler throws', async () => {
    registerAuthorityOp('lock.acquire', async () => {
      throw new Error('store down');
    });
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: 'lock.acquire', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('handler_error');
    expect(res.message).toMatch(/store down/);
  });

  it('rejects a duplicate kind registration', () => {
    registerAuthorityOp('dup', async () => 1);
    expect(() => registerAuthorityOp('dup', async () => 2)).toThrow(/already registered/);
    expect(registeredAuthorityOpKinds()).toContain('dup');
  });
});

describe('handleAuthorityRpc — verifyCaller (EI-322)', () => {
  it('rejects with unauthenticated when verifyCaller fails — BEFORE verifyIsAuthority runs', async () => {
    registerAuthorityOp('claim.lease', async () => 'leased');
    let authorityChecked = false;
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'claim.lease', payload: {} },
      {
        verifyCaller: () => ({ ok: false, reason: 'bad sig' }),
        verifyIsAuthority: () => {
          authorityChecked = true;
          return true;
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthenticated');
    expect(res.message).toMatch(/bad sig/);
    // An unproven caller must learn nothing about our authority status.
    expect(authorityChecked).toBe(false);
  });

  it('runs the op when verifyCaller passes (then verifyIsAuthority)', async () => {
    registerAuthorityOp('claim.lease', async () => 'leased');
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'claim.lease', payload: {} },
      { verifyCaller: () => ({ ok: true, devicePubkey: 'k' }), verifyIsAuthority: () => true },
    );
    expect(res).toEqual({ ok: true, result: 'leased' });
  });

  it('a throwing verifyCaller maps to unauthenticated (never a 500)', async () => {
    registerAuthorityOp('claim.lease', async () => 'leased');
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'claim.lease', payload: {} },
      {
        verifyCaller: () => {
          throw new Error('verifier exploded');
        },
        verifyIsAuthority: () => true,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthenticated');
    expect(res.message).toMatch(/exploded/);
  });

  it('still rejects an unknown kind before verifyCaller (cheap shape guard first)', async () => {
    let called = false;
    const res = await handleAuthorityRpc(
      { harnessSlug: 'h', kind: 'nope', payload: {} },
      {
        verifyCaller: () => {
          called = true;
          return { ok: true, devicePubkey: 'k' };
        },
      },
    );
    expect(res.error).toBe('unknown_kind');
    expect(called).toBe(false);
  });
});

describe('HttpPeerRpcTransport — error mapping (injected fetch)', () => {
  function transportWith(fetchImpl: unknown, resolveAddress: () => string | null = () => 'http://peer:3070') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new HttpPeerRpcTransport({ resolveAddress, fetchImpl: fetchImpl as any });
  }

  it('no address → PeerUnreachableError (fail open)', async () => {
    const t = transportWith(async () => ({ ok: true, status: 200, json: async () => ({}) }), () => null);
    await expect(t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} })).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('network failure → PeerUnreachableError', async () => {
    const t = transportWith(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} })).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('non-2xx → PeerUnreachableError', async () => {
    const t = transportWith(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} })).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('ok result → returns the result', async () => {
    const t = transportWith(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: 42 }) }));
    expect(await t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} })).toBe(42);
  });

  it('not_authority → PeerUnreachableError (failover gap → re-resolve / fail open)', async () => {
    const t = transportWith(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not_authority' }) }));
    await expect(t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} })).rejects.toBeInstanceOf(PeerUnreachableError);
  });

  it('handler_error → a regular Error (NOT fail-open — a real op failure is surfaced)', async () => {
    const t = transportWith(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'handler_error', message: 'boom' }) }));
    const err = await t.rpc(PEER, { harnessSlug: 'h', kind: 'k', payload: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PeerUnreachableError);
    expect(String(err)).toMatch(/boom/);
  });
});
