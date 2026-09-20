import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sql: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: M.sql }) };
});
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: M.upsert,
}));

import { ensureAcceptanceDrainFiling } from './acceptance-drain-filing';

const input = {
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  planSlug: 'drained-plan',
  code: 'acceptance_unaudited',
  message: 'run plans:audit',
};

describe('ensureAcceptanceDrainFiling — P-023 characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    M.sql.mockResolvedValue([{ ref: 'papercusp-workspace/papercusp/drained-plan' }]);
  });

  it('returns already-open without refreshing the live blocker or accountability evidence', async () => {
    const result = await ensureAcceptanceDrainFiling(input);

    expect(result).toEqual({
      outcome: 'already-open',
      id: null,
      ref: 'papercusp-workspace/papercusp/drained-plan',
    });
    expect(M.upsert).not.toHaveBeenCalled();
  });
});
