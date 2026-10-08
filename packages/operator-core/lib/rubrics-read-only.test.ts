import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn(), boundedPgReadTxn: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql as never }),
  };
});

vi.mock('./pg-read-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pg-read-query')>();
  return {
    ...actual,
    boundedPgReadTxn: (...args: unknown[]) => h.boundedPgReadTxn(...args),
  };
});

const { getRubricWithoutSeeding } = await import('./rubrics');

describe('getRubricWithoutSeeding', () => {
  beforeEach(() => {
    h.sql.mockReset();
    h.boundedPgReadTxn.mockReset();
    h.boundedPgReadTxn.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) => run(h.sql),
    );
  });

  it.each([
    ['missing row', []],
    ['malformed row', [{
      plan_slug: 'malformed-rubric',
      workspace_id: 'workspace-test',
      harness_slug: 'papercusp',
      title: 'Malformed rubric',
      status: 'active',
      created: new Date('2026-01-01T00:00:00.000Z'),
      updated: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
      version: '1',
      owner: 'su-test',
      archived: false,
      template_data: null,
    }]],
  ])('%s returns null without scanning the seedable rubric library', async (_label, rows) => {
    h.sql.mockResolvedValue(rows);

    await expect(getRubricWithoutSeeding('malformed-rubric')).resolves.toBeNull();

    // The helper performs one direct id lookup. A regression to getRubric's broad
    // fallback would issue a second rubric-library query (and can trigger seeding).
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function));
    expect(h.sql).toHaveBeenCalledTimes(1);
  });
});
