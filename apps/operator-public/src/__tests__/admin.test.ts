/**
 * Cupboard operator moderation surface (/admin) tests.
 *
 * Same in-memory D1 + GitHub-/user fetch-stub approach as harnesses.test.ts,
 * with a FakeStore that understands the SQL the admin route emits: report
 * list-JOIN, getReportById, the guarded resolveReport UPDATE (returns
 * meta.changes), getHarnessById, the markHarnessUnlisted UPDATE, and audit
 * inserts. Operator auth is the CUPBOARD_OPERATOR_GITHUB_IDS allowlist.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';

interface Row {
  [key: string]: unknown;
}

class FakeStmt {
  constructor(private sql: string, private store: FakeStore, private binds: unknown[] = []) {}
  bind(...values: unknown[]): FakeStmt {
    return new FakeStmt(this.sql, this.store, values);
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return { success: true, meta: { changes: this.store.execute(this.sql, this.binds) } };
  }
  async first<T = Row>(): Promise<T | null> {
    return (this.store.query(this.sql, this.binds)[0] as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    return { results: this.store.query(this.sql, this.binds) as T[], success: true };
  }
}

class FakeStore {
  tables: Record<string, Row[]> = { harnesses: [], reports: [], audit: [] };

  execute(sql: string, binds: unknown[]): number {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('UPDATE REPORTS')) {
      // resolveReport: SET status=?,resolved_at=?,note=? WHERE id=? AND status='pending'
      const [status, resolved_at, note, id] = binds;
      const row = this.tables.reports.find((r) => r.id === id && r.status === 'pending');
      if (!row) return 0;
      row.status = status;
      row.resolved_at = resolved_at;
      row.resolved_by_operator_note = note;
      return 1;
    }
    if (upper.startsWith('UPDATE HARNESSES SET UNLISTED_AT')) {
      const [unlisted_at, unlisted_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (!row) return 0;
      row.unlisted_at = unlisted_at;
      row.unlisted_reason = unlisted_reason;
      row.updated_at = updated_at;
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
    if (upper.startsWith('SELECT * FROM REPORTS WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.reports.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.includes('FROM REPORTS R')) {
      // listReports JOIN. Last bind is always the limit; a leading status
      // filter is present iff the SQL has WHERE r.status.
      const filterStatus = upper.includes('WHERE R.STATUS');
      const limit = binds[binds.length - 1] as number;
      const status = filterStatus ? (binds[0] as string) : null;
      let rows = this.tables.reports.slice();
      if (status) rows = rows.filter((r) => r.status === status);
      rows.sort((a, b) => (a.created_at as number) - (b.created_at as number));
      return rows.slice(0, limit).map((r) => {
        const h = this.tables.harnesses.find((x) => x.id === r.harness_id);
        return {
          ...r,
          harness_title: h?.title ?? null,
          harness_github_url: h?.github_url ?? null,
          harness_unlisted_at: h?.unlisted_at ?? null,
        };
      });
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

function makeEnv(overrides: Partial<Env> = {}): { env: Env; store: FakeStore } {
  const { db, store } = makeDb();
  const env = {
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
    ...overrides,
  } as Env;
  return { env, store };
}

function stubUser(user: { id: number; login: string } | { error: number } | null): void {
  globalThis.fetch = (async (url: string | URL) => {
    if (url.toString().endsWith('/user')) {
      if (!user) return new Response('', { status: 401 });
      if ('error' in user) return new Response('', { status: user.error });
      return new Response(JSON.stringify(user), { status: 200 });
    }
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}

const HARNESS: Row = {
  id: 'h1', github_repository_id: 1, github_owner: 'a', github_name: 'b',
  github_url: 'https://github.com/a/b', title: 'Reported harness', description: null,
  topic_hex: 'a'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
  claim_status: 'unclaimed', claimant_github_user_id: null, claimant_github_login: null,
  superseded_by: null, stars: 0, contributor_count: 0, last_activity_at: null,
  languages: null, stats_refreshed_at: null, created_at: 1, updated_at: 1,
  unlisted_at: null, unlisted_reason: null,
};
const REPORT: Row = {
  id: 'r1', harness_id: 'h1', reporter_github_user_id: 9, reporter_github_login: 'reporter',
  reason: 'spam', ip_hash: null, status: 'pending', resolved_at: null,
  resolved_by_operator_note: null, created_at: 100,
};

function seed(store: FakeStore): void {
  store.tables.harnesses.push({ ...HARNESS });
  store.tables.reports.push({ ...REPORT });
}

describe('Cupboard /admin moderation', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('GET /admin/reports 401s without a bearer', async () => {
    const { env } = makeEnv();
    stubUser(null);
    const res = await api.request('/admin/reports', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /admin/reports 403s a valid non-operator', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 999, login: 'mallory' });
    const res = await api.request('/admin/reports', { headers: { Authorization: 'Bearer t' } }, env);
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toBe('not_an_operator');
  });

  it('GET /admin/reports 403s everyone when the allowlist is empty', async () => {
    const { env, store } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '' });
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports', { headers: { Authorization: 'Bearer t' } }, env);
    expect(res.status).toBe(403);
  });

  it('GET /admin/reports lists pending reports joined with the harness for an operator', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports', { headers: { Authorization: 'Bearer t' } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Array<{ id: string; harness_title: string }>; status: string };
    expect(body.status).toBe('pending');
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].id).toBe('r1');
    expect(body.reports[0].harness_title).toBe('Reported harness');
  });

  it('POST resolve {dismiss} marks the report resolved but leaves the harness listed', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports/r1/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', note: 'not abuse' }),
    }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; harness_unlisted: boolean };
    expect(body.status).toBe('resolved_dismiss');
    expect(body.harness_unlisted).toBe(false);
    expect(store.tables.reports[0].status).toBe('resolved_dismiss');
    expect(store.tables.reports[0].resolved_by_operator_note).toBe('not abuse');
    expect(store.tables.harnesses[0].unlisted_at).toBeNull();
  });

  it('POST resolve {unlist} resolves the report AND takes the harness down (reason = report id)', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports/r1/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unlist' }),
    }, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { harness_unlisted: boolean }).harness_unlisted).toBe(true);
    expect(store.tables.reports[0].status).toBe('resolved_unlist');
    expect(store.tables.harnesses[0].unlisted_at).not.toBeNull();
    expect(store.tables.harnesses[0].unlisted_reason).toBe('report:r1');
  });

  it('POST resolve 409s an already-resolved report', async () => {
    const { env, store } = makeEnv();
    seed(store);
    store.tables.reports[0].status = 'resolved_dismiss';
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports/r1/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    }, env);
    expect(res.status).toBe(409);
  });

  it('POST resolve 404s an unknown report', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports/nope/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    }, env);
    expect(res.status).toBe(404);
  });

  it('POST resolve 400s an invalid action', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/reports/r1/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'banhammer' }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('POST /admin/harnesses/:id/unlist takes a harness down for an operator', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 7, login: 'op' });
    const res = await api.request('/admin/harnesses/h1/unlist', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'malware' }),
    }, env);
    expect(res.status).toBe(200);
    expect(store.tables.harnesses[0].unlisted_at).not.toBeNull();
    expect(store.tables.harnesses[0].unlisted_reason).toBe('by_operator');
  });

  it('POST /admin/harnesses/:id/unlist 403s a non-operator', async () => {
    const { env, store } = makeEnv();
    seed(store);
    stubUser({ id: 999, login: 'mallory' });
    const res = await api.request('/admin/harnesses/h1/unlist', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(res.status).toBe(403);
    expect(store.tables.harnesses[0].unlisted_at).toBeNull();
  });
});
