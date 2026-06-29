/**
 * P-007/P-020: the per-hive Tests-tab file-history route
 * (GET /harness/:slug/testing/file-history).
 *
 * Pins that the route scopes the query to (harness_slug, workspace_id,
 * file_path), maps rows to the HistoryRow wire shape, rejects a missing
 * filePath with 400, and is fail-soft (PG error → empty rows, never 500).
 */
import { describe, it, expect, vi } from 'vitest';

// activeWorkspaceId is resolved at handler time — pin it to a known workspace.
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

// Capture the bound query values so we can assert the WHERE scoping, and return
// canned rows (or throw, to exercise fail-soft).
let sqlImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
const captured: unknown[][] = [];

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOrgPg: () => ({
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => sqlImpl(strings, ...values),
    }),
  };
});

import routes from './testing';

const route = (routes as Array<{ path: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>).find(
  (r) => r.path === '/harness/:slug/testing/file-history',
)!;

async function get(slug: string, query: string) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/testing/file-history${query}`);
  const res = await route.handler(req, { params: { slug } });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('GET /harness/:slug/testing/file-history', () => {
  it('is registered', () => {
    expect(route).toBeTruthy();
  });

  it('400s when filePath is missing', async () => {
    sqlImpl = async () => [];
    const { status, body } = await get('my-hive', '');
    expect(status).toBe(400);
    expect(body?.param).toBe('filePath');
  });

  it('scopes the query to harness_slug + workspace_id + file_path and maps rows', async () => {
    captured.length = 0;
    sqlImpl = async (_s, ...values) => {
      captured.push(values);
      return [
        {
          id: '7',
          status: 'pass',
          framework: 'vitest',
          duration_ms: '123',
          started_at: new Date('2026-06-29T00:00:00.000Z'),
          finished_at: new Date('2026-06-29T00:00:01.000Z'),
          output_tail: null,
          source: 'admin-ui',
          branch: 'main',
          commit_sha: 'deadbeef',
        },
      ];
    };
    const { status, body } = await get('my-hive', '?filePath=src/foo.test.ts&limit=5');
    expect(status).toBe(200);
    // WHERE bind values: slug, ws, filePath, limit
    expect(captured[0][0]).toBe('my-hive');
    expect(captured[0][1]).toBe('ws-test');
    expect(captured[0][2]).toBe('src/foo.test.ts');
    expect(captured[0][3]).toBe(5);

    const rows = body?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7); // numeric
    expect(rows[0].status).toBe('pass');
    expect(rows[0].framework).toBe('vitest');
    expect(rows[0].durationMs).toBe(123);
    expect(rows[0].finishedAt).toBe('2026-06-29T00:00:01.000Z');
    expect(rows[0].commitSha).toBe('deadbeef');
  });

  it('is fail-soft: a PG error yields empty rows, not a 500', async () => {
    sqlImpl = async () => {
      throw new Error('relation harness_shared.test_runs does not exist');
    };
    const { status, body } = await get('my-hive', '?filePath=src/foo.test.ts');
    expect(status).toBe(200);
    expect(body?.rows).toEqual([]);
  });

  it('clamps limit into [1,200]', async () => {
    captured.length = 0;
    sqlImpl = async (_s, ...values) => {
      captured.push(values);
      return [];
    };
    await get('h', '?filePath=x&limit=99999');
    expect(captured[0][3]).toBe(200);
    captured.length = 0;
    await get('h', '?filePath=x&limit=0');
    expect(captured[0][3]).toBe(20); // 0 → falsy → default 20
  });
});
