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

const repairQueueModule = await import('./repair-queue');
const tool = repairQueueModule.default;
const { assessFrozenRepairFixerAuthorization } = repairQueueModule;
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
  it('makes its workspace-global scope explicit to prevent caller harness arguments', () => {
    expect(tool.description).toContain('Workspace-global');
    expect(tool.description).toContain('omit harness/workspace');
    expect(tool.guidance?.notWhen).toContain('Do not pass harness or workspace');
  });

  it('get exposes one normalized queue and never advertises retire for a recoverable one', async () => {
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
    // WI-1586801: this fixture is a dead-fixer queue, so retirement is permitted but the
    // decision is `recover-dead-fixer`. The tool must surface the safe verb, not a
    // paste-ready call that would destroy a queue the gate is about to recover.
    expect(result.repairQueue.nextAction).not.toContain('expectedUpdatedAtMs: 2');
    expect(result.repairQueue.nextAction).toContain("op: 'converge'");
    expect(result.callerAuthorization).toMatchObject({
      status: 'not-applicable',
      authorized: null,
    });
  });

  it('authorizes only the exact verified signed fixer delegated by the queue', async () => {
    const authorized = assessFrozenRepairFixerAuthorization(queue, {
      role: 'release-fixer',
      spawnId: 'fixer-1',
      sigVerifiedSpawn: true,
    });
    expect(authorized).toMatchObject({
      status: 'authorized-delegate',
      authorized: true,
      callerSpawnId: 'fixer-1',
      queueFixerSpawnId: 'fixer-1',
    });
    expect(authorized.safeAction).toContain('delegator, not a competing fixer');

    expect(
      assessFrozenRepairFixerAuthorization(queue, {
        role: 'release-fixer',
        spawnId: 'fixer-2',
        sigVerifiedSpawn: true,
      }),
    ).toMatchObject({ status: 'different-fixer', authorized: false });
    expect(
      assessFrozenRepairFixerAuthorization(queue, {
        role: 'release-fixer',
        spawnId: 'fixer-1',
        sigVerifiedSpawn: false,
      }),
    ).toMatchObject({ status: 'unsigned-caller', authorized: false });
  });

  it('get derives the authorization verdict from the handler signed-spawn context', async () => {
    const result = body(
      await tool.handler(
        { op: 'get' } as never,
        { role: 'release-fixer', spawnId: 'fixer-1', sigVerifiedSpawn: true } as never,
      ),
    );
    expect(result.callerAuthorization).toMatchObject({
      status: 'authorized-delegate',
      authorized: true,
      callerSpawnId: 'fixer-1',
    });
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

  it('rechecks replacement fixer liveness after a CAS miss before rendering its diagnostic', async () => {
    const replacement = { ...queue, fixerSpawnId: 'fixer-2', updatedAtMs: 3 };
    mocks.retire.mockResolvedValueOnce({ retired: false, current: replacement });
    mocks.alive.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

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

    expect(mocks.alive).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      casMiss: true,
      reason: 'cas-miss',
      current: {
        fixerSpawnId: 'fixer-2',
        fixerAlive: false,
        retireAllowed: true,
        retireRefusal: null,
      },
    });
  });

  it('fails closed when a replacement fixer becomes liveness-unknown after the preflight proves the old fixer dead', async () => {
    const replacement = { ...queue, fixerSpawnId: 'fixer-2', updatedAtMs: 3 };
    mocks.retire.mockResolvedValueOnce({ retired: false, current: replacement });
    // The first read authorizes the attempted retirement of the old dead fixer. The second read
    // observes a replacement whose liveness is unavailable; that must remain a refusal, never a
    // retry or an inferred death.
    mocks.alive.mockResolvedValueOnce(false).mockResolvedValueOnce(null);

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

    expect(mocks.retire).toHaveBeenCalledTimes(1);
    expect(mocks.alive).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      casMiss: true,
      reason: 'cas-miss',
      current: {
        fixerSpawnId: 'fixer-2',
        fixerAlive: null,
        retireAllowed: false,
        retireRefusal: 'liveness-unknown',
      },
    });
  });
});
