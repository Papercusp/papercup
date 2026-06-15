/**
 * commands/defs/harness.ts — harness.* fast queries (status / list /
 * list-features / issues.list / escalations.get / pending-reviews.list /
 * harness.health) plus the private baseUrl() loopback resolver.
 *
 * Covers each handler end-to-end through the REAL registry (runQuery) and
 * the real handlers. The only seam is the loopback transport: global fetch
 * (the /api/harness/... relative call this registry def makes server-side).
 * baseUrl() isn't exported, so we exercise it through the URL the handler
 * passes to fetch:
 *   - server-side (window undefined): http://127.0.0.1:<PORT> with the
 *     PORT / NEXT_PUBLIC_PORT / 3155 fallback chain
 *   - browser-like (window defined): '' (relative)
 *
 * Console-clean: the registry's audit sampler schedules a flush timer but
 * flushImpl is null off-server, so nothing reaches console. We use fake
 * timers in the env-var suite only where we assert on fallbacks.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '../defs/harness';
import { runQuery } from '../registry';
import type { CommandContext } from '../types';

const PORT = '3155';

let savedPort: string | undefined;
let savedNextPort: string | undefined;

beforeAll(() => {
  savedPort = process.env.PORT;
  savedNextPort = process.env.NEXT_PUBLIC_PORT;
});
afterAll(() => {
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
  if (savedNextPort === undefined) delete process.env.NEXT_PUBLIC_PORT;
  else process.env.NEXT_PUBLIC_PORT = savedNextPort;
});

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  agent: 'operator',
  workspace: 'default',
  requestId: 'r-1',
  ...overrides,
});

/* ─── fetch seam ──────────────────────────────────────────────────────── */

type Resp = { ok: boolean; status: number; json: () => Promise<unknown> };
const jsonResp = (body: unknown, status = 200): Resp => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const errResp = (status: number): Resp => ({
  ok: false,
  status,
  json: async () => ({}),
});

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Resp>>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  // Default deterministic loopback port unless a test overrides.
  process.env.PORT = PORT;
  delete process.env.NEXT_PUBLIC_PORT;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Route fetch by URL substring so order-independent tests stay readable. */
function routeFetch(routes: Array<{ match: string; resp: Resp | (() => never) }>): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    for (const r of routes) {
      if (url.includes(r.match)) {
        if (typeof r.resp === 'function') return r.resp();
        return r.resp;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

const urls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const unwrap = <T>(r: Awaited<ReturnType<typeof runQuery>>): T => {
  if (!r.ok) throw new Error(`expected ok, got error ${JSON.stringify(r.error)}`);
  return r.value as T;
};

/* ─── harness.status ──────────────────────────────────────────────────── */

describe('harness.status', () => {
  type Status = {
    slug: string;
    path: unknown;
    alive: boolean;
    paused: boolean;
    iteration: unknown;
    feature_counts: Record<string, number>;
    feature_total: number;
    recent_features: Array<{ id: unknown; status: unknown; title: unknown }>;
    summary_excerpt: string | null;
  };

  it('rolls up per-status counts, sets total, returns last-5 recent (id/status/title) and a ≤1200 excerpt', async () => {
    const features = [
      { id: 'f1', status: 'passed', title: 'one', extra: 'drop-me' },
      { id: 'f2', status: 'failed', title: 'two' },
      { id: 'f3', status: 'passed', title: 'three' },
      { id: 'f4', status: 'in-progress', title: 'four' },
      { id: 'f5', status: 'passed', title: 'five' },
      { id: 'f6', status: 'blocked', title: 'six' },
      { id: 'f7', status: 'passed', title: 'seven' },
    ];
    const longSummary = 'x'.repeat(2000);
    routeFetch([
      { match: '/status?phase=staging', resp: jsonResp({
        project: { path: '/p' }, alive: true, paused: false, iteration: 9, features,
      }) },
      { match: '/summary', resp: jsonResp({ summary: longSummary }) },
    ]);

    const v = unwrap<Status>(await runQuery('harness.status', { slug: 'sheets' }, ctx()));
    expect(v.slug).toBe('sheets');
    expect(v.path).toBe('/p');
    expect(v.alive).toBe(true);
    expect(v.paused).toBe(false);
    expect(v.iteration).toBe(9);
    expect(v.feature_total).toBe(7);
    expect(v.feature_counts).toEqual({ passed: 4, failed: 1, 'in-progress': 1, blocked: 1 });
    // last 5 only, projected to id/status/title (no `extra`).
    expect(v.recent_features).toEqual([
      { id: 'f3', status: 'passed', title: 'three' },
      { id: 'f4', status: 'in-progress', title: 'four' },
      { id: 'f5', status: 'passed', title: 'five' },
      { id: 'f6', status: 'blocked', title: 'six' },
      { id: 'f7', status: 'passed', title: 'seven' },
    ]);
    expect(v.summary_excerpt).toHaveLength(1200);
    expect(v.summary_excerpt).toBe('x'.repeat(1200));
  });

  it("defaults a missing feature status to 'unknown' and tolerates empty feature list", async () => {
    routeFetch([
      { match: '/status?phase=staging', resp: jsonResp({ features: [{ id: 'a', title: 't' }] }) },
      { match: '/summary', resp: jsonResp({ summary: 'short' }) },
    ]);
    const v = unwrap<Status>(await runQuery('harness.status', { slug: 'h' }, ctx()));
    expect(v.feature_counts).toEqual({ unknown: 1 });
    expect(v.feature_total).toBe(1);
    expect(v.alive).toBe(false);
    expect(v.paused).toBe(false);
  });

  it('nulls the excerpt when summary is missing or non-string', async () => {
    routeFetch([
      { match: '/status?phase=staging', resp: jsonResp({ features: [] }) },
      { match: '/summary', resp: jsonResp({ summary: { not: 'a string' } }) },
    ]);
    const v = unwrap<Status>(await runQuery('harness.status', { slug: 'h' }, ctx()));
    expect(v.summary_excerpt).toBeNull();
    expect(v.feature_total).toBe(0);
    expect(v.recent_features).toEqual([]);
  });

  it('throws (ok=false / internal) when the status fetch is not ok', async () => {
    routeFetch([
      { match: '/status?phase=staging', resp: errResp(500) },
      { match: '/summary', resp: jsonResp({ summary: 's' }) },
    ]);
    const r = await runQuery('harness.status', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('tolerates a failed summary fetch (rejected promise) — excerpt null, status still resolves', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/summary')) throw new Error('summary endpoint down');
      if (url.includes('/status?phase=staging')) {
        return jsonResp({ alive: true, features: [{ id: 'x', status: 'passed', title: 'X' }] });
      }
      throw new Error(`unrouted ${url}`);
    });
    const v = unwrap<Status>(await runQuery('harness.status', { slug: 'h' }, ctx()));
    expect(v.alive).toBe(true);
    expect(v.summary_excerpt).toBeNull();
    expect(v.feature_total).toBe(1);
  });

  it('tolerates a non-ok summary response (caught -> excerpt null)', async () => {
    routeFetch([
      { match: '/status?phase=staging', resp: jsonResp({ features: [] }) },
      { match: '/summary', resp: errResp(404) },
    ]);
    const v = unwrap<Status>(await runQuery('harness.status', { slug: 'h' }, ctx()));
    expect(v.summary_excerpt).toBeNull();
  });

  it('rejects a missing/blank slug before the handler runs (no fetch)', async () => {
    for (const args of [{}, { slug: '' }]) {
      const r = await runQuery('harness.status', args, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-args');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ─── harness.list-features ───────────────────────────────────────────── */

describe('harness.list-features', () => {
  type ListFeatures = {
    slug: string;
    count: number;
    features: Array<{ id: unknown; title: unknown; status: unknown; claims: unknown; attempts: unknown }>;
  };

  const mkFeatures = (n: number, status = 'passed') =>
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`, title: `t${i}`, status, claims: i, attempts: i + 1, junk: 'drop',
    }));

  it('projects only {id,title,status,claims,attempts} and defaults limit to 50', async () => {
    routeFetch([{ match: '/status?phase=staging', resp: jsonResp({ features: mkFeatures(80) }) }]);
    const v = unwrap<ListFeatures>(await runQuery('harness.list-features', { slug: 'h' }, ctx()));
    expect(v.slug).toBe('h');
    expect(v.count).toBe(50);
    expect(v.features).toHaveLength(50);
    expect(Object.keys(v.features[0]).sort()).toEqual(
      ['attempts', 'claims', 'id', 'status', 'title'],
    );
    expect(v.features[0]).toEqual({ id: 'f0', title: 't0', status: 'passed', claims: 0, attempts: 1 });
  });

  it('filters by the optional status arg, then slices to limit', async () => {
    const features = [...mkFeatures(3, 'passed'), ...mkFeatures(3, 'failed')];
    routeFetch([{ match: '/status?phase=staging', resp: jsonResp({ features }) }]);
    const v = unwrap<ListFeatures>(
      await runQuery('harness.list-features', { slug: 'h', status: 'failed', limit: 2 }, ctx()),
    );
    expect(v.count).toBe(2);
    expect(v.features.every((f) => f.status === 'failed')).toBe(true);
  });

  it('treats a null status as no filter (returns all up to limit)', async () => {
    routeFetch([{ match: '/status?phase=staging', resp: jsonResp({ features: mkFeatures(5) }) }]);
    const v = unwrap<ListFeatures>(
      await runQuery('harness.list-features', { slug: 'h', status: null }, ctx()),
    );
    expect(v.count).toBe(5);
  });

  it('caps limit at 200 via schema (201 rejected as invalid-args)', async () => {
    const r = await runQuery('harness.list-features', { slug: 'h', limit: 201 }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-args');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws (internal) when the feature fetch is not ok', async () => {
    routeFetch([{ match: '/status?phase=staging', resp: errResp(503) }]);
    const r = await runQuery('harness.list-features', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('handles a non-array features payload as empty', async () => {
    routeFetch([{ match: '/status?phase=staging', resp: jsonResp({ features: null }) }]);
    const v = unwrap<ListFeatures>(await runQuery('harness.list-features', { slug: 'h' }, ctx()));
    expect(v.count).toBe(0);
    expect(v.features).toEqual([]);
  });
});

/* ─── issues.list ─────────────────────────────────────────────────────── */

describe('issues.list', () => {
  type Issues = { count: number; issues: unknown[] };

  it('with slug: concatenates d.pending + d.issues and slices to limit', async () => {
    const pending = [{ id: 'p1' }, { id: 'p2' }];
    const issues = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }];
    routeFetch([{ match: '/issues-list', resp: jsonResp({ pending, issues }) }]);
    const v = unwrap<Issues>(await runQuery('issues.list', { slug: 'sheets', limit: 4 }, ctx()));
    expect(v.count).toBe(4);
    expect(v.issues).toEqual([{ id: 'p1' }, { id: 'p2' }, { id: 'i1' }, { id: 'i2' }]);
    expect(urls()[0]).toContain('/api/harness/sheets/issues-list');
  });

  it('with slug: default limit is 20', async () => {
    const pending = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}` }));
    routeFetch([{ match: '/issues-list', resp: jsonResp({ pending }) }]);
    const v = unwrap<Issues>(await runQuery('issues.list', { slug: 'h' }, ctx()));
    expect(v.count).toBe(20);
  });

  it('without slug: hits needs-human-review and maps features, default status needs-review', async () => {
    const features = [
      { id: 'a', title: 'A', harness_slug: 'h1', status: 'open' },
      { id: 'b', title: 'B', harness_slug: 'h2' }, // no status → needs-review
    ];
    routeFetch([{ match: '/needs-human-review', resp: jsonResp({ features }) }]);
    const v = unwrap<Issues>(await runQuery('issues.list', {}, ctx()));
    expect(urls()[0]).toContain('/api/harness/needs-human-review');
    expect(v.count).toBe(2);
    expect(v.issues).toEqual([
      { id: 'a', title: 'A', harness_slug: 'h1', status: 'open' },
      { id: 'b', title: 'B', harness_slug: 'h2', status: 'needs-review' },
    ]);
  });

  it('throws (internal) when the slug issues-list fetch is not ok', async () => {
    routeFetch([{ match: '/issues-list', resp: errResp(500) }]);
    const r = await runQuery('issues.list', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('throws (internal) when the needs-human-review fetch is not ok', async () => {
    routeFetch([{ match: '/needs-human-review', resp: errResp(500) }]);
    const r = await runQuery('issues.list', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('is denied to pi (allowlist is oracle + operator)', async () => {
    const r = await runQuery('issues.list', {}, ctx({ agent: 'pi' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ─── escalations.get ─────────────────────────────────────────────────── */

describe('escalations.get', () => {
  type Esc = {
    hasEscalation: boolean;
    escalation: string | null;
    supervisorNotes: unknown;
    mtimeMs: unknown;
  };

  it('returns hasEscalation=false with null fields on HTTP 404', async () => {
    routeFetch([{ match: '/escalation', resp: errResp(404) }]);
    const v = unwrap<Esc>(await runQuery('escalations.get', { slug: 'h' }, ctx()));
    expect(v).toEqual({ hasEscalation: false, escalation: null, supervisorNotes: null, mtimeMs: null });
  });

  it('throws (internal) on a non-404 non-ok status', async () => {
    routeFetch([{ match: '/escalation', resp: errResp(500) }]);
    const r = await runQuery('escalations.get', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('derives hasEscalation from a non-empty trimmed escalation string', async () => {
    routeFetch([{ match: '/escalation', resp: jsonResp({
      escalation: '  needs review  ', supervisorNotes: 'note', mtimeMs: 123,
    }) }]);
    const v = unwrap<Esc>(await runQuery('escalations.get', { slug: 'h' }, ctx()));
    expect(v.hasEscalation).toBe(true);
    expect(v.escalation).toBe('  needs review  ');
    expect(v.supervisorNotes).toBe('note');
    expect(v.mtimeMs).toBe(123);
  });

  it('whitespace-only escalation → hasEscalation false and escalation nulled', async () => {
    routeFetch([{ match: '/escalation', resp: jsonResp({ escalation: '   \n\t ' }) }]);
    const v = unwrap<Esc>(await runQuery('escalations.get', { slug: 'h' }, ctx()));
    expect(v.hasEscalation).toBe(false);
    expect(v.escalation).toBeNull();
    expect(v.supervisorNotes).toBeNull();
    expect(v.mtimeMs).toBeNull();
  });
});

/* ─── pending-reviews.list ────────────────────────────────────────────── */

describe('pending-reviews.list', () => {
  type Reviews = { count: number; reviews: unknown[] };

  it('slices reviews to the default limit of 20 and returns count', async () => {
    const reviews = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));
    routeFetch([{ match: '/reviews', resp: jsonResp({ reviews }) }]);
    const v = unwrap<Reviews>(await runQuery('pending-reviews.list', { slug: 'h' }, ctx()));
    expect(v.count).toBe(20);
    expect(v.reviews).toHaveLength(20);
  });

  it('honors an explicit limit', async () => {
    const reviews = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));
    routeFetch([{ match: '/reviews', resp: jsonResp({ reviews }) }]);
    const v = unwrap<Reviews>(await runQuery('pending-reviews.list', { slug: 'h', limit: 3 }, ctx()));
    expect(v.count).toBe(3);
  });

  it('throws (internal) on a non-ok fetch', async () => {
    routeFetch([{ match: '/reviews', resp: errResp(500) }]);
    const r = await runQuery('pending-reviews.list', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });
});

/* ─── harness.health ──────────────────────────────────────────────────── */

describe('harness.health', () => {
  it('returns the raw health payload through', async () => {
    const body = { slug: 'h', alive: true, escalated: false, feature_counts: { passed: 3 }, lastRunMs: 10 };
    routeFetch([{ match: '/health', resp: jsonResp(body) }]);
    const v = unwrap<typeof body>(await runQuery('harness.health', { slug: 'h' }, ctx()));
    expect(v).toEqual(body);
  });

  it('throws (internal) on a non-ok fetch', async () => {
    routeFetch([{ match: '/health', resp: errResp(503) }]);
    const r = await runQuery('harness.health', { slug: 'h' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });
});

/* ─── baseUrl() loopback resolution (via the fetch URL) ───────────────── */

describe('baseUrl() loopback resolution', () => {
  it('server-side: prefixes http://127.0.0.1:<PORT> honoring process.env.PORT', async () => {
    process.env.PORT = '4242';
    delete process.env.NEXT_PUBLIC_PORT;
    routeFetch([{ match: '/health', resp: jsonResp({ ok: true }) }]);
    await runQuery('harness.health', { slug: 'h' }, ctx());
    expect(urls()[0]).toBe('http://127.0.0.1:4242/api/harness/h/health');
  });

  it('falls back to NEXT_PUBLIC_PORT when PORT is unset', async () => {
    delete process.env.PORT;
    process.env.NEXT_PUBLIC_PORT = '5151';
    routeFetch([{ match: '/health', resp: jsonResp({ ok: true }) }]);
    await runQuery('harness.health', { slug: 'h' }, ctx());
    expect(urls()[0]).toContain('http://127.0.0.1:5151/');
  });

  it('falls back to 3155 when neither PORT nor NEXT_PUBLIC_PORT is set', async () => {
    delete process.env.PORT;
    delete process.env.NEXT_PUBLIC_PORT;
    routeFetch([{ match: '/health', resp: jsonResp({ ok: true }) }]);
    await runQuery('harness.health', { slug: 'h' }, ctx());
    expect(urls()[0]).toContain('http://127.0.0.1:3155/');
  });

  it("browser-like env (window defined): emits a relative '' base", async () => {
    vi.stubGlobal('window', {});
    routeFetch([{ match: '/health', resp: jsonResp({ ok: true }) }]);
    await runQuery('harness.health', { slug: 'h' }, ctx());
    // No loopback host prefix — relative path straight from baseUrl()==''.
    expect(urls()[0]).toBe('/api/harness/h/health');
  });

  it('URL-encodes the slug in the path', async () => {
    routeFetch([{ match: '/health', resp: jsonResp({ ok: true }) }]);
    await runQuery('harness.health', { slug: 'a/b c' }, ctx());
    expect(urls()[0]).toContain('/api/harness/a%2Fb%20c/health');
  });
});
