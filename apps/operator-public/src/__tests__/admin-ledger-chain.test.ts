/**
 * /admin/ledger-chain/* (agent-economy-flywheel P-040): operator verify,
 * export and witness routes over the hash-chained D1 ledgers, against REAL
 * SQLite with the shipped migrations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseChainExport, verifyChainExport } from '@papercusp/hash-chain';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';
import { witnessLedgerStream } from '../ledger-chain-store.ts';
import { makeSqliteDb } from './sqlite-d1';

type Raw = ReturnType<typeof makeSqliteDb>['raw'];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    COUNTERS: {} as unknown as KVNamespace,
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    IP_HASH_PEPPER: 'test-pepper',
    ENVIRONMENT: 'test',
    CUPBOARD_HOST: 'cupboard.test',
    CUPBOARD_OPERATOR_GITHUB_IDS: '7',
    RATE_PER_USER_PUBLISH_HOURLY: '5',
    RATE_PER_USER_REPORT_HOURLY: '10',
    RATE_PER_IP_LIST_PER_MINUTE: '60',
    INDEXER_BATCH_SIZE: '100',
  } as Env;
}

function stubUser(user: { id: number; login: string } | null): void {
  globalThis.fetch = (async (url: string | URL) => {
    if (url.toString().endsWith('/user')) {
      if (!user) return new Response('', { status: 401 });
      return new Response(JSON.stringify(user), { status: 200 });
    }
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

const AUTH = { headers: { authorization: 'Bearer gho_test' } };

function insertLedgerEvent(raw: Raw, id: string, occurredAtMs: number, amountMinor = 1000): void {
  raw
    .prepare(
      'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'order.paid', occurredAtMs, 'stripe', `evt_${id}`, JSON.stringify({ amountMinor, currency: 'USD' }));
}

async function seeded() {
  const { db, raw } = makeSqliteDb();
  for (let i = 1; i <= 3; i += 1) insertLedgerEvent(raw, `le${i}`, 1000 + i);
  await witnessLedgerStream(db, 'commerce.ledger', 5000);
  return { db, raw, env: makeEnv(db), api: buildApi() };
}

describe('/admin/ledger-chain', () => {
  it('requires an operator', async () => {
    const { env, api } = await seeded();
    stubUser(null);
    expect((await api.request('/admin/ledger-chain', AUTH, env)).status).toBe(401);
    stubUser({ id: 8, login: 'not-op' });
    expect((await api.request('/admin/ledger-chain/commerce.ledger/verify', AUTH, env)).status).toBe(403);
    expect((await api.request('/admin/ledger-chain/commerce.ledger/export', AUTH, env)).status).toBe(403);
  });

  it('verifies every stream and one stream', async () => {
    const { env, api } = await seeded();
    stubUser({ id: 7, login: 'op' });
    const all = await api.request('/admin/ledger-chain', AUTH, env);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { ok: boolean; streams: Array<{ streamId: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.streams.map((s) => s.streamId)).toContain('commerce.ledger');

    const one = await api.request('/admin/ledger-chain/commerce.ledger/verify', AUTH, env);
    expect(await one.json()).toMatchObject({ ok: true, verdict: { ok: true, length: 3 } });
  });

  it('reports the first break after a ledger row is edited', async () => {
    const { env, api, raw } = await seeded();
    stubUser({ id: 7, login: 'op' });
    raw.prepare("UPDATE commerce_ledger_events SET payload_json = ? WHERE ledger_event_id = 'le2'").run(
      JSON.stringify({ amountMinor: 1, currency: 'USD' }),
    );
    const res = await api.request('/admin/ledger-chain/commerce.ledger/verify', AUTH, env);
    expect(await res.json()).toMatchObject({ ok: false, verdict: { ok: false, firstBreak: { seq: 1 } } });
  });

  it('checks a saved head and rejects a malformed one', async () => {
    const { env, api } = await seeded();
    stubUser({ id: 7, login: 'op' });
    const exported = parseChainExport(await (await api.request('/admin/ledger-chain/commerce.ledger/export', AUTH, env)).text());
    const head = exported.header.head!;
    const pinned = await api.request(
      `/admin/ledger-chain/commerce.ledger/verify?headSeq=${head.seq}&headHash=${head.entryHash}`,
      AUTH,
      env,
    );
    expect(await pinned.json()).toMatchObject({ ok: true });
    const wrong = await api.request(
      `/admin/ledger-chain/commerce.ledger/verify?headSeq=${head.seq + 5}&headHash=${head.entryHash}`,
      AUTH,
      env,
    );
    expect(await wrong.json()).toMatchObject({ ok: false });
    const bad = await api.request('/admin/ledger-chain/commerce.ledger/verify?headSeq=1&headHash=nothex', AUTH, env);
    expect(bad.status).toBe(400);
  });

  it('exports the stable JSONL format that verifies offline', async () => {
    const { env, api } = await seeded();
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/ledger-chain/commerce.ledger/export', AUTH, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const verdict = verifyChainExport(await res.text());
    expect(verdict.ok).toBe(true);
  });

  it('404s an unknown stream', async () => {
    const { env, api } = await seeded();
    stubUser({ id: 7, login: 'op' });
    expect((await api.request('/admin/ledger-chain/nope/verify', AUTH, env)).status).toBe(404);
    expect((await api.request('/admin/ledger-chain/nope/export', AUTH, env)).status).toBe(404);
  });

  it('witness chains rows a failed after-append pass left behind, with an audit row', async () => {
    const { env, api, raw } = await seeded();
    stubUser({ id: 7, login: 'op' });
    insertLedgerEvent(raw, 'le4', 2000); // inserted with no witness pass
    const before = (await (await api.request('/admin/ledger-chain/commerce.ledger/verify', AUTH, env)).json()) as {
      ok: boolean;
      unchainedCount: number;
    };
    expect(before).toMatchObject({ ok: false, unchainedCount: 1 });
    const res = await api.request('/admin/ledger-chain/commerce.ledger/witness', { ...AUTH, method: 'POST' }, env);
    expect(await res.json()).toMatchObject({ ok: true, appended: 1, head: { seq: 3 } });
    const after = await api.request('/admin/ledger-chain/commerce.ledger/verify', AUTH, env);
    expect(await after.json()).toMatchObject({ ok: true, unchainedCount: 0 });
    const audits = raw.prepare("SELECT kind FROM audit WHERE kind = 'ledger_chain_witnessed'").all();
    expect(audits).toHaveLength(1);
  });
});
