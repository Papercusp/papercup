import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  requestWalletBindingChallenge: vi.fn(),
  submitWalletBinding: vi.fn(),
  readWalletBinding: vi.fn(),
  unbindWallet: vi.fn(),
}));

vi.mock('../../cupboard/wallet-binding-io', () => io);

import tool from './bind-wallet';

function body(result: unknown): Record<string, unknown> {
  const response = result as { data?: unknown; content?: Array<{ text: string }> };
  return (response.data ?? JSON.parse(response.content![0].text)) as Record<string, unknown>;
}

describe('cupboard:bind-wallet agent-tool production door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the expected model-facing contract and rejects caller-supplied identity', () => {
    expect(tool.name).toBe('cupboard:bind-wallet');
    expect(tool.capability).toBe('harness:write');
    expect(
      tool.args.safeParse({
        op: 'challenge',
        walletAddress: '0x1111111111111111111111111111111111111111',
        principalId: 'gh:999',
      }).success,
    ).toBe(false);
  });

  it('routes challenge and verify through the hosted Worker transport', async () => {
    io.requestWalletBindingChallenge.mockResolvedValue({
      ok: true,
      status: 201,
      value: { challengeId: 'wbc_1', message: 'sign me' },
    });
    const challenged = await tool.handler(
      {
        op: 'challenge',
        walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 42161,
      },
      {} as never,
    );
    expect(io.requestWalletBindingChallenge).toHaveBeenCalledWith({
      walletAddress: '0x1111111111111111111111111111111111111111',
      chainId: 42161,
    });
    expect(body(challenged)).toMatchObject({ ok: true, challengeId: 'wbc_1' });

    io.submitWalletBinding.mockResolvedValue({
      ok: true,
      status: 201,
      value: { bound: true, binding: { walletAddress: '0x1111' } },
    });
    const verified = await tool.handler(
      {
        op: 'verify',
        challengeId: 'wbc_1',
        signature: `0x${'11'.repeat(65)}`,
      },
      {} as never,
    );
    expect(io.submitWalletBinding).toHaveBeenCalledWith({
      challengeId: 'wbc_1',
      signature: `0x${'11'.repeat(65)}`,
    });
    expect(body(verified)).toMatchObject({ ok: true, bound: true });
  });

  it('routes self-only status/unbind and preserves Worker refusal evidence', async () => {
    io.readWalletBinding.mockResolvedValue({
      ok: false,
      status: 401,
      error: 'unauthorized',
      detail: 'bad bearer',
    });
    expect(body(await tool.handler({ op: 'status' }, {} as never))).toEqual({
      ok: false,
      error: 'unauthorized',
      detail: 'bad bearer',
      status: 401,
    });

    io.unbindWallet.mockResolvedValue({
      ok: true,
      status: 200,
      value: { unbound: true },
    });
    expect(body(await tool.handler({ op: 'unbind' }, {} as never))).toEqual({
      ok: true,
      unbound: true,
    });
  });
});
