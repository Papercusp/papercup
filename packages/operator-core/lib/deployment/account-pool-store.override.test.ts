/**
 * selectSpawnAccount — the P-004 session-now override applied at the LIVE bee-spawn
 * chokepoint. Mocks the pool load + the override read; asserts forced-pin, exclude,
 * over-restrictive→frame-default, no-op-when-unset, and fail-soft-on-read-error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn();
const getAccountOverride = vi.fn();

vi.mock('../operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: vi.fn(async () => {}),
}));
vi.mock('./account-session-override', async (orig) => ({
  ...(await orig<typeof import('./account-session-override')>()),
  // The override is now WORKSPACE-LEVEL (D-015) — readAccountOverride calls getAccountOverride(ws).
  getAccountOverride: (...a: [string]) => getAccountOverride(...a),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));

import { selectSpawnAccount } from './account-pool-store';

function acct(id: string, provider?: 'claude' | 'codex') {
  return { id, provider, credentialRef: `token:/p/${id}`, addedAt: 0, boundTo: [] as string[], rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccountOverride.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
});
afterEach(() => vi.clearAllMocks());

describe('selectSpawnAccount — P-004 override', () => {
  it('no override + ≥2 accounts → the normal selector picks one (override is a no-op)', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('a'), acct('b')] });
    expect(['a', 'b']).toContain(await selectSpawnAccount('ws', 'h', undefined));
  });

  it('forced to one account PINS it (even though it is the sole candidate)', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('a'), acct('b'), acct('c')] });
    getAccountOverride.mockResolvedValue({ forcedAccounts: ['b'], excludeAccounts: [] });
    expect(await selectSpawnAccount('ws', 'h', undefined)).toBe('b');
  });

  it('exclude drops an account; the sole survivor is pinned', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('a'), acct('b')] });
    getAccountOverride.mockResolvedValue({ forcedAccounts: [], excludeAccounts: ['a'] });
    expect(await selectSpawnAccount('ws', 'h', undefined)).toBe('b');
  });

  it('over-restrictive override (no candidate) → undefined = frame-default credential (fail-soft)', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('a'), acct('b')] });
    getAccountOverride.mockResolvedValue({ forcedAccounts: ['zzz'], excludeAccounts: [] });
    expect(await selectSpawnAccount('ws', 'h', undefined)).toBeUndefined();
  });

  it('a failing override READ fails soft to today’s behaviour (≤1 account → undefined)', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('a')] });
    getAccountOverride.mockRejectedValue(new Error('pg down'));
    expect(await selectSpawnAccount('ws', 'h', undefined)).toBeUndefined();
  });

  it('no override + one Codex account still pins it so Codex uses the registered gateway account', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('codex-a', 'codex')] });
    expect(await selectSpawnAccount('ws', 'h', undefined, 'codex')).toBe('codex-a');
  });

  it('provider-filtered Codex selection applies overrides only within Codex accounts', async () => {
    readOperatorState.mockResolvedValue({ accounts: [acct('claude-a'), acct('codex-a', 'codex'), acct('codex-b', 'codex')] });
    getAccountOverride.mockResolvedValue({ forcedAccounts: ['claude-a'], excludeAccounts: [] });
    expect(await selectSpawnAccount('ws', 'h', undefined, 'codex')).toBeUndefined();

    getAccountOverride.mockResolvedValue({ forcedAccounts: ['codex-b'], excludeAccounts: [] });
    expect(await selectSpawnAccount('ws', 'h', undefined, 'codex')).toBe('codex-b');
  });
});
