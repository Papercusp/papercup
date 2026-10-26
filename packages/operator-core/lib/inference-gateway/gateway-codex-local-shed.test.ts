/**
 * WI-6554700010029300 — a gateway-LOCAL codex 429 (the pacing shed: `admission-timeout` /
 * `account-unavailable`) must be shaped exactly like an unrescued upstream 429:
 *   - retry-after from the POOL horizon, capped at BEE_RETRY_AFTER_CAP_S — never a literal `1`
 *     (the codex CLI burns its ~4 retries in seconds → "exceeded retry limit, last status: 429");
 *   - the retries-exhausted + pool-recovery headers;
 *   - a recorded stall, so the stall-waker resumes the session when capacity returns.
 *
 * Regression history: the upstream-429 path got this shape after the same owner-reported error
 * text; commit 9a9fa87645 (2026-10-25) then added the local pacing-shed path with
 * `retry-after: 1` and no stall, and on 2026-10-26 ~80 Codex sessions died with
 * "exceeded retry limit, last status: 429" and were never resumed. The structural test below
 * fails if any codex local-shed site sends a 429 without going through `codexLocalShedHeaders`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { governorForBackend, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import {
  createInferenceGateway,
  ACCOUNT_HEADER,
  OWNER_HEADER,
  POOL_RECOVERY_AT_HEADER,
  RETRIES_EXHAUSTED_HEADER,
} from './gateway';
import { createFailoverPool } from './account-failover';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';

const model = 'gpt-6.1-sol';

describe('gateway-local codex 429 (pacing shed) is a resumable stall, not a retry-after:1 dead end', () => {
  let gateway: ReturnType<typeof createInferenceGateway> | undefined;
  let gatewayPort: number | undefined;
  const homes: string[] = [];

  beforeEach(() => {
    resetGovernorRegistry();
    configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore());
  });
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    gatewayPort = undefined;
    await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
    vi.restoreAllMocks();
    resetGatewayRequestOutcomeStore();
  });

  async function send(headers: Record<string, string>) {
    const port = gatewayPort ??= await gateway!.listen(0);
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'account-a', ...headers },
      body: JSON.stringify({ model, input: 'Reply briefly.', max_tokens: 8, stream: false }),
    });
    return { status: result.status, headers: result.headers, body: await result.text() };
  }

  it.each(['bearer', 'oauth'] as const)('%s lane: records a stall and hands back a pool-horizon retry-after', async transport => {
    const governor = governorForBackend('codex', model, undefined, 'account-a');
    vi.spyOn(governor, 'acquire').mockResolvedValue(null); // the pacing wait is exceeded → local shed
    const fetchImpl = vi.fn(async () => Response.json({ id: 'resp', object: 'response', status: 'completed', output: [] }));
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-local-shed-'));
    homes.push(home);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    await fs.writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, refresh_token: 'fixture-refresh', account_id: 'account-a',
    } }));
    gateway = createInferenceGateway({
      accountId: 'account-a',
      token: async () => 'claude-token',
      ...(transport === 'oauth'
        ? { codexCliAccounts: () => [{ accountId: 'account-a', home }], codexOAuthProxy: true }
        : { codexPool: createFailoverPool([{ accountId: 'account-a', token: async () => 'token-a' }]) }),
      fetchImpl: fetchImpl as typeof fetch,
      selfHeal: { enabled: false },
    });
    const before = gateway.stats().stallsRecorded ?? 0;

    const result = await send({ [OWNER_HEADER]: 'su-local-shed-owner' });

    expect(result.status, result.body).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
    // (1) never the client-retry-burning literal 1s
    const retryAfter = Number(result.headers.get('retry-after'));
    expect(retryAfter, `retry-after=${result.headers.get('retry-after')}`).toBeGreaterThan(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // (2) the same exhausted / pool-recovery markers the upstream-429 path emits
    expect(result.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);
    expect(result.headers.get(POOL_RECOVERY_AT_HEADER)).toBeTruthy();
    // (3) the stall that plugs the session into the stall-waker's resume path
    expect(gateway.stats().stallsRecorded).toBe(before + 1);
  });

  it('every codex local-shed 429 site in gateway.ts goes through codexLocalShedHeaders (no bypass)', () => {
    const src = readFileSync(join(__dirname, 'gateway.ts'), 'utf8');
    expect(src, "a literal 'retry-after': '1' strands codex sessions").not.toMatch(/'retry-after':\s*'1'/);
    const guard = /failure\.code === 'admission-timeout' \|\| failure\.code === 'account-unavailable'\)\s*\{/g;
    const sites: string[] = [];
    for (let m = guard.exec(src); m; m = guard.exec(src)) {
      const block = src.slice(m.index, src.indexOf('return;', m.index));
      if (block.includes('sendJson(res, 429')) sites.push(block);
    }
    // Positive control: both lanes (OAuth + bearer) have a local-shed 429 site today.
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const block of sites) expect(block).toContain('codexLocalShedHeaders(');
  });
});
