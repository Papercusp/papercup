/**
 * WI-4297 migration contract guard. The historical counter repair must have
 * its own cursor and completion marker; resetting byte_offset would replay
 * indexed turns and can create duplicate turn-index conflicts.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/libs/db/sql/601-session-ingest-counts-backfill.sql',
);

describe('WI-4297 historical counter backfill migration', () => {
  it('uses an independent resumable cursor and never resets the indexed cursor', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('counts_backfill_offset BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('counts_backfilled_at TIMESTAMPTZ');
    expect(migration).toContain('counts_backfilled_at IS NULL');
    expect(migration).not.toMatch(/SET\s+byte_offset\s*=\s*0/i);
  });
});
