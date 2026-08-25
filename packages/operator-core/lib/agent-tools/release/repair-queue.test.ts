import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue = {
  schemaVersion: 3 as const,
  phase: 'awaiting-fixer' as const,
  candidate: 'a'.repeat(40),
  base: 'b'.repeat(40),
  repairHead: 'c'.repeat(40),
  worktreePath: '/tmp/repair',
  attempts: 1,
  openedAtMs: 1,
  updatedAtMs: 2,
  fixerSpawnId: 'fixer-1',
  failingTests: ['lib/red.test.ts'],
};
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  retire: vi.fn(),
  alive: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: mocks.read,
  retireFrozenCandidateRepairQueue: mocks.retire,
}));
vi.mock('../../release/fixer-liveness', () => ({ releaseFixerSpawnAlive: mocks.alive }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('../locks/identity', () => ({ readIdentity: async () => ({ ownerId: 'su-test' }) }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: mocks.audit } }),
}));

const tool = (await import('./repair-queue')).default;
type Out = { content: { text: string }[] };
const body = (value: unknown) => JSON.parse((value as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(queue);
  mocks.alive.mockResolvedValue(false);
  mocks.retire.mockResolvedValue({ retired: true, current: null });
  mocks.audit.mockResolvedValue([]);
});

describe('release:repair-queue', () => {
  it('get exposes one normalized queue with an exact retirement action', async () => {
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: true,
      target: { workspaceId: 'ws-1', installSlug: 'papercusp' },
      repairQueue: {
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        fixerAlive: false,
        retireAllowed: true,
      },
    });
    expect(result.repairQueue.nextAction).toContain('expectedUpdatedAtMs: 2');
  });

  it('refuses retirement while the fixer is live', async () => {
    mocks.alive.mockResolvedValue(true);
    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: queue.repairHead,
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: true, reason: 'live-fixer' });
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('is dry-run by default and executes only the exact inspected queue with confirm:true', async () => {
    const args = {
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
    } as const;
    expect(body(await tool.handler(args as never, { role: 'su' } as never))).toMatchObject({
      ok: true,
      dryRun: true,
      retired: false,
    });
    expect(mocks.retire).not.toHaveBeenCalled();

    const result = body(
      await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never),
    );
    expect(mocks.retire).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      queue,
    );
    expect(result).toMatchObject({ ok: true, retired: true, auditRecorded: true });
  });

  it('refuses a stale caller identity before the storage CAS', async () => {
    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: 'd'.repeat(40),
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, reason: 'exact_queue_identity_mismatch' });
    expect(mocks.retire).not.toHaveBeenCalled();
  });
});
