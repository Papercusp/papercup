/**
 * AUTO-ROUTE SESSION AFFINITY (WI-2140943, 2026-09-02).
 *
 * Anthropic's prompt cache is scoped PER ACCOUNT. Before this fix an UNPINNED (`--account=auto`)
 * request was routed by per-request round-robin, so a session's consecutive turns landed on
 * different accounts and RE-CREATED the whole prefix cache (1.25× input) instead of READING it
 * (0.1×) — measured 2026-09-02: ~88% of input spend was cache CREATE on a 7-account pool.
 *
 * These tests pin the routing contract end-to-end through a real gateway over a 3-account pool:
 *   • an identifiable unpinned caller (x-papercusp-owner) sticks to the account that served it;
 *   • a headerless Claude-CLI caller sticks via its per-session `metadata.user_id`;
 *   • an unidentifiable caller keeps today's per-request round-robin (byte-identical behavior);
 *   • the /stats `cache.affinity` counters account for every unpinned request.
 * Plus the pure key derivation, including the per-user-only guard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  createInferenceGateway,
  autoAffinityKey,
  ACCOUNT_HEADER,
  OWNER_HEADER,
  ROUTED_ACCOUNT_HEADER,
} from './gateway';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';

interface Upstream {
  base: string;
  seen: string[]; // authorization header of every upstream call, in order
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      seen.push(String(req.headers['authorization'] ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `tok-${id}`, invalidateToken: () => {} });

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
});

/** Boot the gateway over a 3-account failover pool (so round-robin visibly rotates) → its port. */
async function bootGateway(): Promise<number> {
  upstream = await startUpstream();
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B'), acct('C')]),
    upstreamBase: upstream.base,
    maxQueueWaitMs: 200,
  });
  return gw.listen(0);
}

async function turn(
  port: number,
  opts: { owner?: string; metaUserId?: string; account?: string } = {},
): Promise<string | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.owner) headers[OWNER_HEADER] = opts.owner;
  if (opts.account) headers[ACCOUNT_HEADER] = opts.account;
  const body: Record<string, unknown> = {
    model: 'claude-opus-4-99',
    max_tokens: 4,
    messages: [{ role: 'user', content: 'hi' }],
  };
  if (opts.metaUserId) body.metadata = { user_id: opts.metaUserId };
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
  await res.arrayBuffer();
  return res.headers.get(ROUTED_ACCOUNT_HEADER);
}

async function stats(port: number): Promise<{ cache: { affinity: { hits: number; cold: number; nokey: number; yields: number } } }> {
  const res = await fetch(`http://127.0.0.1:${port}/stats`);
  return (await res.json()) as never;
}

describe('autoAffinityKey — pure key derivation', () => {
  it('prefers the coord owner id when present', () => {
    expect(autoAffinityKey('su-abc', 'user_x_session_y')).toBe('su-abc');
  });
  it('falls back to a Claude-CLI metadata.user_id that carries a per-SESSION component', () => {
    expect(autoAffinityKey(undefined, 'user_1234_account_abcd_session_9f8e')).toBe('meta:user_1234_account_abcd_session_9f8e');
  });
  it('REFUSES a per-user-only id (would collapse every headerless session onto one account)', () => {
    expect(autoAffinityKey(undefined, 'user_1234_account_abcd')).toBeUndefined();
  });
  it('refuses non-string / empty / oversized ids', () => {
    expect(autoAffinityKey(undefined, undefined)).toBeUndefined();
    expect(autoAffinityKey(undefined, 42)).toBeUndefined();
    expect(autoAffinityKey(undefined, '')).toBeUndefined();
    expect(autoAffinityKey(undefined, 'session_' + 'x'.repeat(600))).toBeUndefined();
  });
});

describe('auto-route session affinity — gateway routing over a 3-account pool', () => {
  it('an UNIDENTIFIABLE unpinned caller keeps per-request round-robin (control: the pre-fix behavior)', async () => {
    const port = await bootGateway();
    const routed: string[] = [];
    for (let i = 0; i < 3; i++) routed.push((await turn(port)) ?? '?');
    // Round-robin over 3 idle accounts visits ≥2 distinct accounts in 3 turns — this is exactly the
    // cache-thrash the fix removes for identifiable callers, kept here as the calibration control.
    expect(new Set(routed).size).toBeGreaterThanOrEqual(2);
    const s = await stats(port);
    expect(s.cache.affinity.nokey).toBe(3);
    expect(s.cache.affinity.hits).toBe(0);
  });

  it('an IDENTIFIED unpinned caller (x-papercusp-owner) sticks to the account that served its first turn', async () => {
    const port = await bootGateway();
    const routed: string[] = [];
    for (let i = 0; i < 6; i++) routed.push((await turn(port, { owner: 'su-session-1' })) ?? '?');
    expect(routed[0]).toMatch(/^[ABC]$/);
    expect(new Set(routed).size).toBe(1);
    expect(upstream!.seen.every((a) => a === upstream!.seen[0])).toBe(true);
    const s = await stats(port);
    expect(s.cache.affinity.cold).toBe(1); // first turn: no prior route
    expect(s.cache.affinity.hits).toBe(5); // every later turn read the warm account
    expect(s.cache.affinity.nokey).toBe(0);
  });

  it('two DIFFERENT identified callers each keep their own account (affinity is per caller, not global)', async () => {
    const port = await bootGateway();
    const a1 = await turn(port, { owner: 'su-one' });
    const b1 = await turn(port, { owner: 'su-two' });
    for (let i = 0; i < 3; i++) {
      expect(await turn(port, { owner: 'su-one' })).toBe(a1);
      expect(await turn(port, { owner: 'su-two' })).toBe(b1);
    }
  });

  it('a headerless Claude-CLI caller sticks via its per-session metadata.user_id', async () => {
    const port = await bootGateway();
    const meta = 'user_deadbeef_account_0000_session_1111';
    const routed: string[] = [];
    for (let i = 0; i < 5; i++) routed.push((await turn(port, { metaUserId: meta })) ?? '?');
    expect(new Set(routed).size).toBe(1);
    const s = await stats(port);
    expect(s.cache.affinity.cold).toBe(1);
    expect(s.cache.affinity.hits).toBe(4);
  });

  it('an explicit account pin is untouched by affinity (pin wins; counted as neither hit nor cold)', async () => {
    const port = await bootGateway();
    // Warm an owner onto whichever account round-robin hands out first…
    const warm = await turn(port, { owner: 'su-pinner' });
    // …then pin the SAME owner elsewhere: the pin must win over the remembered account.
    const other = warm === 'A' ? 'B' : 'A';
    expect(await turn(port, { owner: 'su-pinner', account: other })).toBe(other);
    const s = await stats(port);
    expect(s.cache.affinity.hits + s.cache.affinity.cold).toBe(1); // only the unpinned warm-up turn counted
  });
});
