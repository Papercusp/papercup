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
    GATEWAY_PRIORITY_TIERS: 'gateway-priority-tiers',
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
    expect(h.selectSpawnAccount).toHaveBeenCalledWith('ws', 'papercusp', undefined, 'claude');
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

  test('Codex backend → selects a Codex account and emits no Anthropic env/header leakage', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('codex-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'papercusp', ownerId: 's-1', backend: 'codex' });

    expect(env).toEqual({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    expect(h.selectSpawnAccount).toHaveBeenCalledWith('ws', 'papercusp', undefined, 'codex');
  });

  test('OMP backend → unsupported provider account routing; no gateway env and no account selection', async () => {
    h.getFlag.mockResolvedValue(true);
    expect(await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'papercusp', ownerId: 's-1', backend: 'omp' })).toEqual({});
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test('Codex backend + multi-account OFF → {} — codex needs an account pin; no Anthropic base URL leaks', async () => {
    // gateway ON, multi-account OFF: no account is selected, and codex emits ONLY PAPERCUSP_ACCOUNT_ID,
    // so with no account there is nothing to emit → {} (never an ANTHROPIC_BASE_URL, which is claude-only).
    h.getFlag.mockImplementation(async (flag: string) => flag === 'inference-gateway');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'codex' });
    expect(env).toEqual({});
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test('Codex backend + multi-account ON but empty pool (select → undefined) → {} (no pin, no leakage)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue(undefined);
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', backend: 'codex' });
    expect(env).toEqual({});
    expect(h.selectSpawnAccount).toHaveBeenCalledWith('ws', 'h', undefined, 'codex');
  });

  // ── gateway-priority-tiers-2026-06-22: the role → x-papercusp-priority header (flag-gated) ──
  test('tier flag ON + role → stamps the x-papercusp-priority header from the role', async () => {
    h.getFlag.mockResolvedValue(true); // all flags ON incl. GATEWAY_PRIORITY_TIERS
    h.selectSpawnAccount.mockResolvedValue('acct-7');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', role: 'queen' });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-priority: queen');
  });

  test('tier flag OFF → NO priority header even with a role (flag-OFF byte-identical)', async () => {
    // gateway + multi-account ON, but the tier flag OFF → the role must NOT be stamped.
    h.getFlag.mockImplementation(async (flag: string) => flag !== 'gateway-priority-tiers');
    h.selectSpawnAccount.mockResolvedValue('acct-7');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', role: 'queen' });
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-papercusp-priority');
  });

  test('tier flag ON but no role → no priority header (nothing to map)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('acct-7');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1' });
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-papercusp-priority');
  });
});
