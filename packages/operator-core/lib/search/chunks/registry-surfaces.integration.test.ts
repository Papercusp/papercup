/**
 * Every shared-store registry entry (./registry.ts CHUNK_SURFACES) runs its sync
 * and prune SQL against the REAL schema without an error.
 *
 * Recurrence guard for a class, not one entry: an entry's SQL (key columns and
 * their types, textSql, headerSql, eligibleSql, versionSql) is only checked by
 * Postgres at run time, and the engine is fail-open — a failing prune is logged
 * and counted, never thrown. The operator-turns entry shipped with an untyped
 * uuid key whose prune failed on every tick with "operator does not exist:
 * uuid = text" (found by the first live sync, 2026-09-30). This runs each entry
 * with its eligibility ANDed with false and a private surface name, so it reads
 * and deletes nothing, yet Postgres still parses and plans every statement.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import type { ChunkSurface, ChunkSyncLogger, ChunkSyncResult } from '@papercusp/search';
import { CHUNK_SURFACES } from './registry';
import { runChunkSyncTick } from './tick';

const TAG = `${process.pid}_${Date.now()}`;
// Entries with their own store (session turns, P-007) are covered by
// session-turn-parity.integration.test.ts.
const SHARED = CHUNK_SURFACES.filter((s) => !s.store);

describe('registry entries against the real schema', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'chunks/registry-surfaces.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it('there are shared-store entries to check', () => {
    expect(SHARED.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SHARED.map((s) => [s.surface, s] as const))('%s: sync and prune run with no error', async (_name, entry) => {
    const logged: string[] = [];
    const logger: ChunkSyncLogger = {
      warn: () => {},
      error: (message, meta) => logged.push(`${message} ${JSON.stringify(meta)}`),
    };
    const probe: ChunkSurface = {
      ...entry,
      surface: `it-reg-${entry.surface}-${TAG}`,
      eligibleSql: entry.eligibleSql ? `(${entry.eligibleSql}) AND false` : 'false',
    };
    const res = await runChunkSyncTick({ sql, surfaces: [probe], logger });
    expect(res).toHaveProperty('surfaces');
    const st = (res as ChunkSyncResult).surfaces[0]!;
    expect(logged).toEqual([]);
    expect(st).toMatchObject({ errors: 0, parentsSynced: 0 });
  });
});
