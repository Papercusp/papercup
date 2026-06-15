/**
 * admin.test.ts — admin / cron GC endpoints (publish service).
 *
 * Three scheduled-trigger endpoints, each driven against a small fake D1 that
 * understands exactly the SQL the route emits:
 *   POST /admin/gc/abandoned-uploads — flips deployments stuck 'uploading' > 1h
 *     to 'failed' (failure_reason 'abandoned (gc)'), returns { killed }.
 *   POST /admin/gc/expired-archives — deletes R2 prefixes + nulls archive_path
 *     for free (>30d) / paid (>1y) deployments past TTL, returns { purged }.
 *   POST /admin/gc/jti — DELETEs expired jti rows, returns { ok: true }.
 * setDeploymentStatus and deletePrefix are mocked; the rest is the real handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setDeploymentStatus: vi.fn(async () => {}),
  deletePrefix: vi.fn(async () => {}),
}));

vi.mock('../db.ts', () => ({ setDeploymentStatus: h.setDeploymentStatus }));
vi.mock('../r2-archive.ts', () => ({ deletePrefix: h.deletePrefix }));
// cf-pages is imported by admin.ts but its exports are unused by the handlers.
vi.mock('../cf-pages.ts', () => ({ deleteDeployment: vi.fn(), getProject: vi.fn() }));

import { adminRoute } from './admin.ts';

type Row = Record<string, unknown>;

// Fake D1 that routes the route's three queries by their leading keyword.
class FakeDb {
  selectRows: Row[] = [];
  runs: Array<{ sql: string; binds: unknown[] }> = [];
  lastAllBinds: unknown[] = [];

  prepare(sql: string) {
    const self = this;
    let binds: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        binds = v;
        return stmt;
      },
      async all<T = Row>() {
        self.lastAllBinds = binds;
        return { results: self.selectRows as unknown as T[], success: true as const };
      },
      async run() {
        self.runs.push({ sql, binds });
        return { success: true as const, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
}

function makeEnv(db: FakeDb) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { DB: db } as any;
}

const post = (db: FakeDb, path: string) =>
  adminRoute().request(path, { method: 'POST' }, makeEnv(db));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('POST /admin/gc/abandoned-uploads', () => {
  it('flips each stale uploading deployment to failed and reports the count', async () => {
    const db = new FakeDb();
    db.selectRows = [
      { id: 'd1', tenant_id: 't1', harness_slug: 'a' },
      { id: 'd2', tenant_id: 't2', harness_slug: 'b' },
    ];
    const res = await post(db, '/admin/gc/abandoned-uploads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: 2 });
    expect(h.setDeploymentStatus).toHaveBeenCalledTimes(2);
    expect(h.setDeploymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      'failed',
      expect.objectContaining({ failure_reason: 'abandoned (gc)' }),
    );
    // The cutoff bind is ~1h ago.
    expect(db.lastAllBinds[0]).toBeLessThan(Date.now());
  });

  it('reports killed:0 and never writes when nothing is stale', async () => {
    const db = new FakeDb();
    db.selectRows = [];
    const res = await post(db, '/admin/gc/abandoned-uploads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: 0 });
    expect(h.setDeploymentStatus).not.toHaveBeenCalled();
  });
});

describe('POST /admin/gc/expired-archives', () => {
  it('deletes the R2 prefix + nulls archive_path for each expired deployment', async () => {
    const db = new FakeDb();
    db.selectRows = [
      { id: 'd1', tenant_id: 't1', tier: 'free' },
      { id: 'd2', tenant_id: 't2', tier: 'paid' },
    ];
    const res = await post(db, '/admin/gc/expired-archives');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 2 });
    expect(h.deletePrefix).toHaveBeenCalledTimes(2);
    expect(h.deletePrefix).toHaveBeenCalledWith(expect.anything(), 't1', 'd1');
    // One UPDATE ... SET archive_path = NULL per purged row.
    const updates = db.runs.filter((r) => /archive_path\s*=\s*NULL/i.test(r.sql));
    expect(updates).toHaveLength(2);
    expect(updates[0].binds).toEqual(['d1']);
  });

  it('reports purged:0 when no archives are expired', async () => {
    const db = new FakeDb();
    db.selectRows = [];
    const res = await post(db, '/admin/gc/expired-archives');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 0 });
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });
});

describe('POST /admin/gc/jti', () => {
  it('deletes expired jti rows and returns ok', async () => {
    const db = new FakeDb();
    const res = await post(db, '/admin/gc/jti');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const del = db.runs.find((r) => /DELETE FROM jti_used/i.test(r.sql));
    expect(del).toBeTruthy();
    // Bind is an epoch-seconds cutoff (~ now/1000), not millis.
    const cutoff = del!.binds[0] as number;
    expect(cutoff).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    expect(cutoff).toBeGreaterThan(1_000_000_000);
  });
});
