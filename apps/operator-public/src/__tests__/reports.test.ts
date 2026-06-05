/**
 * POST /reports — file an abuse report against a Cupboard listing.
 *
 * GitHub-bearer authed, per-user hourly rate-limited, validates the body,
 * and lands a pending report row. GitHub /user is stubbed via global fetch;
 * D1 + KV are tiny in-memory fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsRoute } from '../routes/reports.ts';
import type { Env } from '../env.ts';

class FakeKV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
}

function makeEnv(harnesses: Array<{ id: string }>, over: Partial<Env> = {}) {
  const reports: unknown[][] = [];
  const audits: unknown[][] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...b: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (/SELECT \* FROM harnesses WHERE id/i.test(sql)) {
                const [id] = b as [string];
                return (harnesses.find((h) => h.id === id) ?? null) as T | null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO reports/i.test(sql)) reports.push(b);
              else if (/INSERT INTO audit/i.test(sql)) audits.push(b);
              return { success: true };
            },
          };
        },
      };
    },
  };
  const env = {
    DB,
    COUNTERS: new FakeKV(),
    IP_HASH_PEPPER: 'pepper',
    RATE_PER_USER_REPORT_HOURLY: '2',
    ...over,
  } as unknown as Env;
  return { env, reports, audits };
}

function stubGhUser(user: { id: number; login: string } | { error: number }) {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (url.toString().endsWith('/user')) {
      if ('error' in user) return new Response('', { status: user.error });
      return new Response(JSON.stringify(user), { status: 200 });
    }
    return new Response('not stubbed', { status: 500 });
  });
}

const post = (env: Env, body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok' }) =>
  reportsRoute().request('/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env);

beforeEach(() => stubGhUser({ id: 7, login: 'alice' }));
afterEach(() => vi.unstubAllGlobals());

describe('POST /reports', () => {
  it('401 when no bearer token is supplied', async () => {
    const { env } = makeEnv([]);
    const res = await post(env, { harness_id: 'h1', reason: 'spam' }, {});
    expect(res.status).toBe(401);
    expect((await res.json() as { reason: string }).reason).toBe('missing_bearer');
  });

  it('401 when GitHub rejects the token', async () => {
    stubGhUser({ error: 401 });
    const { env } = makeEnv([{ id: 'h1' }]);
    const res = await post(env, { harness_id: 'h1', reason: 'spam' });
    expect(res.status).toBe(401);
  });

  it('400 on invalid JSON / missing harness_id / empty or oversized reason', async () => {
    const { env } = makeEnv([{ id: 'h1' }]);
    expect((await post(env, 'not-json')).status).toBe(400);
    expect((await post(env, { reason: 'x' })).status).toBe(400);
    expect((await post(env, { harness_id: 'h1', reason: '  ' })).status).toBe(400);
    expect((await post(env, { harness_id: 'h1', reason: 'x'.repeat(1001) })).status).toBe(400);
  });

  it('404 when the reported harness does not exist', async () => {
    const { env } = makeEnv([]); // no harnesses
    const res = await post(env, { harness_id: 'ghost', reason: 'spam' });
    expect(res.status).toBe(404);
  });

  it('lands a pending report + audit row on success', async () => {
    const { env, reports, audits } = makeEnv([{ id: 'h1' }]);
    const res = await post(env, { harness_id: 'h1', reason: '  abusive  ' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(reports).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('429 once the per-user hourly report cap is exceeded', async () => {
    const { env } = makeEnv([{ id: 'h1' }]); // cap 2
    expect((await post(env, { harness_id: 'h1', reason: 'a' })).status).toBe(200);
    expect((await post(env, { harness_id: 'h1', reason: 'b' })).status).toBe(200);
    expect((await post(env, { harness_id: 'h1', reason: 'c' })).status).toBe(429);
  });
});
