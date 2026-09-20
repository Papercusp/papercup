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
    M.sql.mockResolvedValue([{ feature_id: 'WI-ACCEPTANCE', harness_slug: 'papercusp' }]);
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

  it('replaces a pending handoff observation in-place without minting or reassigning', async () => {
    M.sql.mockResolvedValueOnce([{
      feature_id: 'WI-ACCEPTANCE', harness_slug: 'papercusp', gate_observation: 'pending',
    }]);
    const result = await ensureAcceptanceDrainFiling(input);
    expect(result).toMatchObject({ outcome: 'already-open', id: 'WI-ACCEPTANCE' });
    expect(M.upsert).not.toHaveBeenCalled();
    const [parts, ...values] = M.sql.mock.calls[1]!;
    const statement = (parts as TemplateStringsArray).join('?');
    expect(statement).toContain('UPDATE harness_shared.work_items');
    expect(statement).toContain("payload->>'gateObservation' = 'pending'");
    expect(statement).toContain('workspace_id =');
    expect(statement).toContain('harness_slug =');
    expect(statement).not.toContain('taken_by =');
    expect(values).toContain('acceptance_unaudited');
  });
});
