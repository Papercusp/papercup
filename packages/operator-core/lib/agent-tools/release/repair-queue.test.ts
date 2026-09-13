import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drainDetached } from '../../detached-imports';
import { checkpointRootMirror } from '../../release-checkpoint-launch';

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
  signature: [],
  admissionPrecheck: {
    schemaVersion: 1 as const,
    operationId: 'repair-precheck-fixture',
    status: 'passed' as const,
    candidate: 'a'.repeat(40),
    repairHead: 'c'.repeat(40),
    builtCommit: 'd'.repeat(40),
    builtTree: 'f'.repeat(40),
    files: ['lib/red.test.ts'],
    actor: 'su-test',
    startedAtMs: 1,
    updatedAtMs: 2,
    expiresAtMs: 60_002,
    verdict: {
      ok: true as const,
      ran: true as const,
      commit: 'd'.repeat(40),
      population: {
        signatureTestFiles: [],
        admittedTestFiles: ['lib/red.test.ts'],
        nonTestKinds: [],
        canProveDoesNotFix: false,
        files: ['lib/red.test.ts'],
      },
      results: [{ path: 'lib/red.test.ts', status: 'pass' as const }],
      passing: ['lib/red.test.ts'],
      failing: [],
      unmeasured: [],
      fixes: [],
    },
  },
};
const NEW_HEAD = 'd'.repeat(40);
const ALT_HEAD = 'e'.repeat(40);
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readState: vi.fn(),
  retire: vi.fn(),
  write: vi.fn(),
  alive: vi.fn(),
  audit: vi.fn(),
  admit: vi.fn(),
  admissionGit: vi.fn(),
  retract: vi.fn(),
  containment: vi.fn(),
  presence: vi.fn(),
  // P-020: the hunk-exact source builder + the ledger read the admit op consults first.
  hunkExact: vi.fn(),
  committedPatch: vi.fn(),
  foreign: vi.fn(),
  ledger: vi.fn(),
  importPreflight: vi.fn(),
  // P-006 (R6): the admit door's two-phase pre-check seam — the runner FACTORY the door
  // creates for the canonical root, and the root canonicalization it consults first.
  precheckFactory: vi.fn(),
  canonicalRoot: vi.fn(),
  transition: vi.fn(),
}));
vi.mock('../../harness/routines/release-actions', () => ({
  applyFrozenCandidateRepairQueueTransition: mocks.transition,
  readFrozenCandidateRepairQueue: mocks.read,
  readFrozenCandidateRepairQueueState: mocks.readState,
  retireFrozenCandidateRepairQueue: mocks.retire,
  writeFrozenCandidateRepairQueue: mocks.write,
}));
vi.mock('../../release/fixer-liveness', () => ({ releaseFixerSpawnAlive: mocks.alive }));
vi.mock('../../release-deploy-launch', () => ({ integrationRoot: () => '/repo' }));
vi.mock('../../release/frozen-lineage-ledger-reconcile', () => ({
  reconcileFrozenRepairQueueWithLineageRef: (current: unknown) => ({
    status: 'in-sync',
    queue: current,
    detail: 'fixture lineage is in sync',
    reconciled: [],
  }),
}));
vi.mock('../../release/admission-fix-precheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/admission-fix-precheck')>()),
  createCheckpointTreeFixPrecheckRunner: mocks.precheckFactory,
  resolveCanonicalIntegrationRoot: mocks.canonicalRoot,
}));
vi.mock('../../release/judged-sha-containment', () => ({
  integrationBranch: () => 'staging',
  containmentForPaths: mocks.containment,
}));
vi.mock('../../release/repair-head-admission', () => ({
  admitPathsOntoRepairHead: mocks.admit,
  realAdmissionGit: mocks.admissionGit,
  retractAdmission: mocks.retract,
}));
vi.mock('../../release/hunk-exact-admission', () => ({
  buildHunkExactSource: mocks.hunkExact,
  buildCommittedPatchSource: mocks.committedPatch,
  summarizeForeignHunks: mocks.foreign,
}));
vi.mock('../../release/frozen-repair-edit-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-repair-edit-ledger')>()),
  readFrozenRepairEditLedger: mocks.ledger,
}));
vi.mock('../../release/admission-import-completeness', () => ({
  importCompletenessPreflight: mocks.importPreflight,
}));
/** P-020: what the hunk-exact builder returns for a clean single-path replay. */
const HX_SOURCE = 'h'.repeat(40);
const hunkExactOf = (paths = ['lib/red.test.ts']) => ({
  ok: true as const,
  sourceCommit: HX_SOURCE,
  tree: 'x'.repeat(40),
  perPath: paths.map((path) => ({
    path,
    applied: 1,
    agents: ['su-test'],
    foreignHunks: 0,
    foreignAgents: [] as string[],
    baseBlob: null,
    blob: 'f'.repeat(40),
    unchanged: false,
  })),
  allUnchanged: false,
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('../locks/identity', () => ({ readIdentity: () => ({ ownerId: 'su-test' }) }));
// P-021 claim-leg: claiming a leg claims its paths — the caller's presence current_files.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su · test', workspaceId: 'ws-1' }),
}));
vi.mock('../coordination/presence', () => ({ writePresence: mocks.presence }));

/** A P-021 repair manifest with one red test-file leg whose subject path is known. */
const manifestRow = {
  legId: 'test-file:lib/red.test.ts',
  kind: 'test-file' as const,
  recipe: 'npm run test:file -- lib/red.test.ts',
  subjectPaths: ['lib/red.test.ts'],
  subjectPathsTruncated: 0,
  subjectSource: 'leg-id' as const,
  status: { kind: 'red-at-candidate' as const },
  statusLabel: 'red-at-candidate',
  admitCommand: "release:repair-queue { op:'admit', paths:['lib/red.test.ts'] }",
  claim: null,
};
const manifest = {
  schemaVersion: 1 as const,
  candidate: queue.candidate,
  repairHead: queue.repairHead,
  signatureFingerprint: 'fp-1',
  builtAtMs: 5,
  rows: [manifestRow],
  rowsTruncated: 0,
};
const queueWithManifest = { ...queue, manifest };

/** What the P-001 primitive returns for a clean single-path admission onto the fixture queue. */
const admissionOf = (published: boolean, paths = ['lib/red.test.ts'], commit = NEW_HEAD) => ({
  ok: true as const,
  commit,
  tree: 'f'.repeat(40),
  diff: paths,
  unchanged: [] as string[],
  lineageRef: `refs/papercusp/frozen/${'a'.repeat(40)}`,
  published,
  entry: {
    atMs: 10,
    actor: 'su-test',
    source: { ref: 'staging', sha: 'e'.repeat(40) },
    fromRepairHead: 'c'.repeat(40),
    toRepairHead: commit,
    paths,
    unchanged: [] as string[],
    blobs: Object.fromEntries(paths.map((p) => [p, 'f'.repeat(40)])),
  },
});
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
  mocks.readState.mockResolvedValue({ status: 'value', queue });
  mocks.alive.mockResolvedValue(false);
  mocks.retire.mockResolvedValue({ retired: true, current: null });
  mocks.audit.mockResolvedValue([]);
  mocks.write.mockResolvedValue(undefined);
  mocks.transition.mockImplementation(async (_target, transition) => ({
    status: 'written',
    queue: transition((mocks.write.mock.calls.at(-1)?.[1] ?? queue) as typeof queue),
    fresh: (mocks.write.mock.calls.at(-1)?.[1] ?? queue) as typeof queue,
    retries: 0,
  }));
  mocks.presence.mockResolvedValue(undefined);
  mocks.retract.mockReturnValue(true);
  mocks.admissionGit.mockReturnValue({ status: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' });
  mocks.ledger.mockResolvedValue([]);
  mocks.foreign.mockReturnValue({ count: 0, agents: [], byPath: {} });
  mocks.importPreflight.mockReturnValue(() => null);
  mocks.hunkExact.mockReturnValue(hunkExactOf());
  mocks.canonicalRoot.mockImplementation((root: string) => root);
  mocks.precheckFactory.mockReturnValue(async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
    ran: true as const,
    commit,
    results: files.map((path) => ({ path, status: 'pass' as const })),
  }));
  mocks.containment.mockImplementation((paths: string[], judgedSha: string) =>
    paths.map((path) => ({ path, containedInJudgedSha: judgedSha === NEW_HEAD, judgedBlob: null, stagingBlob: null })),
  );
});

describe('release:repair-queue', () => {
  it('makes its workspace-global scope explicit to prevent caller harness arguments', () => {
    expect(tool.description).toContain('Workspace-global');
    expect(tool.description).toContain('omit harness/workspace');
    expect(tool.guidance?.notWhen).toContain('never pass harness/workspace');
  });

  it('defaults an empty args object to get while preserving strict branch validation', () => {
    const omittedOp = tool.args.safeParse({});
    expect(omittedOp.success).toBe(true);
    expect(omittedOp.success && omittedOp.data).toEqual({ op: 'get' });
    expect(tool.args.safeParse({ op: 'admit' }).success).toBe(false);
    expect(tool.args.safeParse({ op: 'retire' }).success).toBe(false);
    expect(tool.effectForCall?.({} as never)).toBe('read');
    expect(tool.effectForCall?.({ op: 'admit', confirm: false } as never)).toBe('read');
    expect(tool.effectForCall?.({ op: 'admit', confirm: true } as never)).toBe('write');
  });

  it('accepts the complete queue identity tuple on admit/converge and rejects partial tuples', () => {
    const identity = {
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };
    expect(tool.args.safeParse({ op: 'admit', paths: ['lib/red.test.ts'], ...identity }).success).toBe(true);
    expect(tool.args.safeParse({ op: 'converge', paths: ['lib/red.test.ts'], ...identity }).success).toBe(true);
    for (const missing of Object.keys(identity) as Array<keyof typeof identity>) {
      const partial = { ...identity };
      delete partial[missing];
      expect(tool.args.safeParse({ op: 'admit', paths: ['lib/red.test.ts'], ...partial }).success).toBe(false);
      expect(tool.args.safeParse({ op: 'converge', paths: ['lib/red.test.ts'], ...partial }).success).toBe(false);
    }
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
    expect(result.repairQueue.nextAction).toContain("op: 'admit'");
    expect(result.callerAuthorization).toMatchObject({
      status: 'not-applicable',
      authorized: null,
    });
  });

  it('P-025: get renders a newer-schema queue as unreadable instead of null/none', async () => {
    mocks.readState.mockResolvedValue({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: 5,
    });
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: true,
      op: 'get',
      repairQueue: {
        status: 'unreadable',
        reason: 'schema-newer-than-reader',
        schemaVersion: 5,
      },
      repairQueueRead: { status: 'unreadable' },
      callerAuthorization: { status: 'queue-unreadable', authorized: false },
    });
  });

  it.each([
    ['admit', { op: 'admit', paths: ['lib/red.test.ts'], confirm: true }],
    [
      'retire',
      {
        op: 'retire',
        expectedCandidate: queue.candidate,
        expectedRepairHead: queue.repairHead,
        expectedUpdatedAtMs: queue.updatedAtMs,
        reason: 'owner-authorized retirement',
        confirm: true,
      },
    ],
  ] as const)('P-025: %s refuses an unreadable queue without mutating anything', async (op, args) => {
    mocks.readState.mockResolvedValue({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: 5,
    });
    const result = body(await tool.handler(args as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: false,
      op,
      refused: true,
      reason: 'repair-queue-unreadable',
      repairQueue: { status: 'unreadable', schemaVersion: 5 },
    });
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.retire).not.toHaveBeenCalled();
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

  // ---- admit: THE door onto the judged lineage (P-002 / D-004 / D-010) -------------------

  it('admit REFUSES without paths, touching neither git nor the row — an admission is by explicit allowlist', async () => {
    const result = body(await tool.handler({ op: 'admit' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({ ok: false, op: 'admit', refused: true, reason: 'paths_required', admitted: false });
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('admit reports no-frozen-queue when nothing is frozen, and builds nothing', async () => {
    mocks.readState.mockResolvedValue({ status: 'absent' });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({ ok: true, op: 'admit', verdict: 'no-frozen-queue', admitted: false });
    expect(result.nextAction).toMatch(/Do not fire release:checkpoint-run/);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it('dry run: the primitive builds + proves with dryRun:true onto the CURRENT repairHead, and nothing is published or persisted', async () => {
    mocks.admit.mockReturnValue(admissionOf(false));
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
    );
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    expect(mocks.admit.mock.calls[0]![0]).toMatchObject({
      root: '/repo',
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      paths: ['lib/red.test.ts'],
      // P-020: the primitive admits from the synthesised hunk-exact source, never the tip.
      source: { ref: HX_SOURCE },
      actor: 'su-test',
      dryRun: true,
    });
    expect(result).toMatchObject({
      ok: true,
      op: 'admit',
      dryRun: true,
      admitted: false,
      verdict: 'would-admit',
      judgedSha: queue.repairHead,
      wouldMoveRepairHead: { from: queue.repairHead, to: NEW_HEAD },
      proof: { diff: ['lib/red.test.ts'], unchanged: [] },
    });
    expect(result.note).toMatch(/confirm:true/);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.retract).not.toHaveBeenCalled();
  });

  it('rejects a stale expected queue identity before reading the edit ledger or building an admission', async () => {
    const result = body(
      await tool.handler(
        {
          op: 'admit',
          paths: ['lib/red.test.ts'],
          expectedCandidate: queue.candidate,
          expectedRepairHead: 'd'.repeat(40),
          expectedUpdatedAtMs: queue.updatedAtMs,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      reason: 'exact_queue_identity_mismatch',
      currentQueueIdentity: {
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        updatedAtMs: queue.updatedAtMs,
      },
    });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.hunkExact).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('confirm:true publishes, marks the queue ADMITTED (repairHead moved, phase ready-to-verify, ledger entry), persists and audits', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const result = body(
      await tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, reason: 'gate red on this file' } as never,
        { role: 'su' } as never,
      ),
    );
    // R6 two-phase: the LAST admission call is the publish (the first is the measured build).
    expect(mocks.admit.mock.calls.at(-1)![0]).toMatchObject({ dryRun: false, reason: 'gate red on this file' });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [target, written] = mocks.write.mock.calls[0]!;
    expect(target).toEqual({ workspaceId: 'ws-1', installSlug: 'papercusp' });
    expect(written).toMatchObject({
      candidate: queue.candidate,
      repairHead: NEW_HEAD,
      phase: 'ready-to-verify',
      admissions: [{ fromRepairHead: queue.repairHead, toRepairHead: NEW_HEAD, paths: ['lib/red.test.ts'] }],
    });
    expect(result).toMatchObject({
      ok: true,
      op: 'admit',
      admitted: true,
      verdict: 'admitted',
      persisted: true,
      auditRecorded: true,
      judgedSha: NEW_HEAD,
      movedRepairHead: { from: queue.repairHead, to: NEW_HEAD },
      repairQueue: { repairHead: NEW_HEAD, phase: 'ready-to-verify' },
    });
    // Containment is reported against the NEW judged sha, where the path is now carried.
    expect(result.containment).toEqual([
      expect.objectContaining({ path: 'lib/red.test.ts', containedInJudgedSha: true }),
    ]);
    expect(result.nextAction).toMatch(/Do NOT fire release:checkpoint-run/);
    expect(mocks.retract).not.toHaveBeenCalled();
    // The audit row names the admission, never a tip.
    const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
    expect(auditDetails).toMatchObject({
      op: 'admit',
      from: queue.repairHead,
      to: NEW_HEAD,
      paths: ['lib/red.test.ts'],
      persisted: true,
    });
  });

  it('forwards expectedUpdatedAtMs to the queue writer on a confirmed CAS-guarded admission', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const identity = {
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };
    const result = body(
      await tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, ...identity } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, admitted: true, persisted: true });
    expect(mocks.write).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      expect.objectContaining({ repairHead: NEW_HEAD }),
      { expectedUpdatedAtMs: queue.updatedAtMs },
    );
  });

  it('a queue-row write failure RETRACTS the published lineage ref so ref and row cannot disagree', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    mocks.write.mockRejectedValue(new Error('pg down'));
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(mocks.retract).toHaveBeenCalledWith({
      root: '/repo',
      candidate: queue.candidate,
      published: NEW_HEAD,
      previousRepairHead: queue.repairHead,
    });
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      reason: 'persist_failed',
      persisted: false,
      judgedSha: queue.repairHead,
    });
    expect(result.note).toMatch(/retracted/);
  });

  it('a primitive refusal (stray-paths) is surfaced verbatim and nothing is written', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'stray-paths',
      stray: ['lib/other.ts'],
      detail: 'REFUSED: the built admission touches 1 path(s) outside the allowlist',
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: true,
      verdict: 'refused',
      reason: 'stray-paths',
      stray: ['lib/other.ts'],
      judgedSha: queue.repairHead,
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('P-004: an admission-incomplete refusal surfaces missing[] and an admitCommand widened by exactly the wanted paths; the door wires the preflight; nothing is written', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'admission-incomplete',
      detail: 'REFUSED: admission is incomplete',
      commit: 'e'.repeat(40),
      missing: [
        {
          from: 'lib/red.test.ts',
          specifier: './red-helper',
          wanted: 'lib/red-helper.ts',
          tried: ['lib/red-helper.ts', 'lib/red-helper.tsx'],
          atProbeRef: 'present',
        },
      ],
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: true,
      verdict: 'refused',
      reason: 'admission-incomplete',
      missing: [{ from: 'lib/red.test.ts', wanted: 'lib/red-helper.ts', atProbeRef: 'present' }],
      judgedSha: queue.repairHead,
    });
    const admitCommand = (result as { admitCommand?: string }).admitCommand ?? '';
    expect(admitCommand).toMatch(/op: 'admit'/);
    expect(admitCommand).toContain('"lib/red.test.ts"');
    expect(admitCommand).toContain('"lib/red-helper.ts"');
    expect((admitCommand.match(/lib\/red-helper\.ts/g) ?? []).length).toBe(1);
    expect(String((result as { note?: string }).note)).toContain('never widened');
    // The door hands the primitive the P-004 preflight on every admission.
    expect(mocks.admit.mock.calls[0]?.[0]).toMatchObject({ preflight: expect.any(Function) });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('nothing-to-admit reads as already-admitted: idempotent, ok:true, no write', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'nothing-to-admit',
      detail: 'every named path already has its staging content',
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: true,
      admitted: false,
      verdict: 'already-admitted',
      judgedSha: queue.repairHead,
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("converge is an ALIAS of admit — same door, same semantics, result op:'admit'", async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const result = body(
      await tool.handler(
        { op: 'converge', paths: ['lib/red.test.ts'], confirm: true } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, op: 'admit', verdict: 'admitted', admitted: true });
    expect(mocks.admit.mock.calls.at(-1)![0]).toMatchObject({ paths: ['lib/red.test.ts'], dryRun: false });
    // The alias never fast-forwards: the only head it can produce is the primitive's commit.
    expect(result.movedRepairHead).toEqual({ from: queue.repairHead, to: NEW_HEAD });
  });

  describe('R6 admission pre-check wiring (P-006)', () => {
    const dryRuns = () => mocks.admit.mock.calls.map((c) => (c[0] as { dryRun: boolean }).dryRun);
    const queueWithoutPrecheck = () => ({ ...queue, admissionPrecheck: undefined });
    const settledPrecheckQueue = async () => {
      await drainDetached();
      const transitionResult = mocks.transition.mock.results.at(-1)?.value as
        | Promise<{ queue: typeof queue }>
        | undefined;
      if (!transitionResult) throw new Error('expected detached pre-check settlement');
      return (await transitionResult).queue;
    };

    it('a live pre-check serializes the queue: another confirmed admission returns the same handle without building or launching', async () => {
      const pending = {
        ...queueWithoutPrecheck(),
        admissionPrecheck: {
          ...queue.admissionPrecheck,
          status: 'running' as const,
          verdict: undefined,
          expiresAtMs: Date.now() + 60_000,
        },
      };
      mocks.readState.mockResolvedValue({ status: 'value', queue: pending });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/other.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { operationId: 'repair-precheck-fixture', status: 'running' },
      });
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('an expired running pre-check is replaced by one fresh operation instead of wedging the queue', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const expiredOperationId = 'repair-precheck-expired';
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            operationId: expiredOperationId,
            status: 'running' as const,
            verdict: undefined,
            expiresAtMs: Date.now() - 1,
          },
        },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD },
      });
      expect(result.precheckOperation.operationId).not.toBe(expiredOperationId);
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      expect(mocks.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          admissionPrecheck: expect.objectContaining({ operationId: result.precheckOperation.operationId }),
          dispatchReservation: expect.objectContaining({ token: result.precheckOperation.operationId }),
        }),
        expect.anything(),
      );
      await drainDetached();
    });

    it('confirm:true returns after a durable pre-check marker; a later confirmed call publishes only after the stored pass', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      // The serving host's root is a LINKED worktree on :3170; the runner must be created for the
      // main worktree (checkpoint tree, run-lock and setup-release-checkout all key off it).
      mocks.canonicalRoot.mockReturnValue('/canonical');
      const runner = vi.fn(async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
        ran: true as const,
        commit,
        results: files.map((path) => ({ path, status: 'pass' as const })),
      }));
      mocks.precheckFactory.mockReturnValue(runner);
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        builtCommit: NEW_HEAD,
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD, files: ['lib/red.test.ts'] },
      });
      expect(dryRuns()).toEqual([true]);
      expect(mocks.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ admissionPrecheck: expect.objectContaining({ status: 'running' }) }),
        { expectedUpdatedAtMs: queue.updatedAtMs },
      );
      expect(mocks.canonicalRoot).toHaveBeenCalledWith('/repo');
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      expect(mocks.precheckFactory).toHaveBeenCalledWith({
        integrationRoot: '/canonical',
        checkpointRoot: checkpointRootMirror('/canonical'),
      });
      expect(runner).toHaveBeenCalledWith({ commit: NEW_HEAD, files: ['lib/red.test.ts'] });
      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({ status: 'passed', builtCommit: NEW_HEAD });
      expect((settled as { dispatchReservation?: unknown }).dispatchReservation).toBeUndefined();
      expect(dryRuns()).toEqual([true]); // the detached leg never publishes
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const published = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(published).toMatchObject({ ok: true, admitted: true, verdict: 'admitted' });
      expect(dryRuns()).toEqual([true, true, false]);
    });

    it('reuses a passed legacy pre-check when provenance changes the commit id but not its tree', async () => {
      const { builtTree: _builtTree, ...legacyPrecheck } = queue.admissionPrecheck;
      mocks.admit.mockImplementation((input: { dryRun: boolean; paths: string[] }) =>
        admissionOf(!input.dryRun, input.paths, ALT_HEAD),
      );
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: { ...queue, admissionPrecheck: legacyPrecheck },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        verdict: 'admitted',
        movedRepairHead: { from: queue.repairHead, to: ALT_HEAD },
      });
      expect(dryRuns()).toEqual([true, false]);
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
      expect(mocks.admissionGit).toHaveBeenCalledWith(['rev-parse', '--verify', `${NEW_HEAD}^{tree}`], {
        cwd: '/repo',
      });
    });

    it('a stored red measurement refuses on the follow-up and the detached leg never publishes', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      mocks.precheckFactory.mockReturnValue(
        async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
          ran: true as const,
          commit,
          results: files.map((path) => ({ path, status: 'fail' as const })),
        }),
      );
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({ ok: false, refused: true, admitted: false, builtCommit: NEW_HEAD });
      expect(result.reason).toMatch(/^admission-(does-not-fix|imports-red)$/);
      expect(dryRuns()).toEqual([true, true]);
    });

    it('a stored runner failure refuses publication; retryPrecheck is the explicit restart route', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.precheckFactory.mockReturnValue(async () => ({
        ran: false as const,
        reason: 'runner-failed' as const,
        detail: 'setup-release-checkout exited 1',
      }));
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        admitted: false,
        refused: true,
        reason: 'admission-precheck-unavailable',
        builtCommit: NEW_HEAD,
      });
      expect(dryRuns()).toEqual([true, true]);
      expect(JSON.stringify(result.precheck)).toContain('runner-failed');
    });

    it('retryPrecheck:true replaces a matching terminal failure without publishing in that call', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const failedOperationId = 'repair-precheck-failed';
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            operationId: failedOperationId,
            status: 'failed' as const,
            verdict: {
              ok: false as const,
              ran: false as const,
              code: 'admission-precheck-unavailable' as const,
              reason: 'runner-failed' as const,
              detail: 'setup-release-checkout exited 1',
              population: queue.admissionPrecheck.verdict.population,
            },
          },
        },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, retryPrecheck: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD },
      });
      expect(result.precheckOperation.operationId).not.toBe(failedOperationId);
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      await drainDetached();
      expect(dryRuns()).toEqual([true]);
    });

    it('checkpoint-tree-busy settles as the explicit pass-through and publishes loud only on the follow-up', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.precheckFactory.mockReturnValue(async () => ({
        ran: false as const,
        reason: 'checkpoint-tree-busy' as const,
        detail: 'gate run holds the checkpoint tree',
        holder: { pid: 7, elapsedSec: 30 },
      }));
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({ ok: true, admitted: true });
      expect(dryRuns()).toEqual([true, true, false]);
      expect(JSON.stringify(result.precheck)).toContain('checkpoint-tree-busy');
    });

    it('a dry run never creates the runner', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never));
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
    });
  });

  // EI-22208176411693669: assessFrozenRepairFixerAuthorization correctly labels the
  // SU-bearer transport 'not-applicable' (never 'authorized-delegate') because that
  // transport carries no verified per-spawn signature regardless of its cosmetic
  // ?role= catalog hint. But the admit write-gate is a SEPARATE `if` a few lines
  // below callerAuthorization, and before this fix it independently required
  // role==='su' OR an OPERATOR_CONFIG_WRITE_ROLE OR authorized===true — none of which
  // a superuser caller whose ?role= was forwarded as 'release-fixer' satisfied — so it
  // was thrown out even though dispatch on that transport is already unconditional.
  // This pins that the write-gate itself, not just the label, bypasses.
  it('EI-22208176411693669: an isSuperuser caller may admit even when its cosmetic role hint is release-fixer', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const result = body(
      await tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: true,
          spawnId: 'fixer-1',
          sigVerifiedSpawn: false,
        } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, admitted: true, persisted: true });
    expect(result.callerAuthorization).toMatchObject({ status: 'not-applicable', authorized: null });
    expect(mocks.write).toHaveBeenCalled();
  });

  // Control for the test above: a non-superuser release-fixer that is NOT the
  // queue-delegated fixer must still be refused. This is what proves the fix bypasses
  // on isSuperuser specifically, rather than having widened the gate for every
  // release-fixer-labelled caller.
  it('control: a non-superuser caller with an unverified or mismatched release-fixer identity is still refused admission', async () => {
    await expect(
      tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: false,
          spawnId: 'fixer-2',
          sigVerifiedSpawn: true,
        } as never,
      ),
    ).rejects.toThrow(/requires an operator-config write role, su/);
    expect(mocks.admit).not.toHaveBeenCalled();
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

    const result = body(await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never));
    expect(mocks.retire).toHaveBeenCalledWith({ workspaceId: 'ws-1', installSlug: 'papercusp' }, queue);
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

    const retired = body(await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never)) as {
      retired?: boolean;
      nextStep?: string;
    };
    expect(retired.retired).toBe(true);
    expect(
      retired.nextStep,
      'a successful retire must carry the next-step procedure, not leave it to guidance',
    ).toEqual(expect.any(String));
    // The two facts that actually prevent the treadmill: the gate re-freezes by itself,
    // and checkpoint-run is NOT the lever to restart it.
    expect(retired.nextStep).toMatch(/re-?freez/i);
    expect(retired.nextStep).toMatch(/release:checkpoint-run/);
    expect(retired.nextStep).toMatch(/op: "admit"/);

    // CONTROL — the assertions above are all "field is present and matches", so they
    // would pass just as well if `nextStep` were emitted unconditionally on every
    // branch, which would make it noise rather than a signal about what just happened.
    // A dry run retires NOTHING, so it must NOT claim a post-retire procedure.
    const dryRun = body(await tool.handler(args as never, { role: 'su' } as never)) as {
      retired?: boolean;
      nextStep?: string;
    };
    expect(dryRun.retired).toBe(false);
    expect(dryRun.nextStep, 'control: nothing was retired, so there is no post-retire step to state').toBeUndefined();
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

  // P-021 (D-007 #1): the repair manifest rides on get, and claim-leg takes one row of it.
  describe('claim-leg (P-021 repair manifest)', () => {
    it('get renders the manifest rows + summary when the queue carries one', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result.repairQueue.manifest).toMatchObject({
        candidate: queue.candidate,
        rows: [{ legId: manifestRow.legId }],
      });
      expect(result.repairQueue.manifestSummary).toEqual({
        legs: 1,
        red: 1,
        admitted: 0,
        green: 0,
        claimed: 0,
        pathless: 0,
      });
    });

    it('claims the leg: persists the claim on the queue row, sets presence current_files to its paths, audits, returns the admit command', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.write).toHaveBeenCalledTimes(1);
      const [target, written] = mocks.write.mock.calls[0]!;
      expect(target).toEqual({ workspaceId: 'ws-1', installSlug: 'papercusp' });
      expect(written).toMatchObject({
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        manifest: { rows: [{ legId: manifestRow.legId, claim: { actor: 'su-test' } }] },
      });
      // Claiming a leg claims its paths: presence current_files = the leg's subject paths.
      expect(mocks.presence).toHaveBeenCalledTimes(1);
      expect(mocks.presence.mock.calls[0]![1]).toEqual({ currentFiles: ['lib/red.test.ts'] });
      expect(result).toMatchObject({
        ok: true,
        op: 'claim-leg',
        claimed: true,
        released: false,
        verdict: 'claimed',
        persisted: true,
        auditRecorded: true,
        paths: ['lib/red.test.ts'],
        presenceFiles: ['lib/red.test.ts'],
        admitCommand: manifestRow.admitCommand,
        row: { legId: manifestRow.legId, claim: { actor: 'su-test' } },
        repairQueue: { manifestSummary: { claimed: 1 } },
      });
      expect(result.nextAction).toContain(manifestRow.admitCommand);
      expect(result.nextAction).toMatch(/Do NOT fire release:checkpoint-run/);
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({
        op: 'claim-leg',
        leg: manifestRow.legId,
        paths: ['lib/red.test.ts'],
        persisted: true,
      });
    });

    it('release:true hands the leg back (holder only) and does not touch presence', async () => {
      const held = { ...manifest, rows: [{ ...manifestRow, claim: { actor: 'su-test', atMs: 7 } }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, manifest: held } });
      const result = body(
        await tool.handler(
          { op: 'claim-leg', leg: manifestRow.legId, release: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(mocks.write.mock.calls[0]![1]).toMatchObject({
        manifest: { rows: [{ legId: manifestRow.legId, claim: null }] },
      });
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, claimed: false, released: true, verdict: 'released', persisted: true });
    });

    it('never contests a live claim: a leg held by another actor is refused with the holder named, and nothing is written', async () => {
      const held = { ...manifest, rows: [{ ...manifestRow, claim: { actor: 'su-other', atMs: 7 } }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, manifest: held } });
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        claimed: false,
        refused: true,
        reason: 'held-by-other',
        holder: { actor: 'su-other' },
      });
    });

    it('refuses an unknown leg id and lists the legs the manifest names', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(await tool.handler({ op: 'claim-leg', leg: 'nope' } as never, { role: 'su' } as never));
      expect(mocks.write).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, refused: true, reason: 'no-such-leg', legIds: [manifestRow.legId] });
    });

    it('refuses no-manifest when the queue has not been re-derived yet, and no-frozen-queue when nothing is frozen', async () => {
      const noManifest = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(noManifest).toMatchObject({ ok: false, refused: true, reason: 'no-manifest' });
      mocks.readState.mockResolvedValue({ status: 'absent' });
      const none = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(none).toMatchObject({ ok: true, claimed: false, verdict: 'no-frozen-queue' });
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('a queue-row write failure reports persist_failed and leaves presence untouched', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      mocks.write.mockRejectedValueOnce(new Error('pg down'));
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        claimed: false,
        persisted: false,
        refused: true,
        reason: 'persist_failed',
      });
    });
  });

  describe('record-edit (P-019 edit ledger, D-008 layer 1 — hook plumbing)', () => {
    const hunk = { kind: 'edit', old: 'a', new: 'b' };
    const ctx = { role: 'su' } as never;

    it('records the hunk under the LIVE queue candidate, attributed to the caller identity, reports the radius + admit command, and never touches the queue row or git', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      mocks.audit.mockResolvedValueOnce([{ id: 42 }]);
      const result = body(
        await tool.handler(
          {
            op: 'record-edit',
            path: './lib/red.test.ts',
            hunk,
            toolUseId: 'toolu_1',
            editIndex: 0,
            atMs: 777,
            candidate: 'f'.repeat(40),
          } as never,
          ctx,
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        op: 'record-edit',
        recorded: true,
        inserted: true,
        oversize: false,
        ledgerId: 42,
        path: 'lib/red.test.ts',
        agent: 'su-test',
        candidate: queue.candidate,
        judgedSha: queue.repairHead,
        inRepairRadius: true,
        // The hook's marker named a different candidate: reported, never trusted over the queue.
        candidateMismatch: { marker: 'f'.repeat(40), queue: queue.candidate },
      });
      expect(result.admitCommand).toContain('admit');
      expect(result.admitCommand).toContain('lib/red.test.ts');
      const [sqlText, params] = mocks.audit.mock.calls[0]! as [string, unknown[]];
      expect(sqlText).toContain('INSERT INTO harness_shared.frozen_repair_edit_ledger');
      expect(params).toEqual(
        expect.arrayContaining(['ws-1', 'papercusp', queue.candidate, 'su-test', 'lib/red.test.ts', 'toolu_1', 777]),
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('a path OUTSIDE the repair radius is still recorded — the source fix is as attributable as the failing test — and flagged inRepairRadius:false', async () => {
      mocks.audit.mockResolvedValueOnce([{ id: 1 }]);
      const result = body(
        await tool.handler({ op: 'record-edit', path: 'lib/src.ts', hunk: { kind: 'write', body: 'x' } } as never, ctx),
      );
      expect(result).toMatchObject({
        ok: true,
        recorded: true,
        inserted: true,
        inRepairRadius: false,
        path: 'lib/src.ts',
      });
      expect(result.candidateMismatch).toBeUndefined();
    });

    it('an idempotent retry (same agent/path/toolUseId/editIndex) inserts nothing: recorded:true, inserted:false', async () => {
      mocks.audit.mockResolvedValueOnce([]);
      const result = body(
        await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk, toolUseId: 'toolu_1' } as never, ctx),
      );
      expect(result).toMatchObject({ ok: true, recorded: true, inserted: false });
    });

    it('nothing frozen ⇒ recorded:false with no-frozen-queue, and NO SQL — there is no lineage to attribute to', async () => {
      mocks.readState.mockResolvedValue({ status: 'absent' });
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({ ok: true, op: 'record-edit', recorded: false, verdict: 'no-frozen-queue' });
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('a malformed hunk or a path that escapes the repo is refused without SQL', async () => {
      const bad = body(
        await tool.handler(
          { op: 'record-edit', path: 'lib/red.test.ts', hunk: { kind: 'patch', text: '...' } } as never,
          ctx,
        ),
      );
      expect(bad).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'invalid-hunk' });
      const escape = body(await tool.handler({ op: 'record-edit', path: '../../etc/passwd', hunk } as never, ctx));
      expect(escape).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'invalid-path' });
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('a database failure is persist_failed, ok:false — the hook then tells the agent its hunks were NOT recorded', async () => {
      mocks.audit.mockRejectedValueOnce(new Error('pg down'));
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'persist_failed' });
    });

    it('an unreadable queue row refuses with op:record-edit / recorded:false (P-025: unreadable is not absent)', async () => {
      mocks.readState.mockResolvedValue({ status: 'unreadable', reason: 'schema-newer', schemaVersion: 99 });
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({
        ok: false,
        op: 'record-edit',
        recorded: false,
        refused: true,
        reason: 'repair-queue-unreadable',
      });
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  });

  describe('P-020 hunk-exact admission (D-008 layers 2–3)', () => {
    const ctx = { role: 'su' } as never;
    type Written = { admissions: Array<Record<string, unknown>> };
    const patch = { commit: 'e'.repeat(40), parent: 'f'.repeat(40), sha256: '1'.repeat(64) };
    const patchArgs = {
      op: 'admit',
      paths: ['lib/red.test.ts'],
      patchCommit: patch.commit,
      reason: 'reviewed missing hook capture',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };

    it('committed patch requires reason and excludes the other source modes, in schema AND direct handler', async () => {
      expect(tool.args.safeParse(patchArgs).success).toBe(true);
      expect(tool.args.safeParse({ ...patchArgs, op: 'converge' }).success).toBe(true);
      for (const extra of [
        { reason: undefined },
        { wholeBlob: true },
        { sourceCommit: '1'.repeat(40) },
        { includeHunksFrom: [] },
      ]) {
        const args = { ...patchArgs, ...extra };
        expect(tool.args.safeParse(args).success).toBe(false);
        expect(body(await tool.handler(args as never, ctx))).toMatchObject({
          ok: false,
          reason: 'invalid-patch-source',
        });
      }
      expect(mocks.committedPatch).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'committed patch confirm=%s retains path preflight, preview/CAS and durable provenance without hook attribution',
      async (confirm) => {
        mocks.committedPatch.mockReturnValue({ ok: true, sourceCommit: HX_SOURCE, tree: 'a'.repeat(40), patch });
        mocks.admit.mockReturnValue(admissionOf(confirm));
        // A missing/unavailable ledger cannot be invented or mislabeled as proof.
        mocks.ledger.mockRejectedValueOnce(new Error('ledger unavailable'));
        const result = body(await tool.handler({ ...patchArgs, confirm } as never, ctx));
        expect(result).toMatchObject({ ok: true, admitted: confirm, mode: 'committed-patch', patch });
        expect(result.source).toEqual({ ref: HX_SOURCE, root: '/repo' });
        expect(mocks.hunkExact).not.toHaveBeenCalled();
        expect(mocks.committedPatch).toHaveBeenCalledWith(
          expect.objectContaining({
            root: '/repo',
            repairHead: queue.repairHead,
            integrationRef: 'staging',
            patchCommit: patch.commit,
            paths: patchArgs.paths,
          }),
        );
        expect(mocks.admit).toHaveBeenCalledWith(
          expect.objectContaining({
            source: { ref: HX_SOURCE },
            dryRun: !confirm,
            paths: patchArgs.paths,
            preflight: expect.any(Function),
          }),
        );
        if (confirm) {
          expect(mocks.write).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
            expectedUpdatedAtMs: queue.updatedAtMs,
          });
          const entry = (mocks.write.mock.calls[0]![1] as Written).admissions[0];
          expect(entry).toMatchObject({ mode: 'committed-patch', patch });
          expect(entry).not.toHaveProperty('hunks');
          expect(entry).not.toHaveProperty('foreignHunksAccepted');
          expect(JSON.parse(mocks.audit.mock.calls[0]![1][5])).toMatchObject({ mode: 'committed-patch', patch });
        } else {
          expect(mocks.write).not.toHaveBeenCalled();
          expect(mocks.audit).not.toHaveBeenCalled();
        }
      },
    );

    it('committed patch refusal and stale queue never publish or write', async () => {
      mocks.committedPatch.mockReturnValue({
        ok: false,
        code: 'patch-conflict',
        detail: 'exact patch conflicts',
        exits: [],
      });
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        reason: 'patch-conflict',
      });
      mocks.committedPatch.mockClear();
      expect(
        body(await tool.handler({ ...patchArgs, expectedRepairHead: '0'.repeat(40), confirm: true } as never, ctx)),
      ).toMatchObject({ ok: false, reason: 'exact_queue_identity_mismatch' });
      expect(mocks.committedPatch).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('committed patch keeps import preflight refusals and retracts publication on failed queue CAS', async () => {
      mocks.committedPatch.mockReturnValue({ ok: true, sourceCommit: HX_SOURCE, tree: 'a'.repeat(40), patch });
      mocks.admit.mockReturnValueOnce({ ok: false, code: 'admission-incomplete', detail: 'missing sibling' });
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        reason: 'admission-incomplete',
      });
      expect(mocks.write).not.toHaveBeenCalled();
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.write.mockRejectedValueOnce(new Error('queue CAS moved'));
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        admitted: false,
        reason: 'persist_failed',
      });
      expect(mocks.retract).toHaveBeenCalledWith(
        expect.objectContaining({ published: NEW_HEAD, previousRepairHead: queue.repairHead }),
      );
    });

    it('DEFAULT: reads the ledger for the named paths, builds the hunk-exact source for the CALLER, admits FROM that commit, and the ledger entry + audit carry mode + hunks', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, ctx));
      expect(mocks.ledger).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          candidate: queue.candidate,
          paths: ['lib/red.test.ts'],
        }),
      );
      expect(mocks.hunkExact.mock.calls[0]![0]).toMatchObject({
        root: '/repo',
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        paths: ['lib/red.test.ts'],
        actor: 'su-test',
        includeHunksFrom: [],
      });
      expect(mocks.admit.mock.calls[0]![0]).toMatchObject({ source: { ref: HX_SOURCE } });
      expect(mocks.importPreflight).toHaveBeenCalledWith({ root: '/repo', probeRef: 'staging' });
      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        mode: 'hunk-exact',
        hunkExact: [{ path: 'lib/red.test.ts', applied: 1, agents: ['su-test'], foreignHunksExcluded: 0 }],
      });
      const written = mocks.write.mock.calls[0]![1] as Written;
      expect(written.admissions[0]).toMatchObject({
        mode: 'hunk-exact',
        hunks: { 'lib/red.test.ts': { applied: 1, agents: ['su-test'] } },
      });
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({ mode: 'hunk-exact', hunks: { 'lib/red.test.ts': { applied: 1 } } });
    });

    it('includeHunksFrom is forwarded to the builder verbatim (the explicit widening, D-008 3a)', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], includeHunksFrom: [' peer ', ''] } as never, ctx);
      expect(mocks.hunkExact.mock.calls[0]![0]).toMatchObject({ includeHunksFrom: ['peer'] });
    });

    it('a builder refusal (no-ledgered-hunks / hunk-conflict) is surfaced with its exits and the primitive is NEVER called', async () => {
      mocks.hunkExact.mockReturnValue({
        ok: false,
        code: 'no-ledgered-hunks',
        path: 'lib/red.test.ts',
        foreignAgents: ['peer'],
        detail: 'nothing to replay',
        exits: ['includeHunksFrom exit', 'wholeBlob exit'],
      });
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, ctx));
      expect(result).toMatchObject({
        ok: false,
        admitted: false,
        refused: true,
        verdict: 'refused',
        reason: 'no-ledgered-hunks',
        path: 'lib/red.test.ts',
        foreignAgents: ['peer'],
        exits: ['includeHunksFrom exit', 'wholeBlob exit'],
        mode: 'hunk-exact',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('a ledger read failure refuses ledger-unavailable rather than silently admitting the whole blob', async () => {
      mocks.ledger.mockRejectedValueOnce(new Error('pg down'));
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, ctx));
      expect(result).toMatchObject({ ok: false, refused: true, reason: 'ledger-unavailable', mode: 'hunk-exact' });
      expect(mocks.hunkExact).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('wholeBlob:true REQUIRES a reason; with one it admits from the integration branch and RECORDS the foreign hunks it carries (D-008 3b)', async () => {
      const noReason = body(
        await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], wholeBlob: true } as never, ctx),
      );
      expect(noReason).toMatchObject({ ok: false, refused: true, reason: 'reason_required', mode: 'whole-blob' });
      expect(mocks.admit).not.toHaveBeenCalled();

      mocks.foreign.mockReturnValue({ count: 2, agents: ['peer'], byPath: { 'lib/red.test.ts': 2 } });
      mocks.admit.mockReturnValue(admissionOf(true));
      const result = body(
        await tool.handler(
          {
            op: 'admit',
            paths: ['lib/red.test.ts'],
            wholeBlob: true,
            reason: 'shared refactor: the peer hunks are part of this fix',
            confirm: true,
          } as never,
          ctx,
        ),
      );
      expect(mocks.hunkExact).not.toHaveBeenCalled();
      expect(mocks.admit.mock.calls[0]![0]).toMatchObject({ source: { ref: 'staging' } });
      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        mode: 'whole-blob',
        foreignHunksAccepted: 2,
        foreignAgents: ['peer'],
        foreignHunksByPath: { 'lib/red.test.ts': 2 },
      });
      const written = mocks.write.mock.calls[0]![1] as Written;
      expect(written.admissions[0]).toMatchObject({
        mode: 'whole-blob',
        foreignHunksAccepted: 2,
        foreignAgents: ['peer'],
      });
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({ mode: 'whole-blob', foreignHunksAccepted: 2, foreignAgents: ['peer'] });
    });

    it('wholeBlob sourceCommit pins the reviewed integration ancestor instead of rereading a moving staging tip', async () => {
      const sourceCommit = '1'.repeat(40);
      expect(
        tool.args.safeParse({
          op: 'admit',
          paths: ['lib/red.test.ts'],
          wholeBlob: true,
          sourceCommit,
          reason: 'pin the reviewed preview',
        }).success,
      ).toBe(true);
      expect(
        tool.args.safeParse({
          op: 'admit',
          paths: ['lib/red.test.ts'],
          sourceCommit,
          reason: 'missing whole blob opt in',
        }).success,
      ).toBe(false);

      mocks.admissionGit
        .mockReturnValueOnce({ status: 0, stdout: `${sourceCommit}\n`, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
      mocks.admit.mockReturnValue(admissionOf(false));
      const result = body(
        await tool.handler(
          {
            op: 'admit',
            paths: ['lib/red.test.ts'],
            wholeBlob: true,
            sourceCommit,
            reason: 'pin the reviewed preview',
          } as never,
          ctx,
        ),
      );

      expect(mocks.admissionGit.mock.calls).toEqual([
        [['rev-parse', '--verify', `${sourceCommit}^{commit}`], { cwd: '/repo' }],
        [['merge-base', '--is-ancestor', sourceCommit, 'staging'], { cwd: '/repo' }],
      ]);
      expect(mocks.admit).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { ref: sourceCommit, recordAsRef: 'staging' },
          preflight: expect.any(Function),
        }),
      );
      expect(mocks.importPreflight).toHaveBeenCalledWith({ root: '/repo', probeRef: sourceCommit });
      expect(result).toMatchObject({
        ok: true,
        mode: 'whole-blob',
        source: { ref: sourceCommit, root: '/repo' },
      });
    });

    it('wholeBlob sourceCommit fails closed when the commit is absent or not integrated', async () => {
      const sourceCommit = '1'.repeat(40);
      const args = {
        op: 'admit',
        paths: ['lib/red.test.ts'],
        wholeBlob: true,
        sourceCommit,
        reason: 'pin the reviewed preview',
      };
      mocks.admissionGit.mockReturnValueOnce({ status: 128, stdout: '', stderr: 'bad revision' });
      expect(body(await tool.handler(args as never, ctx))).toMatchObject({
        ok: false,
        reason: 'source-commit-unresolvable',
      });
      expect(mocks.admit).not.toHaveBeenCalled();

      mocks.admissionGit
        .mockReturnValueOnce({ status: 0, stdout: `${sourceCommit}\n`, stderr: '' })
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });
      expect(body(await tool.handler(args as never, ctx))).toMatchObject({
        ok: false,
        reason: 'source-commit-not-integrated',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
    });
  });
});
