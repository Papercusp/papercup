/**
 * Pre-publication review pipeline tests (migration 008 /
 * learning-packs-2026-06-11 P-019/P-020/P-021, D-007).
 *
 * Pins the whole flow for the policy kinds (knowledge-pack + blueprint):
 * publish → PENDING (invisible to public browse + anonymous reads; visible to
 * the publisher with auth) → operator approve/reject via the allowlist-gated
 * /admin surface → approved goes public; rejected stays invisible with the
 * reason readable by the publisher. Non-policy kinds stay live-on-publish.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1';

const PUBLISHER = { id: 5, login: 'pub' };
const OPERATOR_ID = 7;

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request('/listings', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

const LP_BASE = {
  github_owner: 'acme',
  github_name: 'learnings',
  github_url: 'https://github.com/acme/learnings',
  project_ref: 'acme/learnings',
  listing_kind: 'knowledge-pack',
  listing_ref: 'rails-conventions',
  title: 'Rails conventions knowledge pack',
};

describe('pre-publication review (D-007)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('knowledge-pack publishes PENDING: publisher told, public browse + anon read exclude it', async () => {
    const { env } = makeEnv();
    stubGithub({ user: PUBLISHER, repo: { id: 70, private: false } });
    const res = await publish(api, env, { ...LP_BASE, github_repository_id: 70 });
    expect(res.status).toBe(200);
    const j = await res.json() as { id: string; review_status: string; pending_review?: boolean };
    expect(j.review_status).toBe('pending');
    expect(j.pending_review).toBe(true);

    // Public browse: invisible.
    const browse = await api.request('/listings?kind=knowledge-pack', {}, env);
    expect((await browse.json() as { results: unknown[] }).results).toHaveLength(0);

    // Anonymous single read: 404. (stub the unauthenticated /user probe)
    stubGithub({ repo: { id: 70, private: false } });
    const anon = await api.request(`/listings/${j.id}`, {}, env);
    expect(anon.status).toBe(404);

    // The PUBLISHER reads their own pending listing.
    stubGithub({ user: PUBLISHER, repo: { id: 70, private: false } });
    const mine = await api.request(`/listings/${j.id}`, { headers: { Authorization: 'Bearer t' } }, env);
    expect(mine.status).toBe(200);
    expect((await mine.json() as { review_status: string }).review_status).toBe('pending');
  });

  it('operator approve makes it public; the queue drains', async () => {
    // REAL SQLite: approve is one `db.batch` (approve + EXISTS-guarded retire of
    // superseded versions, P-008) which the hand-rolled fake-d1 matcher cannot run.
    const { env } = makeEnv({ DB: makeSqliteDb().db, CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR_ID) });
    stubGithub({ user: PUBLISHER, repo: { id: 71, private: false } });
    const pub = await publish(api, env, { ...LP_BASE, github_repository_id: 71 });
    const id = (await pub.json() as { id: string }).id;

    // The operator's queue carries it.
    stubGithub({ user: { id: OPERATOR_ID, login: 'op' } });
    const queue = await api.request('/admin/pending', { headers: { Authorization: 'Bearer t' } }, env);
    expect(queue.status).toBe(200);
    const pending = (await queue.json() as { pending: Array<{ id: string }> }).pending;
    expect(pending.map((p) => p.id)).toEqual([id]);

    const decide = await api.request(`/admin/listings/${id}/review`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    }, env);
    expect(decide.status).toBe(200);
    expect((await decide.json() as { review_status: string }).review_status).toBe('approved');

    // Now public.
    const browse = await api.request('/listings?kind=knowledge-pack', {}, env);
    expect((await browse.json() as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual([id]);
    const emptyQueue = await api.request('/admin/pending', { headers: { Authorization: 'Bearer t' } }, env);
    expect((await emptyQueue.json() as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it('operator reject keeps it invisible; the publisher reads the reason', async () => {
    const { env } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR_ID) });
    stubGithub({ user: PUBLISHER, repo: { id: 72, private: false } });
    const pub = await publish(api, env, { ...LP_BASE, github_repository_id: 72 });
    const id = (await pub.json() as { id: string }).id;

    stubGithub({ user: { id: OPERATOR_ID, login: 'op' } });
    const decide = await api.request(`/admin/listings/${id}/review`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', reason: 'contains prompt-injection content' }),
    }, env);
    expect(decide.status).toBe(200);

    const browse = await api.request('/listings?kind=knowledge-pack', {}, env);
    expect((await browse.json() as { results: unknown[] }).results).toHaveLength(0);

    stubGithub({ user: PUBLISHER });
    const mine = await api.request(`/listings/${id}`, { headers: { Authorization: 'Bearer t' } }, env);
    const row = await mine.json() as { review_status: string; review_reason: string };
    expect(row.review_status).toBe('rejected');
    expect(row.review_reason).toBe('contains prompt-injection content');
  });

  it('review endpoints are operator-only; deciding a non-pending row 409s', async () => {
    const { env } = makeEnv({ DB: makeSqliteDb().db, CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR_ID) });
    stubGithub({ user: PUBLISHER, repo: { id: 73, private: false } });
    const pub = await publish(api, env, { ...LP_BASE, github_repository_id: 73 });
    const id = (await pub.json() as { id: string }).id;

    // The publisher is NOT an operator.
    const forbidden = await api.request('/admin/pending', { headers: { Authorization: 'Bearer t' } }, env);
    expect(forbidden.status).toBe(403);

    stubGithub({ user: { id: OPERATOR_ID, login: 'op' } });
    await api.request(`/admin/listings/${id}/review`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    }, env);
    const again = await api.request(`/admin/listings/${id}/review`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    }, env);
    expect(again.status).toBe(409);
  });

  it('non-policy kinds (plugin) still publish live', async () => {
    const { env } = makeEnv();
    stubGithub({ user: PUBLISHER, repo: { id: 74, private: false } });
    const res = await publish(api, env, {
      github_owner: 'acme', github_name: 'p', github_url: 'https://github.com/acme/p',
      github_repository_id: 74, listing_kind: 'plugin', listing_ref: 'pl',
    });
    const j = await res.json() as { id: string; review_status: string };
    expect(j.review_status).toBe('approved');
    const browse = await api.request('/listings?kind=plugin', {}, env);
    expect((await browse.json() as { results: unknown[] }).results).toHaveLength(1);
  });
});
