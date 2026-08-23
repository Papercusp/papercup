import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createPgCensusStore } from './pg-store';

type ExistingRow = {
  id: string;
  kind: string;
  surface_id: string;
  provider: string;
  fidelity: string;
  source_file: string | null;
  retired_at: Date | string | null;
};

function fakeSql(rows: ExistingRow[]): postgres.Sql {
  return (async () => rows) as unknown as postgres.Sql;
}

describe('createPgCensusStore — reads', () => {
  it('normalizes text timestamps returned by the Postgres driver', async () => {
    const sql = fakeSql([
      {
        id: '7',
        kind: 'http-route',
        surface_id: 'GET /api/retired',
        provider: 'hono-routes',
        fidelity: 'declared',
        source_file: null,
        retired_at: '2026-08-23 19:52:48.260+00',
      },
    ]);
    const store = createPgCensusStore({ getSql: () => sql });

    await expect(
      store.loadExisting({ workspaceId: 'workspace', harnessSlug: 'papercusp' }),
    ).resolves.toEqual([
      {
        id: 7,
        kind: 'http-route',
        surfaceId: 'GET /api/retired',
        provider: 'hono-routes',
        fidelity: 'declared',
        sourceFile: null,
        retiredAt: '2026-08-23T19:52:48.260Z',
      },
    ]);
  });
});
