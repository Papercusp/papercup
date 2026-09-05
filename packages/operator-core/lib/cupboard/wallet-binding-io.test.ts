import { describe, expect, it, vi } from 'vitest';
import {
  readWalletBinding,
  requestWalletBindingChallenge,
  submitWalletBinding,
  unbindWallet,
} from './wallet-binding-io';

describe('wallet-binding hosted transport', () => {
  it('opens a challenge without accepting a caller-supplied principal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
      expect(JSON.parse(String(init?.body))).toEqual({
        walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 42161,
      });
      return Response.json({ challengeId: 'wbc_1', message: 'sign me' }, { status: 201 });
    });

    const result = await requestWalletBindingChallenge(
      {
        walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 42161,
      },
      { fetchImpl, baseUrl: 'https://cupboard.test/', authToken: 'test-token' },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cupboard.test/commerce/wallet-bindings/challenges',
      expect.any(Object),
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
  });

  it('submits only the server challenge id and wallet signature', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        challengeId: 'wbc_1',
        signature: `0x${'11'.repeat(65)}`,
      });
      return Response.json({ binding: { walletAddress: '0x1' } });
    });
    expect(
      await submitWalletBinding(
        { challengeId: 'wbc_1', signature: `0x${'11'.repeat(65)}` },
        { fetchImpl, baseUrl: 'https://cupboard.test', authToken: 'test-token' },
      ),
    ).toMatchObject({ ok: true });
  });

  it('uses authenticated self-only status and unbind routes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const deps = { fetchImpl, baseUrl: 'https://cupboard.test', authToken: 'test-token' };
    await readWalletBinding(deps);
    await unbindWallet(deps);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://cupboard.test/commerce/wallet-bindings/me', 'GET'],
      ['https://cupboard.test/commerce/wallet-bindings/me', 'DELETE'],
    ]);
  });

  it('preserves hosted refusal codes for the agent-tool caller', async () => {
    const result = await readWalletBinding({
      baseUrl: 'https://cupboard.test',
      authToken: 'test-token',
      fetchImpl: async () =>
        Response.json({ error: 'unauthorized', detail: 'bad bearer' }, { status: 401 }),
    });
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: 'unauthorized',
      detail: 'bad bearer',
    });
  });
});
