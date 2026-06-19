/**
 * check_drift.test.ts — the db:check_drift HANDLER (checkMigrationDrift mocked). Pins the
 * snake_case projection of the drift report: in_sync, missing, extra, and the COUNTS
 * derived from the onDisk/applied arrays (on_disk_count / applied_count). A regression
 * that swaps missing/extra or mis-counts is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/db/check_drift.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../migration-drift', () => ({ checkMigrationDrift: vi.fn() }));

import { checkMigrationDrift } from '../../migration-drift';
const driftM = vi.mocked(checkMigrationDrift);
const tool = (await import('./check_drift')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('db:check_drift handler', () => {
  it('projects the drift report into the snake_case shape with derived counts', async () => {
    driftM.mockResolvedValue({
      inSync: false,
      missing: ['230-x.sql'],
      extra: [],
      onDisk: ['1.sql', '2.sql', '230-x.sql'],
      applied: ['1.sql', '2.sql'],
      sqlDir: '/sql',
    } as never);
    const out = (await tool.handler({} as never, {} as never)) as Out;
    expect(body(out)).toMatchObject({
      ok: true,
      in_sync: false,
      missing: ['230-x.sql'],
      extra: [],
      on_disk_count: 3,
      applied_count: 2,
      sql_dir: '/sql',
    });
  });
});
