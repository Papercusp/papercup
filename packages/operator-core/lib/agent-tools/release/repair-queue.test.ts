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
  write: vi.fn(),
  alive: vi.fn(),
  audit: vi.fn(),
  assessConverge: vi.fn(),
}));
vi.mock('../../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: mocks.read,
  retireFrozenCandidateRepairQueue: mocks.retire,
  writeFrozenCandidateRepairQueue: mocks.write,
}));
vi.mock('../../release/fixer-liveness', () => ({ releaseFixerSpawnAlive: mocks.alive }));
vi.mock('../../release/converge-repair-head', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/converge-repair-head')>()),
  assessConvergeRepairHead: mocks.assessConverge,
}));
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

  // EI-22208176411693669: assessFrozenRepairFixerAuthorization correctly labels the
  // SU-bearer transport 'not-applicable' (never 'authorized-delegate') because that
  // transport carries no verified per-spawn signature regardless of its cosmetic
  // ?role= catalog hint. But the converge write-gate is a SEPARATE `if` a few lines
  // below callerAuthorization, and before this fix it independently required
  // role==='su' OR an OPERATOR_CONFIG_WRITE_ROLE OR authorized===true — none of which
  // a superuser caller whose ?role= was forwarded as 'release-fixer' satisfied — so it
  // was thrown out of convergence even though dispatch on that transport is already
  // unconditional. This pins that the write-gate itself, not just the label, bypasses.
  it('EI-22208176411693669: an isSuperuser caller may converge even when its cosmetic role hint is release-fixer', async () => {
    mocks.assessConverge.mockReturnValue({
      verdict: 'would-converge',
      newRepairHead: 'd'.repeat(40),
      judgedSha: 'd'.repeat(40),
      nextAction: null,
    });
    mocks.write.mockResolvedValue(undefined);
    const result = body(
      await tool.handler(
        { op: 'converge', confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: true,
          spawnId: 'fixer-1',
          sigVerifiedSpawn: false,
        } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, converged: true, persisted: true });
    expect(result.callerAuthorization).toMatchObject({ status: 'not-applicable', authorized: null });
    expect(mocks.write).toHaveBeenCalled();
  });

  // Control for the test above: a non-superuser release-fixer that is NOT the
  // queue-delegated fixer must still be refused. This is what proves the fix bypasses
  // on isSuperuser specifically, rather than having widened the gate for every
  // release-fixer-labelled caller.
  it('control: a non-superuser caller with an unverified or mismatched release-fixer identity is still refused convergence', async () => {
    mocks.assessConverge.mockReturnValue({
      verdict: 'would-converge',
      newRepairHead: 'd'.repeat(40),
      judgedSha: 'd'.repeat(40),
      nextAction: null,
    });
    await expect(
      tool.handler(
        { op: 'converge', confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: false,
          spawnId: 'fixer-2',
          sigVerifiedSpawn: true,
        } as never,
      ),
    ).rejects.toThrow(/requires operator, architect, mug, su/);
    expect(mocks.write).not.toHaveBeenCalled();
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

  // WI-1105109 [owner 2026-08-30, OWNER-interactive]: "How can we make sure another
  // agent uses the frozen candidate system next and doesn't retire it like you did."
  //
  // The recorded failure was NOT the retire — that one was provably correct. It was
  // firing release:checkpoint-run twice immediately AFTER it, each cutting a fresh
  // candidate at tip: the re-cut-at-tip treadmill D-007 diagnosed, reintroduced by hand
  // moments after clearing the thing that prevents it. `notWhen` already forbids this,
  // but guidance is read BEFORE the call while the mistake happens AFTER it — so the
  // procedure has to ride on the RESULT the caller is holding when they pick their next
  // move. This pins that it does.
  it('states the post-retire procedure on a SUCCESSFUL retire, and only then (WI-1105109)', async () => {
    const args = {
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
    } as const;

    const retired = body(
      await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never),
    ) as { retired?: boolean; nextStep?: string };
    expect(retired.retired).toBe(true);
    expect(
      retired.nextStep,
      'a successful retire must carry the next-step procedure, not leave it to guidance',
    ).toEqual(expect.any(String));
    // The two facts that actually prevent the treadmill: the gate re-freezes by itself,
    // and checkpoint-run is NOT the lever to restart it.
    expect(retired.nextStep).toMatch(/re-?freez/i);
    expect(retired.nextStep).toMatch(/release:checkpoint-run/);
    expect(retired.nextStep).toMatch(/converge/);

    // CONTROL — the assertions above are all "field is present and matches", so they
    // would pass just as well if `nextStep` were emitted unconditionally on every
    // branch, which would make it noise rather than a signal about what just happened.
    // A dry run retires NOTHING, so it must NOT claim a post-retire procedure.
    const dryRun = body(await tool.handler(args as never, { role: 'su' } as never)) as {
      retired?: boolean;
      nextStep?: string;
    };
    expect(dryRun.retired).toBe(false);
    expect(
      dryRun.nextStep,
      'control: nothing was retired, so there is no post-retire step to state',
    ).toBeUndefined();
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
