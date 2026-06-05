/**
 * Cupboard /harnesses back-compat route tests.
 *
 * /harnesses is the kind='harness' view of the generalized /listings surface
 * (migration 004). These tests pin the existing harness publish/list/get/
 * unlist/claim/binding/report behavior so the generalization didn't regress it.
 * Kind-aware behavior (blueprint/snapshot/plugin) lives in listings.test.ts.
 *
 * D1 + KV + GitHub fetch are faked by ./fake-d1.ts (the store interprets the
 * exact SQL db.ts emits — no real network/D1).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, makeListingRow, stubGithub, type FakeStore } from './fake-d1.ts';

describe('Cupboard server (/harnesses back-compat)', () => {
  let api: ReturnType<typeof buildApi>;

  beforeEach(() => {
    api = buildApi();
  });

  it('GET /healthz returns ok', async () => {
    const { env } = makeEnv();
    const res = await api.request('/healthz', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET / returns service identifier', async () => {
    const { env } = makeEnv();
    const res = await api.request('/', {}, env);
    expect(await res.json()).toEqual({ service: 'papercusp-cupboard', status: 'ok' });
  });

  it('GET /harnesses returns empty list on fresh db', async () => {
    const { env } = makeEnv();
    const res = await api.request('/harnesses', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[]; next_cursor: unknown };
    expect(body.results).toEqual([]);
    expect(body.next_cursor).toBe(null);
  });

  it('POST /harnesses requires Authorization', async () => {
    const { env } = makeEnv();
    const res = await api.request('/harnesses', { method: 'POST' }, env);
    expect(res.status).toBe(401);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe('missing_bearer');
  });

  it('POST /harnesses rejects bad GitHub token (401 from /user)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { error: 401 } });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad' },
    }, env);
    expect(res.status).toBe(401);
  });

  it('POST /harnesses rejects private GitHub repo', async () => {
    const { env } = makeEnv();
    stubGithub({
      user: { id: 1, login: 'alice' },
      repo: { id: 100, private: true },
    });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: 100,
        github_owner: 'alice',
        github_name: 'private-repo',
        github_url: 'https://github.com/alice/private-repo',
        topic_hex: 'a'.repeat(64),
      }),
    }, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('private_repo_rejected');
  });

  it('POST /harnesses rejects when repository_id does not match GitHub response', async () => {
    const { env } = makeEnv();
    stubGithub({
      user: { id: 1, login: 'alice' },
      repo: { id: 999, private: false },        // GH says 999
    });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: 100,                // we claim 100
        github_owner: 'alice', github_name: 'r', github_url: 'https://github.com/alice/r',
        topic_hex: 'a'.repeat(64),
      }),
    }, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; expected?: number };
    expect(body.error).toBe('repository_id_mismatch');
    expect(body.expected).toBe(999);
  });

  it('POST /harnesses rejects malformed topic_hex', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' } });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: 100,
        github_owner: 'alice', github_name: 'r', github_url: 'https://github.com/alice/r',
        topic_hex: 'too-short',
      }),
    }, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { field: string };
    expect(body.field).toBe('topic_hex');
  });

  it('POST /harnesses publishes happy path + dedup re-call returns existing', async () => {
    const { env, store } = makeEnv();
    stubGithub({
      user: { id: 1, login: 'alice' },
      repo: { id: 42, private: false },
    });
    const body = {
      github_repository_id: 42,
      github_owner: 'alice', github_name: 'cool',
      github_url: 'https://github.com/alice/cool',
      title: 'Cool harness',
      description: 'A cool harness',
      topic_hex: 'b'.repeat(64),
    };
    const res1 = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env);
    expect(res1.status).toBe(200);
    const j1 = await res1.json() as { ok: boolean; id: string; harness: { title: string; listing_kind: string } };
    expect(j1.ok).toBe(true);
    expect(j1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(j1.harness.title).toBe('Cool harness');
    expect(j1.harness.listing_kind).toBe('harness');
    expect(store.tables.harnesses).toHaveLength(1);

    // Second publish with same repo_id → dedup.
    const res2 = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env);
    expect(res2.status).toBe(200);
    const j2 = await res2.json() as { dedup: boolean; id: string };
    expect(j2.dedup).toBe(true);
    expect(j2.id).toBe(j1.id);
    expect(store.tables.harnesses).toHaveLength(1);          // still just one
  });

  it('POST /harnesses enforces per-user hourly publish cap', async () => {
    const { env } = makeEnv({ RATE_PER_USER_PUBLISH_HOURLY: '2' });
    const post = (repoId: number) => api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: repoId,
        github_owner: 'alice', github_name: `r${repoId}`,
        github_url: `https://github.com/alice/r${repoId}`,
        topic_hex: 'c'.repeat(64),
      }),
    }, env);
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 1, private: false } });
    const r1 = await post(1); expect(r1.status).toBe(200);
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 2, private: false } });
    const r2 = await post(2); expect(r2.status).toBe(200);
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 3, private: false } });
    const r3 = await post(3);
    expect(r3.status).toBe(429);
  });

  it('DELETE /harnesses/:id rejects non-publisher non-claimant', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h1', publisher_github_user_id: 1 }));
    stubGithub({ user: { id: 999, login: 'mallory' } });
    const res = await api.request('/harnesses/h1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(403);
  });

  it('DELETE /harnesses/:id by publisher unlists', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h2', publisher_github_user_id: 7 }));
    stubGithub({ user: { id: 7, login: 'alice' } });
    const res = await api.request('/harnesses/h2', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(200);
    expect(store.tables.harnesses[0].unlisted_at).not.toBeNull();
  });

  it('POST /harnesses/:id/claim requires maintain perm', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h3' }));
    stubGithub({
      user: { id: 7, login: 'bob' },
      repo: { id: 1, private: false, permissions: { maintain: false, admin: false, push: true } },
    });
    const res = await api.request('/harnesses/h3/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(403);
  });

  it('POST /harnesses/:id/claim succeeds for maintainer', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h4' }));
    stubGithub({
      user: { id: 7, login: 'bob' },
      repo: { id: 1, private: false, permissions: { maintain: true, admin: false } },
    });
    const res = await api.request('/harnesses/h4/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(200);
    expect(store.tables.harnesses[0].claim_status).toBe('claimed');
    expect(store.tables.harnesses[0].claimant_github_user_id).toBe(7);
  });

  it('GET /binding/:repoId returns exists=false when no binding', async () => {
    const { env } = makeEnv();
    const res = await api.request('/binding/42', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false });
  });

  it('GET /binding/:repoId returns the listing when bound', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h5', github_repository_id: 88, title: 'BoundOne' }));
    const res = await api.request('/binding/88', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean; harness: { title: string } };
    expect(body.exists).toBe(true);
    expect(body.harness.title).toBe('BoundOne');
  });

  it('POST /reports requires auth + harness + reason', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h6' }));
    stubGithub({ user: { id: 9, login: 'reporter' } });
    const r1 = await api.request('/reports', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness_id: 'h6', reason: 'spam content' }),
    }, env);
    expect(r1.status).toBe(200);
    expect(store.tables.reports).toHaveLength(1);
    expect(store.tables.reports[0].reporter_github_user_id).toBe(9);
    expect(store.tables.reports[0].status).toBe('pending');
  });

  it('POST /reports rejects too-long reason', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push(makeListingRow({ id: 'h7' }));
    stubGithub({ user: { id: 9, login: 'reporter' } });
    const res = await api.request('/reports', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness_id: 'h7', reason: 'x'.repeat(1001) }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('Cupboard channel-2 attestation + ban-list (item 1)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  const PUBKEY = 'ZmFrZS1kZXZpY2UtcHVia2V5LWJhc2U2NA==';

  function seedHarness(store: FakeStore, over: Record<string, unknown> = {}): void {
    store.tables.harnesses.push(makeListingRow({ publisher_permission: 'write', ...over }));
  }

  it('publish stores attestation gist id + device pubkey', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 100, private: false } });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: 100, github_owner: 'alice', github_name: 'r',
        github_url: 'https://github.com/alice/r', topic_hex: 'a'.repeat(64),
        attestation_gist_id: 'abc123', publisher_device_pubkey: PUBKEY,
      }),
    }, env);
    expect(res.status).toBe(200);
    const row = store.tables.harnesses[0];
    expect(row.publisher_device_pubkey).toBe(PUBKEY);
    expect(row.publisher_attestation_gist_id).toBe('abc123');
  });

  it('publish rejects an attestation pubkey without its gist (both-or-neither)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 100, private: false } });
    const res = await api.request('/harnesses', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_repository_id: 100, github_owner: 'alice', github_name: 'r',
        github_url: 'https://github.com/alice/r', topic_hex: 'a'.repeat(64),
        publisher_device_pubkey: PUBKEY,
      }),
    }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('both_or_neither');
  });

  it('banned publisher pubkey is filtered from GET /harnesses and 404s on GET /:id', async () => {
    const { env, store } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '1' });
    seedHarness(store, { id: 'banned-one', publisher_device_pubkey: PUBKEY });
    seedHarness(store, { id: 'clean-one', github_repository_id: 2, publisher_device_pubkey: null });

    // Operator (id 1) bans the pubkey.
    stubGithub({ user: { id: 1, login: 'op' } });
    const ban = await api.request('/admin/banned-pubkeys', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY, reason: 'abuse' }),
    }, env);
    expect(ban.status).toBe(200);
    expect(store.tables.banned_publisher_pubkeys).toHaveLength(1);

    const list = await api.request('/harnesses', {}, env);
    const body = (await list.json()) as { results: Array<{ id: string }> };
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain('clean-one');
    expect(ids).not.toContain('banned-one');

    const get = await api.request('/harnesses/banned-one', {}, env);
    expect(get.status).toBe(404);
  });

  it('ban endpoint requires an operator (403 for non-operator)', async () => {
    const { env } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '999' });
    stubGithub({ user: { id: 1, login: 'notop' } });
    const res = await api.request('/admin/banned-pubkeys', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY, reason: 'x' }),
    }, env);
    expect(res.status).toBe(403);
  });

  it('unban lifts the filter', async () => {
    const { env, store } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '1' });
    seedHarness(store, { id: 'banned-one', publisher_device_pubkey: PUBKEY });
    stubGithub({ user: { id: 1, login: 'op' } });
    await api.request('/admin/banned-pubkeys', {
      method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY, reason: 'abuse' }),
    }, env);
    await api.request('/admin/banned-pubkeys/remove', {
      method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY }),
    }, env);
    expect(store.tables.banned_publisher_pubkeys).toHaveLength(0);
    const list = await api.request('/harnesses', {}, env);
    const body = (await list.json()) as { results: Array<{ id: string }> };
    expect(body.results.map((r) => r.id)).toContain('banned-one');
  });
});
