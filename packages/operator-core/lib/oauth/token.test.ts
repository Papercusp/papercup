import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __cacheSizeForTest,
  __resetTokenCacheForTest,
  getOAuthToken,
  withRetry,
  type TokenHelperContext,
} from './token';
import {
  __resetRegistryForTest,
  registerProvider,
  type OAuthProvider,
} from './providers';

function makeStorage(initial: Record<string, unknown>) {
  let state = { ...initial };
  return {
    state: () => ({ ...state }),
    storage: {
      async read() {
        return { ...state };
      },
      async update(_p: string, _h: string, patch: Record<string, unknown>) {
        state = { ...state, ...patch };
      },
    },
  };
}

function makeProvider(refreshImpl: OAuthProvider['refresh']): OAuthProvider {
  return {
    id: 'test',
    config: {} as OAuthProvider['config'],
    buildAuthorizeUrl: () => '',
    exchangeCode: async () => ({ accessToken: 'unused' }),
    refresh: refreshImpl,
  };
}

afterEach(() => {
  __resetTokenCacheForTest();
  __resetRegistryForTest();
});

describe('getOAuthToken', () => {
  it('returns null when no token stored', async () => {
    const { storage } = makeStorage({});
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    expect(await getOAuthToken(ctx, 'github_token')).toBeNull();
  });

  it('returns the stored token when not near expiry', async () => {
    const { storage } = makeStorage({
      github_token: 'gho_fresh',
      github_token_expires_at: Date.now() + 60 * 60 * 1000,
    });
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    expect(await getOAuthToken(ctx, 'github_token')).toBe('gho_fresh');
  });

  it('refreshes when token is expired', async () => {
    const { state, storage } = makeStorage({
      github_token: 'gho_old',
      github_token_refresh: 'rfr',
      github_token_expires_at: Date.now() - 1000,
    });
    const refresh = vi.fn().mockResolvedValue({
      accessToken: 'gho_new',
      refreshToken: 'rfr2',
      expiresAt: Date.now() + 3600_000,
    });
    registerProvider(makeProvider(refresh));
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    expect(await getOAuthToken(ctx, 'github_token')).toBe('gho_new');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state().github_token).toBe('gho_new');
    expect(state().github_token_refresh).toBe('rfr2');
  });

  it('shares a single in-flight refresh across concurrent callers', async () => {
    const { storage } = makeStorage({
      github_token: 'gho_old',
      github_token_refresh: 'rfr',
      github_token_expires_at: Date.now() - 1000,
    });
    let refreshCount = 0;
    const refresh = vi.fn(async () => {
      refreshCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        accessToken: `gho_new_${refreshCount}`,
        refreshToken: 'rfr2',
        expiresAt: Date.now() + 3600_000,
      };
    });
    registerProvider(makeProvider(refresh));
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    const results = await Promise.all([
      getOAuthToken(ctx, 'github_token'),
      getOAuthToken(ctx, 'github_token'),
      getOAuthToken(ctx, 'github_token'),
      getOAuthToken(ctx, 'github_token'),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r === 'gho_new_1')).toBe(true);
    expect(__cacheSizeForTest()).toBe(0);
  });

  it('throws and marks expired when no refresh token is available', async () => {
    const { state, storage } = makeStorage({
      github_token: 'gho_old',
      github_token_expires_at: Date.now() - 1000,
    });
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    await expect(getOAuthToken(ctx, 'github_token')).rejects.toThrow(/expired/);
    expect(state().github_token_expired).toBe(true);
  });

  it('returns access token as-is when no expiry is recorded', async () => {
    const { storage } = makeStorage({ github_token: 'ghp_pat_no_expiry' });
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    expect(await getOAuthToken(ctx, 'github_token')).toBe('ghp_pat_no_expiry');
  });
});

describe('withRetry', () => {
  it('returns first response when not 401', async () => {
    const { storage } = makeStorage({ github_token: 'tok' });
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    const result = await withRetry(ctx, 'github_token', async (t) => ({
      status: 200,
      result: `ok-${t}`,
    }));
    expect(result).toBe('ok-tok');
  });

  it('forces refresh + retries once on 401', async () => {
    const { state, storage } = makeStorage({
      github_token: 'old',
      github_token_refresh: 'rfr',
      github_token_expires_at: Date.now() + 60 * 60 * 1000,
    });
    let count = 0;
    const refresh = vi.fn().mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'rfr2',
      expiresAt: Date.now() + 3600_000,
    });
    registerProvider(makeProvider(refresh));
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    const result = await withRetry(ctx, 'github_token', async (t) => {
      count++;
      if (count === 1) return { status: 401, result: '' };
      return { status: 200, result: `ok-${t}` };
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toBe('ok-new');
    expect(state().github_token).toBe('new');
  });

  it('marks expired and throws on second 401', async () => {
    const { state, storage } = makeStorage({
      github_token: 'old',
      github_token_refresh: 'rfr',
      github_token_expires_at: Date.now() + 60 * 60 * 1000,
    });
    registerProvider(
      makeProvider(async () => ({
        accessToken: 'new',
        refreshToken: 'rfr2',
        expiresAt: Date.now() + 3600_000,
      })),
    );
    const ctx: TokenHelperContext = {
      plugin: 'p',
      harness: 'h',
      resolveProvider: () => ({ provider: 'test' }),
      storage,
    };
    await expect(
      withRetry(ctx, 'github_token', async () => ({ status: 401, result: '' })),
    ).rejects.toThrow(/reconnect/);
    expect(state().github_token_expired).toBe(true);
  });
});
