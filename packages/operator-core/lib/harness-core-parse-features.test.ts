import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getLegacyClient: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getLegacyClient: dbMocks.getLegacyClient,
}));

import { parseFeatures, STREAM_FEATURE_SELECT_COLUMNS } from './harness-core';

describe('parseFeatures projections', () => {
  const all = vi.fn();
  const prepare = vi.fn((_sql: string) => ({ all }));

  beforeEach(() => {
    vi.clearAllMocks();
    all.mockResolvedValue([]);
    dbMocks.getLegacyClient.mockReturnValue({ prepare });
  });

  it('uses the bounded Run-view column set for the stream projection', async () => {
    await parseFeatures(
      { slug: 'large-harness' } as never,
      { projection: 'stream' },
    );

    const sql = String(prepare.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain(`SELECT ${STREAM_FEATURE_SELECT_COLUMNS} FROM harness_features`);
    expect(sql).not.toContain('SELECT *');
    expect(all).toHaveBeenCalledWith('large-harness');
  });

  it('preserves the full-row default for existing callers', async () => {
    await parseFeatures({ slug: 'ordinary-harness' } as never);

    const sql = String(prepare.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
    expect(sql).toContain('SELECT * FROM harness_features');
  });
});
