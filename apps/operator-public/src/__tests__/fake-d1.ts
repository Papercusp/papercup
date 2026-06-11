/**
 * Shared in-memory D1 + KV + GitHub-fetch fakes for the Cupboard worker tests.
 *
 * The store interprets the exact SQL the db.ts helpers emit — it is not a real
 * SQL engine, it pattern-matches the known statements and consumes their binds
 * positionally. Keep it in sync with db.ts when statements change.
 */

import type { Env } from '../env.ts';

export interface Row {
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

/** A fully-defaulted harness/listing row; override what a test cares about. */
export function makeListingRow(over: Partial<Row> = {}): Row {
  return {
    id: 'seed',
    listing_kind: 'harness',
    project_ref: null,
    listing_ref: null,
    github_repository_id: 1,
    github_owner: 'a',
    github_name: 'b',
    github_url: 'https://github.com/a/b',
    title: 'T',
    description: null,
    topic_hex: 'a'.repeat(64),
    publisher_github_user_id: 1,
    publisher_github_login: 'alice',
    publisher_permission: null,
    publisher_device_pubkey: null,
    publisher_attestation_gist_id: null,
    provides_tools: null,
    hive_pubkey: null,
    hive_title: null,
    claim_status: 'unclaimed',
    claimant_github_user_id: null,
    claimant_github_login: null,
    superseded_by: null,
    stars: 0,
    contributor_count: 0,
    last_activity_at: null,
    languages: null,
    stats_refreshed_at: null,
    created_at: 1,
    updated_at: 1,
    unlisted_at: null,
    unlisted_reason: null,
    // migration 008 (learning-packs): pre-publication review fields.
    review_status: 'approved',
    reviewed_at: null,
    review_reason: null,
    ...over,
  };
}

export class FakeStore {
  tables: Record<string, Row[]> = {
    harnesses: [],
    reports: [],
    publish_rate_limit: [],
    indexer_runs: [],
    audit: [],
    banned_publisher_pubkeys: [],
  };

  execute(sql: string, binds: unknown[]): number {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('INSERT INTO HARNESSES')) {
      // Bind order matches insertHarness() in db.ts (migrations 004/006/007/008).
      const [
        id, listing_kind, project_ref, listing_ref,
        gh_repo_id, gh_owner, gh_name, gh_url, title, description, topic_hex,
        pub_user_id, pub_login, pub_permission, device_pubkey, attestation_gist_id,
        provides_tools,
        hive_pubkey, hive_title,
        review_status,
        created_at, updated_at,
      ] = binds;
      this.tables.harnesses.push(
        makeListingRow({
          id,
          listing_kind: listing_kind ?? 'harness',
          project_ref: project_ref ?? null,
          listing_ref: listing_ref ?? null,
          github_repository_id: gh_repo_id,
          github_owner: gh_owner,
          github_name: gh_name,
          github_url: gh_url,
          title,
          description,
          topic_hex,
          publisher_github_user_id: pub_user_id,
          publisher_github_login: pub_login,
          publisher_permission: pub_permission ?? null,
          publisher_device_pubkey: device_pubkey ?? null,
          publisher_attestation_gist_id: attestation_gist_id ?? null,
          provides_tools: provides_tools ?? null,
          hive_pubkey: hive_pubkey ?? null,
          hive_title: hive_title ?? null,
          review_status: review_status ?? 'approved',
          created_at,
          updated_at,
        }),
      );
      return 1;
    }
    // setReviewStatus (migration 008 / learning-packs P-019).
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET REVIEW_STATUS')) {
      const [review_status, reviewed_at, review_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.review_status = review_status;
        row.reviewed_at = reviewed_at;
        row.review_reason = review_reason;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET UNLISTED_AT')) {
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
    if (upper.includes("CLAIM_STATUS = 'CLAIMED'")) {
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
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('SET STARS')) {
      const [stars, contributor_count, last_activity_at, languages, refreshed, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.stars = stars;
        row.contributor_count = contributor_count;
        row.last_activity_at = last_activity_at;
        row.languages = languages;
        row.stats_refreshed_at = refreshed;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('UPDATE HARNESSES') && upper.includes('PUBLISHER_DEVICE_PUBKEY = NULL')) {
      const [updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.publisher_device_pubkey = null;
        row.publisher_attestation_gist_id = null;
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
    if (upper.startsWith('UPDATE REPORTS')) {
      const [status, resolved_at, note, id] = binds;
      const row = this.tables.reports.find((r) => r.id === id && r.status === 'pending');
      if (row) {
        row.status = status;
        row.resolved_at = resolved_at;
        row.resolved_by_operator_note = note;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('INSERT INTO PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const existing = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      if (existing) {
        existing.count = (existing.count as number) + 1;
      } else {
        this.tables.publish_rate_limit.push({ github_user_id: user_id, window_start, count: 1 });
      }
      return 1;
    }
    if (upper.startsWith('INSERT INTO AUDIT')) {
      const [ts, kind, detail] = binds;
      this.tables.audit.push({ ts, kind, detail });
      return 1;
    }
    if (upper.startsWith('INSERT INTO BANNED_PUBLISHER_PUBKEYS')) {
      const [pubkey, reason, added_at, op_id, updated_at] = binds;
      const existing = this.tables.banned_publisher_pubkeys.find((r) => r.pubkey === pubkey);
      if (existing) {
        existing.reason = reason;
        existing.updated_at = updated_at;
      } else {
        this.tables.banned_publisher_pubkeys.push({
          pubkey, reason, added_at, added_by_operator_user_id: op_id ?? null, updated_at,
        });
      }
      return 1;
    }
    if (upper.startsWith('DELETE FROM BANNED_PUBLISHER_PUBKEYS')) {
      const [pubkey] = binds;
      const before = this.tables.banned_publisher_pubkeys.length;
      this.tables.banned_publisher_pubkeys = this.tables.banned_publisher_pubkeys.filter(
        (r) => r.pubkey !== pubkey,
      );
      return before - this.tables.banned_publisher_pubkeys.length;
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
    // getActiveListingByRefs: repo + kind + listing_ref (must precede the
    // harness-repo branch since both start with GITHUB_REPOSITORY_ID).
    if (upper.includes('AND LISTING_REF =')) {
      const [repoId, kind, ref] = binds;
      const row = this.tables.harnesses.find(
        (r) =>
          r.github_repository_id === repoId &&
          r.listing_kind === kind &&
          r.listing_ref === ref &&
          r.unlisted_at == null,
      );
      return row ? [row] : [];
    }
    // getHarnessByGithubRepoId: repo, kind='harness', active-first.
    if (upper.startsWith('SELECT * FROM HARNESSES') && upper.includes("LISTING_KIND = 'HARNESS'")) {
      const [repoId] = binds;
      const matches = this.tables.harnesses
        .filter((r) => r.github_repository_id === repoId && r.listing_kind === 'harness')
        .sort((a, b) => (a.unlisted_at == null ? 0 : 1) - (b.unlisted_at == null ? 0 : 1));
      return matches.length ? [matches[0]] : [];
    }
    // listHarnesses: WHERE unlisted_at IS NULL [AND listing_kind=?] [AND project_ref=?]
    //   [AND cursor] [AND search×4] [AND claim_status=?] ... LIMIT ?
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE') && upper.includes('UNLISTED_AT IS NULL')) {
      let i = 0;
      const hasKind = upper.includes('LISTING_KIND = ?');
      const kind = hasKind ? binds[i++] : undefined;
      const hasProject = upper.includes('PROJECT_REF = ?');
      const project = hasProject ? binds[i++] : undefined;
      const hasCursor = upper.includes('LAST_ACTIVITY_AT < ?');
      if (hasCursor) i++;
      const hasSearch = upper.includes('TITLE LIKE ?');
      if (hasSearch) i += 4;
      const hasClaim = upper.includes('CLAIM_STATUS = ?');
      const claim = hasClaim ? binds[i++] : undefined;
      const limit = binds[binds.length - 1] as number;
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      if (hasKind) rows = rows.filter((r) => r.listing_kind === kind);
      if (hasProject) rows = rows.filter((r) => r.project_ref === project);
      if (hasClaim) rows = rows.filter((r) => r.claim_status === claim);
      return rows.slice(0, limit);
    }
    if (upper.startsWith('SELECT COUNT FROM PUBLISH_RATE_LIMIT')) {
      const [user_id, window_start] = binds;
      const row = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start,
      );
      return row ? [{ count: row.count }] : [];
    }
    if (upper.startsWith('SELECT PUBKEY FROM BANNED_PUBLISHER_PUBKEYS')) {
      return this.tables.banned_publisher_pubkeys.map((r) => ({ pubkey: r.pubkey }));
    }
    if (upper.startsWith('SELECT * FROM BANNED_PUBLISHER_PUBKEYS')) {
      return [...this.tables.banned_publisher_pubkeys];
    }
    if (upper.startsWith('SELECT * FROM REPORTS WHERE ID =')) {
      const [id] = binds;
      const row = this.tables.reports.find((r) => r.id === id);
      return row ? [row] : [];
    }
    if (upper.includes('FROM REPORTS')) {
      // listReports join — return reports (optionally filtered by status).
      const filterStatus = upper.includes('WHERE R.STATUS = ?');
      let rows = [...this.tables.reports];
      if (filterStatus) rows = rows.filter((r) => r.status === binds[0]);
      return rows.map((r) => ({
        ...r,
        harness_title: this.tables.harnesses.find((h) => h.id === r.harness_id)?.title ?? null,
        harness_github_url: this.tables.harnesses.find((h) => h.id === r.harness_id)?.github_url ?? null,
        harness_unlisted_at: this.tables.harnesses.find((h) => h.id === r.harness_id)?.unlisted_at ?? null,
      }));
    }
    return [];
  }
}

export function makeDb(): { db: D1Database; store: FakeStore } {
  const store = new FakeStore();
  const db = {
    prepare(sql: string) {
      return new FakeStmt(sql, store) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, store };
}

export class FakeKV {
  data = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async put(key: string, value: string, _opts?: unknown): Promise<void> { this.data.set(key, value); }
  async delete(key: string): Promise<void> { this.data.delete(key); }
}

/**
 * In-memory R2 fake for the snapshot tarball blob store (migration 005). Covers
 * the subset the blobs/listings routes use: head/put/get/delete. `get` returns a
 * streamable body + a no-op writeHttpMetadata, matching the R2ObjectBody shape
 * the GET route consumes.
 */
export class FakeR2 {
  data = new Map<string, Uint8Array>();
  async head(key: string): Promise<{ size: number } | null> {
    const v = this.data.get(key);
    return v ? { size: v.byteLength } : null;
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string, _opts?: unknown): Promise<{ size: number }> {
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.data.set(key, bytes);
    return { size: bytes.byteLength };
  }
  async get(
    key: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; writeHttpMetadata: (h: Headers) => void } | null> {
    const v = this.data.get(key);
    if (!v) return null;
    return {
      size: v.byteLength,
      body: new Response(v).body as ReadableStream<Uint8Array>,
      writeHttpMetadata: (_h: Headers) => {},
    };
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; store: FakeStore; r2: FakeR2 } {
  const { db, store } = makeDb();
  const r2 = new FakeR2();
  const env = {
    DB: db,
    COUNTERS: new FakeKV() as unknown as KVNamespace,
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    IP_HASH_PEPPER: 'test-pepper',
    ENVIRONMENT: 'test',
    CUPBOARD_HOST: 'cupboard.test',
    CUPBOARD_OPERATOR_GITHUB_IDS: '',
    RATE_PER_USER_PUBLISH_HOURLY: '5',
    RATE_PER_USER_REPORT_HOURLY: '10',
    RATE_PER_IP_LIST_PER_MINUTE: '60',
    INDEXER_BATCH_SIZE: '100',
    ...overrides,
  } as Env;
  return { env, store, r2 };
}

export interface GhStub {
  user?: { id: number; login: string } | { error: number };
  repo?: { id: number; private: boolean; permissions?: Record<string, boolean> } | { error: number };
}

export function stubGithub(stub: GhStub): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/user')) {
      if (stub.user && 'error' in stub.user) return new Response('', { status: stub.user.error });
      if (stub.user) return new Response(JSON.stringify(stub.user), { status: 200 });
      return new Response('', { status: 401 });
    }
    if (u.includes('/repos/')) {
      if (stub.repo && 'error' in stub.repo) return new Response('', { status: stub.repo.error });
      if (stub.repo) return new Response(JSON.stringify(stub.repo), { status: 200 });
      return new Response('', { status: 404 });
    }
    void init;
    return new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
}
