/**
 * D-011 recurrence guard: BOTH spawn chokepoints (the bee path operator-spawn.ts and the
 * /invoke route spawn.ts) must build their gateway+account env via resolveSpawnGatewayEnv, so the
 * /invoke path can't drift back to the un-pooled shared `~/.claude` credential — the regression
 * where Queen/overwatch wakes 429'd on one account's weekly cap (silent 0-token, no placements)
 * while the 8-account pool sat idle. This locks the routing contract the env must carry.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ getFlag: vi.fn(), selectSpawnAccount: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    INFERENCE_GATEWAY: 'inference-gateway',
    INFERENCE_GATEWAY_MULTI_ACCOUNT: 'inference-gateway-multi-account',
  },
}));
vi.mock('../deployment/account-pool-store', () => ({ selectSpawnAccount: h.selectSpawnAccount }));

import { resolveSpawnGatewayEnv } from './spawn-env';

beforeEach(() => {
  h.getFlag.mockReset();
  h.selectSpawnAccount.mockReset();
  delete process.env.PAPERCUSP_GATEWAY_PORT;
});

describe('resolveSpawnGatewayEnv — the shared spawn-chokepoint routing decision (D-011)', () => {
  test('gateway ON + multi-account ON + an available account → base URL + account pin + governor key', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('acct-7');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'papercusp', ownerId: 's-1' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe('acct-7');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-account: acct-7');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-owner: s-1');
    expect(h.selectSpawnAccount).toHaveBeenCalledWith('ws', 'papercusp');
  });

  test('gateway OFF → {} (unchanged direct egress); never selects an account', async () => {
    h.getFlag.mockResolvedValue(false);
    expect(await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h' })).toEqual({});
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test('gateway ON, multi-account OFF → base URL only, no account pin / governor key', async () => {
    h.getFlag.mockImplementation(async (flag: string) => flag === 'inference-gateway');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-2' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect('PAPERCUSP_ACCOUNT_ID' in env).toBe(false);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-papercusp-owner: s-2');
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test('account selection throws → fail-soft: base URL, no pin (gateway routes to active())', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockRejectedValue(new Error('pool unreadable'));
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect('PAPERCUSP_ACCOUNT_ID' in env).toBe(false);
  });

  test('multi-account ON but pool empty (select → undefined) → base URL, no pin', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue(undefined);
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect('PAPERCUSP_ACCOUNT_ID' in env).toBe(false);
  });
});
