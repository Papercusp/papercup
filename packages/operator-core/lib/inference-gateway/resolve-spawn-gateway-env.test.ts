/**
 * D-011 recurrence guard: BOTH spawn chokepoints (the bee path operator-spawn.ts and the
 * /invoke route spawn.ts) must build their gateway+account env via resolveSpawnGatewayEnv, so the
 * /invoke path can't drift back to the un-pooled shared `~/.claude` credential — the regression
 * where Queen/overwatch wakes 429'd on one account's weekly cap (silent 0-token, no placements)
 * while the 8-account pool sat idle. This locks the routing contract the env must carry.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ getFlag: vi.fn(), selectSpawnAccount: vi.fn(), loadAccountPool: vi.fn(), supportsBearer: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    INFERENCE_GATEWAY: 'inference-gateway',
    INFERENCE_GATEWAY_MULTI_ACCOUNT: 'inference-gateway-multi-account',
    GATEWAY_PRIORITY_TIERS: 'gateway-priority-tiers',
  },
}));
vi.mock('../deployment/account-pool-store', () => ({ selectSpawnAccount: h.selectSpawnAccount, loadAccountPool: h.loadAccountPool }));
vi.mock('./credential-store', () => ({ credentialRefSupportsOpenAiBearer: h.supportsBearer }));

import { resolveSpawnGatewayEnv } from './spawn-env';

beforeEach(() => {
  h.getFlag.mockReset();
  h.selectSpawnAccount.mockReset();
  h.loadAccountPool.mockReset();
  h.supportsBearer.mockReset();
  h.loadAccountPool.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex', credentialRef: 'token:/codex' }] });
  h.supportsBearer.mockResolvedValue(true);
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
    expect(h.supportsBearer).toHaveBeenCalledWith('token:/codex');
  });

  test('Codex backend + ChatGPT-auth-only account → no gateway pin; native Codex auth handles it', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('codex-main');
    h.loadAccountPool.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex', credentialRef: 'file:/codex-auth.json' }] });
    h.supportsBearer.mockResolvedValue(false);
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'papercusp', ownerId: 's-1', backend: 'codex' });

    expect(env).toEqual({});
    expect(h.supportsBearer).toHaveBeenCalledWith('file:/codex-auth.json');
  });

  test('OMP backend → emits the per-session models.yml (gateway provider + pin headers) + selector, NOT the claude ANTHROPIC_BASE_URL env (P-006/D-008)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('claude-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'papercusp', ownerId: 's-1', backend: 'omp' });
    // omp consumes the pin via its per-session models.yml — the account-id signal PLUS the
    // models.yml bytes + the model selector the per-spawn agent-home seeder writes & force-selects;
    // never the claude-CLI gatewaySpawnEnv (ANTHROPIC_BASE_URL / ANTHROPIC_CUSTOM_HEADERS).
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe('claude-main');
    expect(env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-sonnet-4-6');
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('papercusp-gateway:');
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('baseUrl: "http://127.0.0.1:8788"');
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('"x-papercusp-account": "claude-main"');
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('"x-papercusp-owner": "s-1"');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
    expect(h.selectSpawnAccount).toHaveBeenCalledWith('ws', 'papercusp', undefined, 'claude');
  });

  test('OMP backend + role Claude model spec → exposes + selects the ROLE model (P-005/WI-951 fidelity)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('claude-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'omp', model: 'anthropic/claude-opus-4-8:high' });
    expect(env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-opus-4-8');
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('claude-opus-4-8');
  });

  test('OMP backend + local (non-claude) model spec → falls back to the wire default (no fidelity override)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.selectSpawnAccount.mockResolvedValue('claude-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'omp', model: 'ollama/ornith:fast' });
    expect(env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-sonnet-4-6');
  });

  test('OMP backend + tier flag ON + role → bakes the x-papercusp-priority pin into the models.yml (P-006)', async () => {
    h.getFlag.mockResolvedValue(true); // all flags ON incl. GATEWAY_PRIORITY_TIERS
    h.selectSpawnAccount.mockResolvedValue('claude-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'omp', role: 'bee' });
    expect(env.PAPERCUSP_OMP_MODELS_YML).toContain('"x-papercusp-priority": "bee"');
  });

  test('OMP backend + tier flag OFF → NO priority pin in the models.yml (flag-OFF parity)', async () => {
    h.getFlag.mockImplementation(async (flag: string) => flag !== 'gateway-priority-tiers');
    h.selectSpawnAccount.mockResolvedValue('claude-main');
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'omp', role: 'bee' });
    expect(env.PAPERCUSP_OMP_MODELS_YML ?? '').not.toContain('x-papercusp-priority');
  });

  test('OMP backend + no account selected → {} (nothing to pin; never an ANTHROPIC_BASE_URL leak)', async () => {
    h.getFlag.mockImplementation(async (flag: string) => flag === 'inference-gateway'); // multi-account OFF
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'omp' });
    expect(env).toEqual({});
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

  // ── account-routing-3-options (owner, 2026-06-30): the explicit per-spawn `account` override ──
  test("account='default'/'none'/'system' → skip the gateway entirely (direct egress), even with it ON", async () => {
    h.getFlag.mockResolvedValue(true); // gateway + multi-account ON — the override must STILL skip it
    for (const kw of ['default', 'none', 'system', 'DEFAULT']) {
      const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', account: kw });
      expect(env).toEqual({});
    }
    // No pool selection for a default-routed spawn.
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test("account='auto' → gateway-routed with NO account pin (it auto-selects + fails over); never calls selectSpawnAccount", async () => {
    h.getFlag.mockResolvedValue(true);
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', account: 'auto' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect('PAPERCUSP_ACCOUNT_ID' in env).toBe(false);
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-papercusp-account');
    // 'auto' means "let the gateway pick" — the multi-account selector is bypassed entirely.
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test("account='<pool-id>' → HARD pin to that account (no failover); bypasses the selector + env pin", async () => {
    h.getFlag.mockResolvedValue(true);
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', account: 'aviynw9' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw9');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-account: aviynw9');
    // The explicit operator-chosen pin is HARD — the gateway must not fail it over.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-account-pin: hard');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-papercusp-owner: s-1');
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
  });

  test("account override is honored regardless of MULTI_ACCOUNT (auto works with only INFERENCE_GATEWAY on)", async () => {
    h.getFlag.mockImplementation(async (flag: string) => flag === 'inference-gateway'); // multi-account OFF
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', account: 'auto' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect('PAPERCUSP_ACCOUNT_ID' in env).toBe(false);
  });

  test('account override is INERT when the gateway is OFF → {} (no routing at all)', async () => {
    h.getFlag.mockResolvedValue(false);
    expect(await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', account: 'aviynw9' })).toEqual({});
    expect(await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', account: 'auto' })).toEqual({});
  });

  test("account='<pool-id>' on a Codex spawn → pins the id (config-file routing), no Anthropic leakage", async () => {
    h.getFlag.mockResolvedValue(true);
    h.loadAccountPool.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex', credentialRef: 'token:/codex' }] });
    const env = await resolveSpawnGatewayEnv({ workspaceId: 'ws', slug: 'h', ownerId: 's-1', backend: 'codex', account: 'codex-main' });
    expect(env).toEqual({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    // The explicit id bypasses the selector (trusts the operator-given id like PAPERCUSP_SPAWN_ACCOUNT_PIN).
    expect(h.selectSpawnAccount).not.toHaveBeenCalled();
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
