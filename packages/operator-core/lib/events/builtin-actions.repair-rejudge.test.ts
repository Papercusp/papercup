import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readQueue: vi.fn(),
  requeue: vi.fn(),
  sql: { unsafe: vi.fn() },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: async (_workspaceId: string, fn: () => unknown) => fn(),
  getOrgPg: () => ({ sql: mocks.sql }),
}));

vi.mock('../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: (...args: unknown[]) => mocks.readQueue(...args),
  requeueGreenCheckpointAfterCapacity: (...args: unknown[]) => mocks.requeue(...args),
}));

import {
  fireBuiltinReactionAction,
  GATE_REJUDGE_ADMITTED_REPAIR_ACTION,
} from './builtin-actions';

const candidate = 'a'.repeat(40);
const repairHead = 'b'.repeat(40);
const args = { candidate, repairHead, installSlug: 'papercusp' };

beforeEach(() => {
  mocks.readQueue.mockReset();
  mocks.requeue.mockReset();
  mocks.readQueue.mockResolvedValue({ candidate, repairHead });
  mocks.requeue.mockResolvedValue(undefined);
});

describe('P-001 gate.rejudgeAdmittedRepair builtin', () => {
  it('validates the live queue tuple, then pulls the existing routine due now', async () => {
    await expect(
      fireBuiltinReactionAction(GATE_REJUDGE_ADMITTED_REPAIR_ACTION, args, 'papercusp-workspace'),
    ).resolves.toEqual({ ok: true });
    expect(mocks.readQueue).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
    });
    expect(mocks.requeue).toHaveBeenCalledWith(mocks.sql, 'papercusp', 0);
  });

  it('does not schedule a stale, replaced, or retired queue event', async () => {
    for (const queue of [null, { candidate, repairHead: 'c'.repeat(40) }, { candidate: 'd'.repeat(40), repairHead }]) {
      mocks.readQueue.mockResolvedValueOnce(queue);
      await expect(
        fireBuiltinReactionAction(GATE_REJUDGE_ADMITTED_REPAIR_ACTION, args, 'papercusp-workspace'),
      ).resolves.toEqual({ ok: true });
    }
    expect(mocks.requeue).not.toHaveBeenCalled();
  });

  it('fails explicitly when the durable reaction payload is malformed', async () => {
    const result = await fireBuiltinReactionAction(
      GATE_REJUDGE_ADMITTED_REPAIR_ACTION,
      { candidate, repairHead },
      'papercusp-workspace',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('requires candidate, repairHead, and installSlug');
  });
});
