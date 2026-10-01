/**
 * Included-first account selection; metered accounts as overflow (anthropic-credits-gateway-2026-09-30
 * P-008, D-003). Drives the REAL gateway (createInferenceGateway over a failover pool) against a mock
 * upstream that answers per credential, and reads which account actually served each request from the
 * `x-papercusp-routed-account` response header — no real spend.
 *
 *   R-24  an included-allowance account is picked over an idle api-key account;
 *   R-25  an api-key account serves once every included-allowance account is parked;
 *   R-26  an account in usage-credits overage ranks behind an included account, yet still serves
 *         (from usage credits) once the included account is walled;
 *   R-27  an account with metered policy `never` is unselectable while in usage credits;
 *   R-28  a request pinned to an api-key account is served by it while included accounts are free.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createInferenceGateway, ACCOUNT_HEADER, ACCOUNT_PIN_HEADER, ROUTED_ACCOUNT_HEADER } from './gateway';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

interface Upstream {
  base: string;
  /** Credentials in the order upstream saw them (Bearer token or x-api-key value). */
  seen: string[];
  close: () => Promise<void>;
}

const resetIn1h = (): string => String(Math.floor(Date.now() / 1000) + 3600);

/** Inside the subscription allowance. */
const INCLUDED = (): Reply => ({
  status: 200,
  headers: { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': resetIn1h() },
});
/** Past the allowance, served from usage credits (status rejected, overage allowed + in use). */
const OVERAGE = (): Reply => ({
  status: 200,
  headers: {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-overage-status': 'allowed',
    'anthropic-ratelimit-unified-overage-in-use': 'true',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': resetIn1h(),
  },
});
/** Allowance exhausted and no overage — the account cannot serve until its reset. */
const WALLED = (): Reply => ({
  status: 429,
  headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': resetIn1h() },
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
});
/** An API-key account: no unified-limiter headers at all. */
const API = (): Reply => ({ status: 200, headers: {} });

function credentialOf(req: http.IncomingMessage): string {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key) return key;
  return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

async function startUpstream(replyFor: (cred: string) => Reply): Promise<Upstream> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const cred = credentialOf(req);
      seen.push(cred);
      const r = replyFor(cred);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(r.body ?? '{"id":"msg_1","type":"message","content":[]}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const oauth = (id: string, tok: string, extra: Partial<ActiveAccount> = {}): ActiveAccount => ({
  accountId: id,
  token: async () => tok,
  invalidateToken: () => {},
  ...extra,
});
const apiKey = (id: string, key: string, extra: Partial<ActiveAccount> = {}): ActiveAccount => ({
  accountId: id,
  token: async () => key,
  invalidateToken: () => {},
  authMode: 'api-key',
  ...extra,
});

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
});

async function boot(accounts: ActiveAccount[], replyFor: (cred: string) => Reply): Promise<number> {
  upstream = await startUpstream(replyFor);
  // Per-account governors live in a PROCESS-GLOBAL registry (governorForBackend), so a wall
  // recorded on 'incA' in one test would otherwise pause 'incA' in the next. Start clean.
  resetGovernorRegistry();
  gw = createInferenceGateway({ pool: createFailoverPool(accounts), upstreamBase: upstream.base, maxQueueWaitMs: 200 });
  return gw.listen(0);
}

async function fire(port: number, headers: Record<string, string> = {}): Promise<{ status: number; routed: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-4-99', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return { status: res.status, routed: res.headers.get(ROUTED_ACCOUNT_HEADER) };
}

/** Fire until a 200 (a walled first attempt may surface as a 429 before the park takes effect). */
async function fireUntilServed(port: number, max = 3): Promise<{ status: number; routed: string | null }> {
  let last = await fire(port);
  for (let i = 1; i < max && last.status !== 200; i++) last = await fire(port);
  return last;
}

describe('metered selection — included allowance first, metered as overflow (P-008)', () => {
  it('R-24: auto selection picks an included-allowance account over an idle api-key account', async () => {
    // The api-key account is FIRST in pool order, so pool order or a tie-break round-robin would pick it.
    const port = await boot([apiKey('keyB', 'sk-keyB'), oauth('incA', 'tokA')], (c) => (c === 'tokA' ? INCLUDED() : API()));
    const routed: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      const r = await fire(port);
      expect(r.status).toBe(200);
      routed.push(r.routed);
    }
    expect(routed).toEqual(['incA', 'incA', 'incA', 'incA']);
    expect(upstream!.seen).not.toContain('sk-keyB');
  });

  it('R-25: auto selection serves from an api-key account when every included-allowance account is parked', async () => {
    const port = await boot([oauth('incA', 'tokA'), apiKey('keyB', 'sk-keyB')], (c) => (c === 'tokA' ? WALLED() : API()));
    const first = await fireUntilServed(port);
    expect(first).toEqual({ status: 200, routed: 'keyB' });
    // incA is parked now: the next request goes straight to the api-key account.
    const next = await fire(port);
    expect(next).toEqual({ status: 200, routed: 'keyB' });
    expect(upstream!.seen).toContain('tokA');
  });

  it('R-26: an account in usage-credits overage ranks behind an included account, and serves once it is walled', async () => {
    let incAWalled = false;
    const port = await boot([oauth('incB', 'tokB'), oauth('incA', 'tokA')], (c) =>
      c === 'tokB' ? OVERAGE() : incAWalled ? WALLED() : INCLUDED(),
    );
    // Observe incB serving from usage credits (a pinned request lands on it).
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    // Ranked behind the included account: unpinned traffic goes to incA.
    for (let i = 0; i < 3; i++) expect(await fire(port)).toEqual({ status: 200, routed: 'incA' });
    // Overflow: with incA walled, incB keeps serving from usage credits instead of being parked.
    incAWalled = true;
    expect(await fireUntilServed(port)).toEqual({ status: 200, routed: 'incB' });
  });

  it('R-27: an account with metered policy never is unselectable while its billing state is usage-credits', async () => {
    let incAWalled = false;
    const port = await boot([oauth('incA', 'tokA'), oauth('incB', 'tokB', { meteredPolicy: 'never' })], (c) =>
      c === 'tokB' ? OVERAGE() : incAWalled ? WALLED() : INCLUDED(),
    );
    // Observe incB's billing state: its response says usage credits are serving.
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    const incBHits = upstream!.seen.filter((c) => c === 'tokB').length;
    // Every other account walled: incB is still NOT selected — the request is refused instead.
    incAWalled = true;
    for (let i = 0; i < 3; i++) {
      const r = await fire(port);
      expect(r.routed).not.toBe('incB');
      expect(r.status).not.toBe(200);
    }
    expect(upstream!.seen.filter((c) => c === 'tokB').length).toBe(incBHits);
    // Even a HARD pin (which bypasses the pool's parking) is refused before admission, not billed.
    const hard = await fire(port, { [ACCOUNT_HEADER]: 'incB', [ACCOUNT_PIN_HEADER]: 'hard' });
    expect(hard.status).toBe(429);
    expect(upstream!.seen.filter((c) => c === 'tokB').length).toBe(incBHits);
  });

  it('R-28: a request pinned to an api-key account is served by that account while included accounts are free', async () => {
    const port = await boot([oauth('incA', 'tokA'), apiKey('keyB', 'sk-keyB')], (c) => (c === 'tokA' ? INCLUDED() : API()));
    for (let i = 0; i < 3; i++) expect(await fire(port, { [ACCOUNT_HEADER]: 'keyB' })).toEqual({ status: 200, routed: 'keyB' });
    expect(upstream!.seen).toEqual(['sk-keyB', 'sk-keyB', 'sk-keyB']);
    // The included account is free: an unpinned request still prefers it.
    expect(await fire(port)).toEqual({ status: 200, routed: 'incA' });
  });
});
