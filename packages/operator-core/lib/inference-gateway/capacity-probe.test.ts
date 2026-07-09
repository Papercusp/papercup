/**
 * capacity-probe tests (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * The probe's whole job is to be TRUSTWORTHY EVIDENCE for an unwall (plan D-001), so the tests pin the
 * two ways it could lie:
 *   - a FAILED probe must never look like an unwall (that would strand the fleet on a capped account);
 *   - a 429 must still be read as signal (it carries the real reset), not thrown away as an error.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseCapacityHeaders,
  provesUnwall,
  storedWindows,
  isWalledCandidate,
  probeEgressFor,
  probeAccountCapacity,
  probeCapacityForAccounts,
  UNWALL_EPSILON,
} from './capacity-probe';
import type { ClaudeAccount } from '../deployment/account-pool';

const FULL = 0.97;

const acct = (id: string, rate: Partial<ClaudeAccount['rate']> = {}, extra: Partial<ClaudeAccount> = {}): ClaudeAccount =>
  ({
    id,
    credentialRef: `token:/tmp/${id}`,
    rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, ...rate },
    ...extra,
  }) as ClaudeAccount;

/** A fetch stub returning the given headers + status, with a drainable body. */
const fakeFetch = (headers: Record<string, string>, status = 200) =>
  vi.fn(async () => new Response('{}', { status, headers })) as unknown as typeof fetch;

const okDeps = (headers: Record<string, string>, status = 200) => ({
  fetchImpl: fakeFetch(headers, status),
  resolveToken: async () => 'tok',
  buildDispatcher: async () => undefined,
});

describe('parseCapacityHeaders', () => {
  it('maps the unified 5h + 7d headers into the projection shape', () => {
    expect(
      parseCapacityHeaders({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1783639800',
        'anthropic-ratelimit-unified-7d-utilization': '0.19',
        'anthropic-ratelimit-unified-7d-reset': '1784048400',
      }),
    ).toEqual({
      utilization: 0.42,
      windowResetAt: 1783639800_000,
      utilization7d: 0.19,
      windowResetAt7d: 1784048400_000,
    });
  });

  it('returns an EMPTY projection when no unified header is present (the "no signal" case)', () => {
    expect(parseCapacityHeaders({ 'retry-after': '30', 'content-type': 'application/json' })).toEqual({});
  });
});

describe('provesUnwall', () => {
  it('is TRUE when a stored 7d wall reads materially lower upstream', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 0.05 }, FULL)).toBe(true);
  });

  it('is FALSE when upstream CONFIRMS the wall (a real 1.0)', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 1.0 }, FULL)).toBe(false);
  });

  it('is FALSE when the account was never walled (nothing to unwall)', () => {
    expect(provesUnwall({ utilization7d: 0.2 }, { utilization7d: 0.05 }, FULL)).toBe(false);
  });

  it('is FALSE when there is no fresh reading at all — a failed probe must never unwall', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, {}, FULL)).toBe(false);
  });

  it('ignores a move smaller than the epsilon (header jitter is not a reset)', () => {
    const before = { utilization7d: 1.0 };
    expect(provesUnwall(before, { utilization7d: 1.0 - UNWALL_EPSILON / 2 }, FULL)).toBe(false);
    expect(provesUnwall(before, { utilization7d: 1.0 - UNWALL_EPSILON * 2 }, FULL)).toBe(true);
  });

  it('a freed 5h window also unwalls a 5h-walled account', () => {
    expect(provesUnwall({ utilization: 0.99 }, { utilization: 0.01 }, FULL)).toBe(true);
  });
});

describe('isWalledCandidate', () => {
  it('selects accounts at/over the full-utilization threshold in EITHER window', () => {
    expect(isWalledCandidate(acct('a', { utilization7d: 1.0 }), FULL)).toBe(true);
    expect(isWalledCandidate(acct('b', { utilization: 0.98 }), FULL)).toBe(true);
    expect(isWalledCandidate(acct('c', { utilization: 0.5, utilization7d: 0.2 }), FULL)).toBe(false);
    expect(isWalledCandidate(acct('d'), FULL)).toBe(false); // never observed
  });
});

describe('probeEgressFor', () => {
  it('prefers the egressPool head (the gateway rotation head) over the legacy singular egress', () => {
    const a = acct('a', {}, { egress: { proxyUrl: 'http://legacy:3128' }, egressPool: [{ proxyUrl: 'http://head:3128' }, {}] });
    expect(probeEgressFor(a)).toEqual({ proxyUrl: 'http://head:3128' });
  });

  it('falls back to the singular egress when no pool is configured', () => {
    expect(probeEgressFor(acct('a', {}, { egress: { proxyUrl: 'http://only:3128' } }))).toEqual({ proxyUrl: 'http://only:3128' });
  });

  it('is undefined (box-default IP) when neither is set', () => {
    expect(probeEgressFor(acct('a'))).toBeUndefined();
  });
});

describe('storedWindows', () => {
  it('projects the stored rate windows, preserving `undefined` for never-observed', () => {
    expect(storedWindows(acct('a', { utilization7d: 1, windowResetAt7d: 5 }))).toEqual({
      utilization: undefined,
      windowResetAt: undefined,
      utilization7d: 1,
      windowResetAt7d: 5,
    });
  });
});

describe('probeAccountCapacity', () => {
  it('reads a 200 response`s unified headers and reports the unwall', async () => {
    const a = acct('walled', { utilization7d: 1.0, windowResetAt7d: 999 });
    const r = await probeAccountCapacity(a, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.04' }), FULL);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.windows.utilization7d).toBe(0.04);
    expect(r.before.utilization7d).toBe(1.0);
    expect(r.unwalls).toBe(true);
  });

  it('treats a 429 as SIGNAL, not failure — it confirms a real wall and carries the true reset', async () => {
    const a = acct('walled', { utilization7d: 1.0 });
    const r = await probeAccountCapacity(
      a,
      okDeps(
        { 'anthropic-ratelimit-unified-7d-utilization': '1.0', 'anthropic-ratelimit-unified-7d-reset': '1784048400' },
        429,
      ),
      FULL,
    );
    expect(r.ok).toBe(true); // a reading was obtained
    expect(r.status).toBe(429);
    expect(r.unwalls).toBe(false); // ...and it CONFIRMS the wall
    expect(r.windows.windowResetAt7d).toBe(1784048400_000);
  });

  it('a transport failure is captured, non-fatal, and NEVER unwalls', async () => {
    const a = acct('walled', { utilization7d: 1.0 });
    const r = await probeAccountCapacity(
      a,
      {
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED via proxy');
        }) as unknown as typeof fetch,
        resolveToken: async () => 'tok',
        buildDispatcher: async () => undefined,
      },
      FULL,
    );
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(r.before.utilization7d).toBe(1.0); // before-state still reported for the evidence table
  });

  it('a credential-resolve failure is captured per-account, not thrown', async () => {
    const r = await probeAccountCapacity(
      acct('bad-cred', { utilization7d: 1.0 }),
      {
        fetchImpl: fakeFetch({}),
        resolveToken: async () => {
          throw new Error('dead credential');
        },
        buildDispatcher: async () => undefined,
      },
      FULL,
    );
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/dead credential/);
  });

  it('a 200 with NO unified header is not a usable reading', async () => {
    const r = await probeAccountCapacity(acct('quiet', { utilization7d: 1.0 }), okDeps({ 'content-type': 'application/json' }), FULL);
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/no anthropic-ratelimit-unified/);
  });

  it('sends a minimal 1-token request and authenticates with the account bearer + oauth beta', async () => {
    const f = fakeFetch({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' });
    await probeAccountCapacity(acct('a'), { fetchImpl: f, resolveToken: async () => 'TOK', buildDispatcher: async () => undefined }, FULL);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer TOK');
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(JSON.parse(init.body as string).max_tokens).toBe(1);
  });
});

describe('probeCapacityForAccounts', () => {
  it('skips non-claude providers (codex has no unified-window dialect)', async () => {
    const accounts = [acct('claude-a'), acct('codex-a', {}, { provider: 'codex' })];
    const out = await probeCapacityForAccounts(accounts, {}, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' }));
    expect(out.map((r) => r.accountId)).toEqual(['claude-a']);
  });

  it('walledOnly probes ONLY the walled accounts', async () => {
    const accounts = [acct('healthy', { utilization7d: 0.2 }), acct('walled', { utilization7d: 1.0 })];
    const out = await probeCapacityForAccounts(accounts, { walledOnly: true }, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.02' }));
    expect(out.map((r) => r.accountId)).toEqual(['walled']);
    expect(out[0].unwalls).toBe(true);
  });

  it('one account failing never fails the sweep — N accounts in, N rows out', async () => {
    const accounts = [acct('good', { utilization7d: 1.0 }), acct('bad', { utilization7d: 1.0 })];
    let call = 0;
    const out = await probeCapacityForAccounts(
      accounts,
      {},
      {
        resolveToken: async () => 'tok',
        buildDispatcher: async () => undefined,
        fetchImpl: (async () => {
          if (call++ === 1) throw new Error('boom');
          return new Response('{}', { status: 200, headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.01' } });
        }) as unknown as typeof fetch,
      },
    );
    expect(out).toHaveLength(2);
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(out.filter((r) => !r.ok)[0].error).toMatch(/boom/);
  });

  it('returns rows in stable input order despite bounded-concurrency fan-out', async () => {
    const accounts = ['a', 'b', 'c', 'd', 'e'].map((id) => acct(id));
    const out = await probeCapacityForAccounts(accounts, {}, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' }));
    expect(out.map((r) => r.accountId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
