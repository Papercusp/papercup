import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql as never }),
  };
});

const { getRubricWithoutSeeding } = await import('./rubrics');

describe('getRubricWithoutSeeding', () => {
  beforeEach(() => {
    h.sql.mockReset();
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
    expect(h.sql).toHaveBeenCalledTimes(1);
  });
});
