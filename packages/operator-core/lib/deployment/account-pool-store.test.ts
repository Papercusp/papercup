/**
 * Tests for the account-pool wiring (cloud-deployment-layer Phase 7): deploy-time
 * selection (P-020), the scale-out reaction (P-021), and the governor-pause → pool
 * observer (P-019/P-021). All IO is injected; the observer test fires a REAL
 * account-keyed governor pause through the shared registry.
 * Run: cd packages/operator-core && npx vitest run account-pool-store
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Frame } from '@papercusp/deployment-driver';
import { getGovernor, resetGovernorRegistry } from '@papercusp/papercup-shared/agent';
import {
  selectAccountForDeploy,
  handleAccountExhausted,
  initAccountScaleObserver,
  _resetAccountScaleObserver,
  type ScaleOutResult,
} from './account-pool-store';
import {
  emptyPool,
  registerAccount,
  bindAccount,
  recordAccountPenalty,
  getAccount,
  type AccountPool,
} from './account-pool';

const T0 = 1_000_000_000_000;
const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 5));

function poolOf(...ids: string[]): AccountPool {
  let p = emptyPool();
  ids.forEach((id, i) => (p = registerAccount(p, { id, credentialRef: `token:~/.papercusp/${id}` }, T0 + i)));
  return p;
}
const frameOf = (id: string): Frame => ({ id, target: 'hetzner', placement: 'remote' });

describe('selectAccountForDeploy (P-020)', () => {
  it('respects an explicit credentialRef (no pool touch)', async () => {
    let saved = false;
    const out = await selectAccountForDeploy({ target: 'hetzner', credentialRef: 'token:/pinned' }, 'h1', 'ws', {
      loadPool: async () => poolOf('a'),
      savePool: async () => void (saved = true),
    });
    expect(out.credentialRef).toBe('token:/pinned');
    expect(saved).toBe(false);
  });

  it('returns the config unchanged when the pool is empty', async () => {
    const out = await selectAccountForDeploy({ target: 'hetzner' }, 'h1', 'ws', {
      loadPool: async () => emptyPool(),
      savePool: async () => {},
    });
    expect(out).toEqual({ target: 'hetzner' });
  });

  it('binds the most-available account + stamps credentialRef/accountId', async () => {
    let pool = poolOf('a', 'b');
    const out = await selectAccountForDeploy({ target: 'hetzner', region: 'ash' }, 'h1', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      savePool: async (p) => void (pool = p),
    });
    expect(out).toMatchObject({ target: 'hetzner', region: 'ash', credentialRef: 'token:~/.papercusp/a', accountId: 'a' });
    expect(getAccount(pool, 'a')!.boundTo).toEqual(['h1']);
  });
});

describe('handleAccountExhausted (P-021)', () => {
  it('not-sustained → no provisioning', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountPenalty(pool, 'a', T0, { pausedUntil: T0 + MIN });
    const res = await handleAccountExhausted('a', 'ws', {
      now: () => T0 + 30_000,
      loadPool: async () => pool,
      savePool: async () => {},
      memberDeployment: async () => ({ target: 'hetzner' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    });
    expect(res).toEqual({ scaledOut: false, reason: 'not-sustained' });
  });

  it('sustained + fresh account → redeploys bound members on the fresh account + rebinds', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountPenalty(pool, 'a', T0, { pausedUntil: T0 + 31 * MIN }); // long pause = sustained
    const redeployed: { slug: string; credentialRef?: string; accountId?: string }[] = [];
    const res = (await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      savePool: async (p) => void (pool = p),
      memberDeployment: async () => ({ target: 'hetzner', region: 'ash', size: 'cpx31' }),
      redeploy: async (slug, _ws, dep) => {
        redeployed.push({ slug, credentialRef: dep.credentialRef, accountId: dep.accountId });
        return { frame: frameOf(`f-${slug}`) };
      },
    })) as Extract<ScaleOutResult, { scaledOut: true }>;
    expect(res.scaledOut).toBe(true);
    expect(res.account).toBe('b');
    expect(redeployed).toEqual([{ slug: 'h1', credentialRef: 'token:~/.papercusp/b', accountId: 'b' }]);
    expect(getAccount(pool, 'b')!.boundTo).toContain('h1');
    expect(getAccount(pool, 'a')!.boundTo).not.toContain('h1');
  });

  it('no fresh account available → does not provision', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h1');
    pool = recordAccountPenalty(pool, 'a', T0, { pausedUntil: T0 + 31 * MIN });
    pool = recordAccountPenalty(pool, 'b', T0, { pausedUntil: T0 + 20 * MIN }); // b also paused
    const res = await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      savePool: async () => {},
      memberDeployment: async () => ({ target: 'hetzner' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    });
    expect(res).toEqual({ scaledOut: false, reason: 'no-fresh-account' });
  });

  it('a local-only member template is reported per-member, not provisioned', async () => {
    let pool = bindAccount(poolOf('a', 'b'), 'a', 'h-local');
    pool = recordAccountPenalty(pool, 'a', T0, { pausedUntil: T0 + 31 * MIN });
    const res = (await handleAccountExhausted('a', 'ws', {
      now: () => T0,
      loadPool: async () => pool,
      savePool: async (p) => void (pool = p),
      memberDeployment: async () => ({ target: 'local' }),
      redeploy: async () => ({ frame: frameOf('x') }),
    })) as Extract<ScaleOutResult, { scaledOut: true }>;
    expect(res.scaledOut).toBe(true);
    expect(res.members[0]).toMatchObject({ slug: 'h-local', error: expect.stringContaining('no cloud') });
  });
});

describe('initAccountScaleObserver (P-019/P-021 bridge)', () => {
  beforeEach(() => {
    resetGovernorRegistry();
    _resetAccountScaleObserver();
  });
  afterEach(() => _resetAccountScaleObserver());

  it('a sustained account-keyed pause records the penalty, emits exhausted, and scales out', async () => {
    let pool = bindAccount(poolOf('acct-1', 'acct-2'), 'acct-1', 'h1');
    const scaleCalls: string[] = [];
    const emitCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: true, account: 'acct-2', members: [] };
      },
      emitExhausted: (id) => emitCalls.push(id),
      log: () => {},
    });
    // A real account-keyed governor pause for acct-1, far enough out to be "sustained".
    getGovernor('anthropic', 'opus', undefined, 'acct-1').penalize({ retryAfterMs: 31 * MIN });
    await flush();
    expect(emitCalls).toEqual(['acct-1']);
    expect(scaleCalls).toEqual(['acct-1']);
    expect(getAccount(pool, 'acct-1')!.rate.penaltyCount).toBe(1);
  });

  it('a short (non-sustained) account pause records but does NOT scale out', async () => {
    let pool = poolOf('acct-1', 'acct-2');
    const scaleCalls: string[] = [];
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => (pool = m(pool)),
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: false, reason: 'not-sustained' };
      },
      emitExhausted: () => {},
      log: () => {},
    });
    getGovernor('anthropic', 'opus', undefined, 'acct-1').penalize({ retryAfterMs: 60_000 }); // 1 min
    await flush();
    expect(scaleCalls).toEqual([]);
    expect(getAccount(pool, 'acct-1')!.rate.penaltyCount).toBe(1);
  });

  it('a GLOBAL (non-account) pause is ignored by the account observer', async () => {
    let pool = poolOf('acct-1');
    const scaleCalls: string[] = [];
    let updated = false;
    initAccountScaleObserver({
      workspaceId: () => 'ws',
      updatePool: async (m) => {
        updated = true;
        return (pool = m(pool));
      },
      scaleOut: async (id) => {
        scaleCalls.push(id);
        return { scaledOut: false, reason: 'not-sustained' };
      },
      emitExhausted: () => {},
      log: () => {},
    });
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 31 * MIN }); // no accountId → global bucket
    await flush();
    expect(updated).toBe(false);
    expect(scaleCalls).toEqual([]);
  });
});
