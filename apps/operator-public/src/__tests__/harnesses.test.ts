/**
 * Cupboard server route tests.
 *
 * D1 is mocked with a tiny in-memory implementation that satisfies
 * D1PreparedStatement's prepare/bind/run/first/all surface. KV is
 * mocked the same way. GitHub `/user` and repo fetches are stubbed
 * via a global fetch override.
 *
 * These tests exercise the Hono app end-to-end through `app.request()`
 * — no actual network, no actual D1, but the request/response shape
 * and the SQL bind-order are exercised.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';

// ---------- D1 mock ----------

interface Row {
  [key: string]: unknown;
}

class FakeStmt {
  constructor(
    private sql: string,
    private store: FakeStore,
    private binds: unknown[] = [],
  ) {}
  bind(...values: unknown[]): FakeStmt {
    return new FakeStmt(this.sql, this.store, values);
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const changes = this.store.execute(this.sql, this.binds);
    return { success: true, meta: { changes } };
  }
  async first<T = Row>(): Promise<T | null> {
    const rows = this.store.query(this.sql, this.binds);
    return (rows[0] as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const rows = this.store.query(this.sql, this.binds);
    return { results: rows as T[], success: true };
  }
}

class FakeStore {
  // Each table: list of rows.
  tables: Record<string, Row[]> = {
    harnesses: [],
    reports: [],
    publish_rate_limit: [],
    indexer_runs: [],
    audit: [],
  };

  execute(sql: string, binds: unknown[]): number {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('INSERT INTO HARNESSES')) {
      // Bind order matches insertHarness() in db.ts.
      const [
        id, gh_repo_id, gh_owner, gh_name, gh_url, title, description, topic_hex,
        pub_user_id, pub_login, created_at, updated_at,
      ] = binds;
      this.tables.harnesses.push({
        id, github_repository_id: gh_repo_id, github_owner: gh_owner,
        github_name: gh_name, github_url: gh_url, title, description,
        topic_hex, publisher_github_user_id: pub_user_id,
        publisher_github_login: pub_login, claim_status: 'unclaimed',
        claimant_github_user_id: null, claimant_github_login: null,
        superseded_by: null, stars: 0, contributor_count: 0,
        last_activity_at: null, languages: null, stats_refreshed_at: null,
        created_at, updated_at, unlisted_at: null, unlisted_reason: null,
      });
      return 1;
    }
    if (upper.startsWith('UPDATE HARNESSES SET UNLISTED_AT')) {
      const [unlisted_at, unlisted_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.unlisted_at = unlisted_at;
        row.unlisted_reason = unlisted_reason;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith("UPDATE HARNESSES\n         SET CLAIM_STATUS = 'CLAIMED'") || upper.includes("CLAIM_STATUS = 'CLAIMED'")) {
      const [claimant_user_id, claimant_login, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.claim_status = 'claimed';
        row.claimant_github_user_id = claimant_user_id;
        row.claimant_github_login = claimant_login;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('INSERT INTO REPORTS')) {
      const [id, harness_id, reporter_user_id, reporter_login, reason, ip_hash, created_at] = binds;
      this.tables.reports.push({
        id, harness_id, reporter_github_user_id: reporter_user_id,
        reporter_github_login: reporter_login, reason, ip_hash,
        status: 'pending', resolved_at: null,
        resolved_by_operator_note: null, created_at,
      });
      return 1;
    }
    if (upper.startsWith('INSERT INTO PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const existing = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      if (existing) {
        existing.count = (existing.count as number) + 1;
      } else {
        this.tables.publish_rate_limit.push({
          github_user_id: user_id,
          window_start,
          count: 1,
        });
      }
      return 1;
    }
    if (upper.startsWith('INSERT INTO AUDIT')) {
      const [ts, kind, detail] = binds;
      this.tables.audit.push({ ts, kind, detail });
      return 1;
    }
    return 0;
  }

  query(sql: string, binds: unknown[]): Row[] {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE GITHUB_REPOSITORY_ID =')) {
      const [repoId] = binds;
      const row = this.tables.harnesses.find((r) => r.github_repository_id === repoId);
      return row ? [row] : [];
    }
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE')) {
      // Listing query. Just return all not-unlisted rows for tests.
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      // Last bind is always limit.
      const limit = binds[binds.length - 1] as number;
      rows = rows.slice(0, limit);
      return rows;
    }
    if (upper.startsWith('SELECT COUNT FROM PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const row = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      return row ? [{ count: row.count }] : [];
    }
    return [];
  }
}

function makeDb(): { db: D1Database; store: FakeStore } {
  const store = new FakeStore();
  const db = {
    prepare(sql: string) {
      return new FakeStmt(sql, store) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, store };
}

// ---------- KV mock ----------

class FakeKV {
  data = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async put(key: string, value: string, _opts?: unknown): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

// ---------- Env helpers ----------

function makeEnv(overrides: Partial<Env> = {}): { env: Env; store: FakeStore } {
  const { db, store } = makeDb();
  const env = {
    DB: db,
    COUNTERS: new FakeKV() as unknown as KVNamespace,
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    IP_HASH_PEPPER: 'test-pepper',
    ENVIRONMENT: 'test',
    CUPBOARD_HOST: 'cupboard.test',
    RATE_PER_USER_PUBLISH_HOURLY: '5',
    RATE_PER_USER_REPORT_HOURLY: '10',
    RATE_PER_IP_LIST_PER_MINUTE: '60',
    INDEXER_BATCH_SIZE: '100',
    ...overrides,
  } as Env;
  return { env, store };
}

// ---------- fetch mock (GitHub stubs) ----------

interface GhStub {
  user?: { id: number; login: string } | { error: number };
  repo?: { id: number; private: boolean; permissions?: Record<string, boolean> } | { error: number };
}

function stubGithub(stub: GhStub): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/user')) {
      if (stub.user && 'error' in stub.user) {
        return new Response('', { status: stub.user.error });
      }
      if (stub.user) {
        return new Response(JSON.stringify(stub.user), { status: 200 });
      }
      return new Response('', { status: 401 });
    }
    if (u.includes('/repos/')) {
      if (stub.repo && 'error' in stub.repo) {
        return new Response('', { status: stub.repo.error });
      }
      if (stub.repo) {
        return new Response(JSON.stringify(stub.repo), { status: 200 });
      }
      return new Response('', { status: 404 });
    }
    void init;
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

// ---------- tests ----------

describe('Cupboard server', () => {
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
    const j1 = await res1.json() as { ok: boolean; id: string; harness: { title: string } };
    expect(j1.ok).toBe(true);
    expect(j1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(j1.harness.title).toBe('Cool harness');
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
    stubGithub({
      user: { id: 1, login: 'alice' },
      repo: { id: 1, private: false },
    });
    // To trigger cap purely via rate-limit, change the repo id between calls.
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
    store.tables.harnesses.push({
      id: 'h1', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'd'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
    stubGithub({ user: { id: 999, login: 'mallory' } });
    const res = await api.request('/harnesses/h1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(403);
  });

  it('DELETE /harnesses/:id by publisher unlists', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push({
      id: 'h2', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'd'.repeat(64), publisher_github_user_id: 7, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
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
    store.tables.harnesses.push({
      id: 'h3', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'e'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
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
    store.tables.harnesses.push({
      id: 'h4', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'f'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
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
    store.tables.harnesses.push({
      id: 'h5', github_repository_id: 88, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'BoundOne', description: null,
      topic_hex: 'a'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
    const res = await api.request('/binding/88', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean; harness: { title: string } };
    expect(body.exists).toBe(true);
    expect(body.harness.title).toBe('BoundOne');
  });

  it('POST /reports requires auth + harness + reason', async () => {
    const { env, store } = makeEnv();
    store.tables.harnesses.push({
      id: 'h6', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'a'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
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
    store.tables.harnesses.push({
      id: 'h7', github_repository_id: 1, github_owner: 'a', github_name: 'b',
      github_url: 'https://github.com/a/b', title: 'T', description: null,
      topic_hex: 'a'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
      claim_status: 'unclaimed', claimant_github_user_id: null,
      claimant_github_login: null, superseded_by: null,
      stars: 0, contributor_count: 0, last_activity_at: null,
      languages: null, stats_refreshed_at: null,
      created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    });
    stubGithub({ user: { id: 9, login: 'reporter' } });
    const res = await api.request('/reports', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness_id: 'h7', reason: 'x'.repeat(1001) }),
    }, env);
    expect(res.status).toBe(400);
  });
});

// silence the unused-import warning for vi (kept for potential future spies)
void vi;
