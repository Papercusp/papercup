import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { signStagingAdvance } from './staging-advance';
import { defaultRunGit } from './storage';
import { physicalDrillGitSyncSlug } from './physical-drill-phase-a';
import {
  PHASE_D_EVENT_DUPLICATE_MARKER,
  PHASE_D_EVENT_POLL_MS,
  PHASE_D_EVENT_SCHEMA,
  PHASE_D_EVENT_WAIT_MAX_MS,
  PHASE_D_INPUT_SCHEMA,
  capturePhysicalPhaseDEvent,
  PHASE_D_MUTATION_SCHEMA,
  PHASE_D_OBSERVATION_SCHEMA,
  PHASE_D_RATIFICATION_SCHEMA,
  PHASE_D_SENTINEL,
  PHASE_D_TIER_HOLD_FILE,
  PHASE_D_TIER_HOLD_SCHEMA,
  PHASE_D_WORKSPACE,
  capturePhysicalPhaseDObservation,
  createPhysicalPhaseDMutation,
  porcelainDirtyPaths,
  dirtyPhysicalPhaseDWorktree,
  holdPhysicalPhaseDBelowSteer,
  resetPhysicalPhaseDDirt,
  restorePhysicalPhaseDTier,
  validatePhysicalPhaseD,
  PHASE_D_DIRT_LOCK_TTL_SEC,
  phaseDDirtLockOwner,
  type PhysicalPhaseDDirtLock,
  type PhysicalPhaseDInput,
  type PhysicalPhaseDObservation,
  type PhysicalPhaseDTrigger,
} from './physical-drill-phase-d';

/** In-memory stand-in for the lock plane; records each call and the sentinel's state at that moment. */
function recordingDirtLock(sentinelPath?: () => string): PhysicalPhaseDDirtLock & {
  calls: Array<{ op: 'acquire' | 'release'; input: Record<string, unknown>; sentinelContent?: string | null }>;
} {
  const calls: Array<{ op: 'acquire' | 'release'; input: Record<string, unknown>; sentinelContent?: string | null }> =
    [];
  let held = 0;
  return {
    calls,
    async acquire(input) {
      const path = sentinelPath?.();
      calls.push({
        op: 'acquire',
        input,
        ...(path ? { sentinelContent: await readFile(path, 'utf8').catch(() => null) } : {}),
      });
      held += 1;
      return { lockId: `lock-${calls.length}`, expiresAt: new Date(0).toISOString() };
    },
    async release(input) {
      calls.push({ op: 'release', input });
      const released = held;
      held = 0;
      return { released };
    },
  };
}

const testDirtLock = recordingDirtLock();

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function oid(char: string): string {
  return char.repeat(40);
}

function trigger(
  host: 'tower' | 'vm',
  role: PhysicalPhaseDTrigger['role'],
  startedAt: string,
  finishedAt: string,
): PhysicalPhaseDTrigger {
  return {
    tool: 'git-sync:run',
    installSlug: physicalDrillGitSyncSlug(host),
    host,
    role,
    fired: true,
    startedAt,
    finishedAt,
  };
}

function observation(input: {
  hostId: 'tower' | 'vm';
  stage: PhysicalPhaseDObservation['stage'];
  integratorDeviceKey: string;
  stagingSha: string;
  worktreeHead?: string;
  rowId: number;
  epoch: number;
  seq: number;
  dirty?: boolean;
  protectedHash?: string;
  observedAt: string;
}): PhysicalPhaseDObservation {
  return {
    schemaVersion: PHASE_D_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    runId: 'p505-phase-d-fixture-1',
    stage: input.stage,
    observedAt: input.observedAt,
    repoPath: `/${input.hostId}/.papercusp/pot-git/hello-world-3-pot/gh-1303510992.git`,
    worktreePath: `/${input.hostId}/hello-world-3-pot`,
    integratorDeviceKey: input.integratorDeviceKey,
    integratorNamespaceStagingOid: input.stagingSha,
    canonicalStagingOid: input.stagingSha,
    worktreeHeadOid: input.worktreeHead ?? input.stagingSha,
    dirtyPaths: input.dirty ? [PHASE_D_SENTINEL] : [],
    protectedPath: PHASE_D_SENTINEL,
    protectedFileSha256: input.protectedHash ?? oid('d').slice(0, 64),
    cursor: {
      lastEventId: input.rowId,
      epochSeq: { epoch: input.epoch, seq: input.seq },
      stagingSha: input.stagingSha,
    },
  };
}

async function fixture(): Promise<PhysicalPhaseDInput> {
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const base = oid('a');
  const first = oid('b');
  const second = oid('c');
  const startedAt = '2026-08-13T20:00:00.000Z';
  const finishedAt = '2026-08-13T20:10:00.000Z';
  const firstAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: tower.pubkeyBase64,
      epoch: 7,
      seq: 1,
      stagingSha: first,
      nowMs: Date.parse('2026-08-13T20:04:00.000Z'),
    },
    (bytes) => Promise.resolve(signWithPrivateKeyDer(tower.privateKeyDer, bytes)),
  );
  const secondAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: tower.pubkeyBase64,
      epoch: 7,
      seq: 2,
      stagingSha: second,
      nowMs: Date.parse('2026-08-13T20:08:00.000Z'),
    },
    (bytes) => Promise.resolve(signWithPrivateKeyDer(tower.privateKeyDer, bytes)),
  );
  const pending = {
    workspaceId: 'papercusp-workspace',
    potSlug: 'hello-world-3-pot',
    repoKey: 'gh-1303510992',
    devicePubkey: vm.pubkeyBase64,
    headSha: first,
    authorGithubUserId: 101,
    reason: 'below-steer-tier' as const,
    state: 'pending' as const,
    createdTs: Date.parse('2026-08-13T20:02:30.000Z'),
    ratifiedTs: null,
  };
  const ratified = {
    ...pending,
    state: 'ratified' as const,
    ratifiedTs: Date.parse('2026-08-13T20:03:00.000Z'),
  };
  const dirtyHash = 'e'.repeat(64);
  return {
    schemaVersion: PHASE_D_INPUT_SCHEMA,
    runId: 'p505-phase-d-fixture-1',
    window: { startedAt, finishedAt },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    belowSteer: {
      mutation: {
        schemaVersion: PHASE_D_MUTATION_SCHEMA,
        runId: 'p505-phase-d-fixture-1',
        kind: 'below-steer',
        sourceHost: 'vm',
        sourceDeviceKey: vm.pubkeyBase64,
        method: 'fixed-worktree-commit',
        worktreePath: '/vm/hello-world-3-pot',
        protectedPath: PHASE_D_SENTINEL,
        baseOid: base,
        headOid: first,
        payloadSha256: '1'.repeat(64),
        createdAt: '2026-08-13T20:01:00.000Z',
      },
      publishTrigger: trigger('vm', 'below-steer-publish', '2026-08-13T20:01:10.000Z', '2026-08-13T20:01:30.000Z'),
      queueTrigger: trigger('tower', 'queue-receive', '2026-08-13T20:02:00.000Z', '2026-08-13T20:02:20.000Z'),
      pendingReceipt: pending,
      ratification: {
        schemaVersion: PHASE_D_RATIFICATION_SCHEMA,
        tool: 'ratifyIntegrationRequest',
        accepted: true,
        observedAt: '2026-08-13T20:03:01.000Z',
        pending,
        ratified,
      },
    },
    firstAdvance: {
      integratorTrigger: trigger('tower', 'ratified-integrate', '2026-08-13T20:03:10.000Z', '2026-08-13T20:03:40.000Z'),
      sourceEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'tower',
        rowId: 101,
        observedAt: '2026-08-13T20:04:01.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1303510992',
        payload: firstAdvance,
      },
      destinationEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'vm',
        rowId: 501,
        observedAt: '2026-08-13T20:04:10.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1303510992',
        payload: firstAdvance,
      },
      destinationTrigger: trigger('vm', 'first-bridge', '2026-08-13T20:04:20.000Z', '2026-08-13T20:04:40.000Z'),
      sourceObservation: observation({
        hostId: 'tower',
        stage: 'first-source',
        integratorDeviceKey: tower.pubkeyBase64,
        stagingSha: first,
        rowId: 101,
        epoch: 7,
        seq: 1,
        observedAt: '2026-08-13T20:04:41.000Z',
      }),
      destinationObservation: observation({
        hostId: 'vm',
        stage: 'first-destination',
        integratorDeviceKey: tower.pubkeyBase64,
        stagingSha: first,
        rowId: 501,
        epoch: 7,
        seq: 1,
        observedAt: '2026-08-13T20:04:42.000Z',
      }),
    },
    dirtyAdvance: {
      mutation: {
        schemaVersion: PHASE_D_MUTATION_SCHEMA,
        runId: 'p505-phase-d-fixture-1',
        kind: 'dirty-overlap',
        sourceHost: 'tower',
        sourceDeviceKey: tower.pubkeyBase64,
        method: 'fixed-worktree-commit',
        worktreePath: '/tower/hello-world-3-pot',
        protectedPath: PHASE_D_SENTINEL,
        baseOid: first,
        headOid: second,
        payloadSha256: '2'.repeat(64),
        createdAt: '2026-08-13T20:06:00.000Z',
      },
      integratorTrigger: trigger('tower', 'dirty-integrate', '2026-08-13T20:07:10.000Z', '2026-08-13T20:07:40.000Z'),
      sourceEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'tower',
        rowId: 102,
        observedAt: '2026-08-13T20:08:01.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1303510992',
        payload: secondAdvance,
      },
      destinationEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'vm',
        rowId: 502,
        observedAt: '2026-08-13T20:08:10.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1303510992',
        payload: secondAdvance,
      },
      destinationTrigger: trigger('vm', 'dirty-bridge', '2026-08-13T20:08:20.000Z', '2026-08-13T20:08:40.000Z'),
      dirtyBefore: observation({
        hostId: 'vm',
        stage: 'dirty-before',
        integratorDeviceKey: tower.pubkeyBase64,
        stagingSha: first,
        rowId: 501,
        epoch: 7,
        seq: 1,
        dirty: true,
        protectedHash: dirtyHash,
        observedAt: '2026-08-13T20:06:30.000Z',
      }),
      dirtyAfter: observation({
        hostId: 'vm',
        stage: 'dirty-after',
        integratorDeviceKey: tower.pubkeyBase64,
        stagingSha: second,
        worktreeHead: first,
        rowId: 502,
        epoch: 7,
        seq: 2,
        dirty: true,
        protectedHash: dirtyHash,
        observedAt: '2026-08-13T20:08:41.000Z',
      }),
    },
  };
}

function clone(input: PhysicalPhaseDInput): PhysicalPhaseDInput {
  return JSON.parse(JSON.stringify(input)) as PhysicalPhaseDInput;
}

describe('P-505 fixed physical Phase D production-spine adapter', () => {
  it('accepts the exact request → ratification → signed staging → remote FF → dirty-safe chain', async () => {
    const verdict = validatePhysicalPhaseD(await fixture());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        phase: 'D',
        planItem: 'P-305',
        complete: true,
        missingAssertions: [],
        assertions: {
          freshBelowSteerHeadQueuedWithVisibleReceipt: true,
          exactRequestRatifiedThroughProductionSurface: true,
          productionGitSyncPublishedSignedCanonicalStaging: true,
          signedAdvanceFederatedToOtherPhysicalHost: true,
          otherPhysicalHostFastForwardedCanonicalAndWorktree: true,
          secondOverlappingAdvanceMovedMirrorAndCursor: true,
          dirtyWorktreeAndProtectedFileRemainedUntouched: true,
        },
        cursor: { firstEventId: 501, secondEventId: 502 },
      },
    });
  });

  it('rejects a forged source signature and a destination row carrying a different payload', async () => {
    const input = clone(await fixture());
    input.firstAdvance.sourceEvent.payload.sig = Buffer.alloc(64, 9).toString('base64');
    input.dirtyAdvance.destinationEvent.payload.seq = 99;
    const verdict = validatePhysicalPhaseD(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase D tower event is not the exact signed production staging advance',
        'Phase D destination event must exactly match the source signed advance',
      ]),
    );
  });

  it('rejects a receipt for another head or a ratification that did not promote the same row', async () => {
    const input = clone(await fixture());
    input.belowSteer.pendingReceipt.headSha = oid('f');
    input.belowSteer.ratification.ratified.createdTs += 1;
    const verdict = validatePhysicalPhaseD(input);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase D pending receipt must be the exact visible below-steer request',
        'Phase D ratification must promote the exact pending request through the production surface',
      ]),
    );
  });

  it('rejects a remote claim where the mirror or production cursor did not reach the first signed event', async () => {
    const input = clone(await fixture());
    input.firstAdvance.destinationObservation.canonicalStagingOid = oid('9');
    input.firstAdvance.destinationObservation.cursor.lastEventId = 500;
    const verdict = validatePhysicalPhaseD(input);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase D first destination observation must converge canonical, cursor, and worktree to the signed staging head',
        'Phase D first destination cursor must consume the replicated signed event',
      ]),
    );
  });

  it('rejects a dirty bridge that moved the worktree or rewrote the protected file', async () => {
    const input = clone(await fixture());
    input.dirtyAdvance.dirtyAfter.worktreeHeadOid = input.dirtyAdvance.mutation.headOid;
    input.dirtyAdvance.dirtyAfter.protectedFileSha256 = '8'.repeat(64);
    expect(validatePhysicalPhaseD(input).errors).toContain(
      'Phase D dirty bridge must leave the worktree head and protected dirty file untouched',
    );
  });

  it('rejects a second advance that does not move epoch/seq, physical event rows, and cursor', async () => {
    const input = clone(await fixture());
    input.dirtyAdvance.sourceEvent.payload = input.firstAdvance.sourceEvent.payload;
    input.dirtyAdvance.destinationEvent.payload = input.firstAdvance.destinationEvent.payload;
    input.dirtyAdvance.sourceEvent.rowId = input.firstAdvance.sourceEvent.rowId;
    input.dirtyAdvance.destinationEvent.rowId = input.firstAdvance.destinationEvent.rowId;
    input.dirtyAdvance.dirtyAfter.cursor.lastEventId = input.dirtyAdvance.dirtyBefore.cursor.lastEventId;
    const verdict = validatePhysicalPhaseD(input);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase D second signed advance must be newer than the first epoch/seq',
        'Phase D second advance must use newer production event rows on both physical hosts',
        'Phase D dirty-after observation must advance the mirror and production bridge cursor',
      ]),
    );
  });

  it('creates a real fixed worktree commit and then makes only its overlap file dirty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p505-phase-d-'));
    roots.push(root);
    const repoPath = join(root, 'store.git');
    const worktreePath = join(root, 'worktree');
    await mkdir(worktreePath);
    const run = async (args: string[], cwd: string): Promise<string> => {
      const result = await defaultRunGit(args, cwd);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await run(['init', '--bare', '-q', repoPath], root);
    await run(['init', '-q', '-b', 'main'], worktreePath);
    await writeFile(join(worktreePath, 'base.txt'), 'base\n');
    await run(['add', 'base.txt'], worktreePath);
    await run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], worktreePath);
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const mutation = await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-real-1', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    expect(mutation.headOid).toBe(await run(['rev-parse', 'HEAD'], worktreePath));
    expect(await readFile(join(worktreePath, PHASE_D_SENTINEL), 'utf8')).toBe(
      'p505-phase-d/p505-phase-d-real-1/below-steer\n',
    );
    expect(await run(['status', '--porcelain=v1'], worktreePath)).toBe('');

    const dirty = await dirtyPhysicalPhaseDWorktree({ runId: 'p505-phase-d-real-1' }, { repoPath, worktreePath, dirtLock: testDirtLock });
    expect(dirty.protectedPath).toBe(PHASE_D_SENTINEL);
    expect(await run(['status', '--porcelain=v1'], worktreePath)).toContain(PHASE_D_SENTINEL);
    expect(await run(['rev-parse', 'HEAD'], worktreePath)).toBe(mutation.headOid);
  });

  it('observes the planted dirt on a TRACKED sentinel by its exact path (P-505 run 24, WI-10003767)', async () => {
    const { repoPath, worktreePath } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    // Since P-505 run 15 the sentinel is tracked on every rig, so the planted dirt
    // is a worktree-only modification: porcelain ` M <path>`, first column a SPACE.
    await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-run-24', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    await dirtyPhysicalPhaseDWorktree({ runId: 'p505-phase-d-run-24' }, { repoPath, worktreePath, dirtLock: testDirtLock });

    // Calibration: the fixture must produce the leading-space line a trim eats, or
    // the assertions below would pass against the old trimmed parse too.
    expect((await defaultRunGit(['status', '--porcelain=v1'], worktreePath)).stdout).toBe(` M ${PHASE_D_SENTINEL}\n`);
    // Exact membership, never substring: `toContain` on the raw porcelain text is what
    // let a trimmed parse that reported `505-phase-d-overlap.txt` pass here while
    // the physical rig rejected it.
    expect(await porcelainDirtyPaths(worktreePath)).toEqual([PHASE_D_SENTINEL]);
    const noCursorRows = (async () => []) as unknown as NonNullable<Parameters<typeof capturePhysicalPhaseDObservation>[1]>['sql'];
    const observation = await capturePhysicalPhaseDObservation(
      { hostId: 'vm', runId: 'p505-phase-d-run-24', stage: 'dirty-before', integratorDeviceKey: device },
      { repoPath, worktreePath, sql: noCursorRows },
    );
    expect(observation.dirtyPaths).toEqual([PHASE_D_SENTINEL]);
    expect(observation.protectedFileSha256).toMatch(/^[0-9a-f]{64}$/);

    // A rename, an untracked file and a path needing quotes all keep their exact names.
    await writeFile(join(worktreePath, 'with space "q".txt'), 'x\n');
    await defaultRunGit(['mv', 'base.txt', 'renamed.txt'], worktreePath);
    expect(await porcelainDirtyPaths(worktreePath)).toEqual(
      [PHASE_D_SENTINEL, 'renamed.txt', 'with space "q".txt'].sort(),
    );
  });

  async function fixedWorktree(): Promise<{
    repoPath: string;
    worktreePath: string;
    run: (args: string[], cwd: string) => Promise<string>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'p505-phase-d-'));
    roots.push(root);
    const repoPath = join(root, 'store.git');
    const worktreePath = join(root, 'worktree');
    await mkdir(worktreePath);
    const run = async (args: string[], cwd: string): Promise<string> => {
      const result = await defaultRunGit(args, cwd);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await run(['init', '--bare', '-q', repoPath], root);
    await run(['init', '-q', '-b', 'main'], worktreePath);
    await writeFile(join(worktreePath, 'base.txt'), 'base\n');
    await run(['add', 'base.txt'], worktreePath);
    await run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], worktreePath);
    return { repoPath, worktreePath, run };
  }

  it('re-creates the below-steer head on a rig where a prior run already committed the sentinel', async () => {
    const { repoPath, worktreePath, run } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const first = await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-run-15', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    // P-505 run 15 left exactly this state on the VM: the sentinel tracked and clean.
    const second = await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-run-16', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    expect(second.baseOid).toBe(first.headOid);
    expect(second.headOid).toBe(await run(['rev-parse', 'HEAD'], worktreePath));
    expect(await readFile(join(worktreePath, PHASE_D_SENTINEL), 'utf8')).toBe(
      'p505-phase-d/p505-phase-d-run-16/below-steer\n',
    );
    // Reusing a runId would commit nothing new, so it is refused rather than faked.
    await run(['reset', '-q', '--hard', first.headOid], worktreePath);
    await expect(
      createPhysicalPhaseDMutation(
        { runId: 'p505-phase-d-run-15', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
        { repoPath, worktreePath },
      ),
    ).rejects.toThrow('refuses to reuse a runId');
  });

  it('refuses a base that conflicts with canonical staging but accepts one that only lags it', async () => {
    // P-505 run 22: run 21's leaked dirt commit sat under the VM head and edited the overlap
    // file differently from canonical staging, so the integrator parked every later VM head.
    const { repoPath, worktreePath, run } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const commit = async (file: string, body: string, msg: string): Promise<string> => {
      await writeFile(join(worktreePath, file), body);
      await run(['add', file], worktreePath);
      await run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], worktreePath);
      return run(['rev-parse', 'HEAD'], worktreePath);
    };
    const base = await run(['rev-parse', 'HEAD'], worktreePath);
    // Lagging: canonical moved on a path the mutation does not touch, and HEAD
    // diverged on another unrelated path, so both merges stay clean.
    const towerOnly = await commit('tower.txt', 't\n', 'staging edits an unrelated path');
    await run(['push', '-q', repoPath, `${towerOnly}:refs/hive/staging`], worktreePath);
    await run(['reset', '-q', '--hard', base], worktreePath);
    await commit('unrelated.txt', 'x\n', 'unrelated');
    const lagging = await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-lag-1', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    expect(lagging.headOid).toBe(await run(['rev-parse', 'HEAD'], worktreePath));

    // Residue: HEAD carries a commit that edits the overlap file differently from canonical.
    await run(['reset', '-q', '--hard', base], worktreePath);
    const staging = await commit(PHASE_D_SENTINEL, 'tower overlap\n', 'staging edits overlap');
    await run(['push', '-q', '-f', repoPath, `${staging}:refs/hive/staging`], worktreePath);
    await run(['reset', '-q', '--hard', base], worktreePath);
    await commit(PHASE_D_SENTINEL, 'leaked vm dirt\n', 'sync(root): leaked dirt');
    const before = await run(['rev-parse', 'HEAD'], worktreePath);
    await expect(
      createPhysicalPhaseDMutation(
        { runId: 'p505-phase-d-conflict-1', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
        { repoPath, worktreePath },
      ),
    ).rejects.toThrow(new RegExp(`conflicts with canonical staging ${staging.slice(0, 12)} on ${PHASE_D_SENTINEL}`));
    // Refusal happens before any write: no new commit, and the tree stays clean.
    expect(await run(['rev-parse', 'HEAD'], worktreePath)).toBe(before);
    expect(await run(['status', '--porcelain'], worktreePath)).toBe('');
  });

  it('refuses a base that trails a canonical staging which rewrote the sentinel (P-505 run 25, WI-10003772)', async () => {
    // Run 25: the VM worktree sat at 489e075, the PARENT of canonical daee50f, which had
    // rewritten the sentinel. The base alone merges cleanly (it is an ancestor), but the
    // mutation rewrites the sentinel too, so the integrator hit a content conflict.
    const { repoPath, worktreePath, run } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const base = await run(['rev-parse', 'HEAD'], worktreePath);
    await writeFile(join(worktreePath, PHASE_D_SENTINEL), 'p505-phase-d/run-24/dirty-overlap\n');
    await run(['add', PHASE_D_SENTINEL], worktreePath);
    await run(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tower advance'], worktreePath);
    const staging = await run(['rev-parse', 'HEAD'], worktreePath);
    await run(['push', '-q', repoPath, `${staging}:refs/hive/staging`], worktreePath);
    await run(['reset', '-q', '--hard', base], worktreePath);

    await expect(
      createPhysicalPhaseDMutation(
        { runId: 'p505-phase-d-run-25', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
        { repoPath, worktreePath },
      ),
    ).rejects.toThrow(
      new RegExp(`trails canonical staging ${staging.slice(0, 12)}, which rewrote ${PHASE_D_SENTINEL.replace('.', '\\.')}`),
    );
    expect(await run(['rev-parse', 'HEAD'], worktreePath)).toBe(base);
    expect(await run(['status', '--porcelain'], worktreePath)).toBe('');

    // Once the worktree catches up to canonical, the same mutation is accepted on top of it.
    await run(['merge', '-q', '--ff-only', staging], worktreePath);
    const caughtUp = await createPhysicalPhaseDMutation(
      { runId: 'p505-phase-d-run-25', kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    expect(caughtUp.baseOid).toBe(staging);
  });

  it('discards only its own planted dirt and refuses anything else', async () => {
    const { repoPath, worktreePath, run } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const runId = 'p505-phase-d-reset-1';
    const mutation = await createPhysicalPhaseDMutation(
      { runId, kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath },
    );
    expect(await resetPhysicalPhaseDDirt({ runId }, { repoPath, worktreePath, dirtLock: testDirtLock })).toMatchObject({
      reset: false,
      reason: 'already-clean',
    });

    await dirtyPhysicalPhaseDWorktree({ runId }, { repoPath, worktreePath, dirtLock: testDirtLock });
    await expect(
      resetPhysicalPhaseDDirt({ runId: 'p505-phase-d-other-run' }, { repoPath, worktreePath, dirtLock: testDirtLock }),
    ).rejects.toThrow('did not plant in this run');
    expect(await resetPhysicalPhaseDDirt({ runId }, { repoPath, worktreePath, dirtLock: testDirtLock })).toMatchObject({
      reset: true,
      reason: 'discarded-run-dirt',
    });
    expect(await run(['status', '--porcelain=v1'], worktreePath)).toBe('');
    expect(await run(['rev-parse', 'HEAD'], worktreePath)).toBe(mutation.headOid);

    // Someone else's edit beside the probe file is real work: never discarded.
    await dirtyPhysicalPhaseDWorktree({ runId }, { repoPath, worktreePath, dirtLock: testDirtLock });
    await writeFile(join(worktreePath, 'base.txt'), 'a peer edit\n');
    await expect(resetPhysicalPhaseDDirt({ runId }, { repoPath, worktreePath, dirtLock: testDirtLock })).rejects.toThrow(
      'did not plant in this run',
    );
    expect(await readFile(join(worktreePath, 'base.txt'), 'utf8')).toBe('a peer edit\n');
  });

  // WI-10003741 (P-505 run 21): without a live file lock the VM's git-sync committed the
  // planted file (17c13c5 'sync(root): p505-phase-d-overlap.txt'), so the dirty-bridge
  // contract could never hold. The lock is what git-sync's live-lock exclusion honours.
  it('holds a live file lock on the planted dirt from before the write until reset', async () => {
    const { repoPath, worktreePath } = await fixedWorktree();
    const device = generateEd25519KeypairDer().pubkeyBase64;
    const runId = 'p505-phase-d-lock-1';
    await createPhysicalPhaseDMutation(
      { runId, kind: 'below-steer', sourceHost: 'vm', sourceDeviceKey: device },
      { repoPath, worktreePath, dirtLock: testDirtLock },
    );
    const lock = recordingDirtLock(() => join(worktreePath, PHASE_D_SENTINEL));

    const dirty = await dirtyPhysicalPhaseDWorktree({ runId }, { repoPath, worktreePath, dirtLock: lock });
    expect(lock.calls).toHaveLength(1);
    expect(lock.calls[0]).toMatchObject({
      op: 'acquire',
      input: {
        coordinationDomain: worktreePath,
        owner: phaseDDirtLockOwner(runId),
        path: PHASE_D_SENTINEL,
        ttlSec: PHASE_D_DIRT_LOCK_TTL_SEC,
      },
      // Acquired while the sentinel still held its committed content: lock first, then write.
      sentinelContent: `p505-phase-d/${runId}/below-steer\n`,
    });
    expect(dirty.lock).toMatchObject({ lockId: 'lock-1', owner: phaseDDirtLockOwner(runId) });
    expect(PHASE_D_DIRT_LOCK_TTL_SEC).toBeGreaterThanOrEqual(1200);

    expect(await resetPhysicalPhaseDDirt({ runId }, { repoPath, worktreePath, dirtLock: lock })).toMatchObject({
      reset: true,
      locksReleased: 1,
    });
    expect(lock.calls.at(-1)).toMatchObject({
      op: 'release',
      input: { coordinationDomain: worktreePath, owner: phaseDDirtLockOwner(runId) },
    });

    // A refused reset (someone else's edit present) still releases the run's lock.
    await dirtyPhysicalPhaseDWorktree({ runId }, { repoPath, worktreePath, dirtLock: lock });
    await writeFile(join(worktreePath, 'base.txt'), 'a peer edit\n');
    const before = lock.calls.length;
    await expect(resetPhysicalPhaseDDirt({ runId }, { repoPath, worktreePath, dirtLock: lock })).rejects.toThrow(
      'did not plant in this run',
    );
    expect(lock.calls.slice(before)).toEqual([
      { op: 'release', input: { coordinationDomain: worktreePath, owner: phaseDDirtLockOwner(runId) } },
    ]);
  });
});

type TrustRow = {
  trusted_github_user_id: number;
  tier: string | null;
  gate: boolean;
  note: string | null;
  expires_at: Date | null;
  created_ts: number;
  updated_ts: number;
};

/**
 * An in-memory stand-in for the four comms_trust_list statements the hold and
 * restore drive (list, point-read, upsert, delete) plus the audit append. It
 * matches on statement text so a changed query fails loudly instead of passing.
 */
function fakeTrustSql(initial: TrustRow[] = []) {
  const rows = new Map<number, TrustRow>(initial.map((r) => [r.trusted_github_user_id, { ...r }]));
  const audit: string[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('INSERT INTO harness_shared.audit_log')) {
      audit.push(String(values[3]));
      return Promise.resolve([]);
    }
    if (text.includes('INSERT INTO harness_shared.comms_trust_list')) {
      const [, id, tier, note, expires, created, updated] = values as [
        string,
        number,
        string,
        string | null,
        Date | null,
        number,
        number,
      ];
      const existing = rows.get(id);
      const row: TrustRow = {
        trusted_github_user_id: id,
        tier,
        gate: existing?.gate ?? false,
        note,
        expires_at: expires,
        created_ts: existing?.created_ts ?? created,
        updated_ts: updated,
      };
      rows.set(id, row);
      return Promise.resolve([row]);
    }
    if (text.includes('DELETE FROM harness_shared.comms_trust_list')) {
      const id = values[1] as number;
      return Promise.resolve(rows.delete(id) ? [{ trusted_github_user_id: id }] : []);
    }
    if (text.includes('FROM harness_shared.comms_trust_list') && text.includes('LIMIT 1')) {
      const row = rows.get(values[1] as number);
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes('FROM harness_shared.comms_trust_list')) return Promise.resolve([...rows.values()]);
    throw new Error(`unexpected statement: ${text}`);
  };
  return { sql: sql as unknown as NonNullable<Parameters<typeof holdPhysicalPhaseDBelowSteer>[1]>['sql'], rows, audit };
}

describe('P-505 Phase D below-steer tier hold (WI-10003723)', () => {
  const vmDevicePubkey = generateEd25519KeypairDer().pubkeyBase64;
  const vmUser = 1567022;
  const ownerSteerRow: TrustRow = {
    trusted_github_user_id: vmUser,
    tier: 'steer',
    gate: false,
    note: "Owner's mac device identity - same canary auto-integrate unblock.",
    expires_at: null,
    created_ts: 1_790_000_000_000,
    updated_ts: 1_790_000_000_000,
  };

  async function holdDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'p505-phase-d-tier-'));
    roots.push(root);
    return join(root, PHASE_D_TIER_HOLD_FILE);
  }

  function deps(fake: ReturnType<typeof fakeTrustSql>) {
    return {
      sql: fake.sql,
      resolveGithubUserId: async (device: string) => (device === vmDevicePubkey ? vmUser : null),
      loadPolicyDefaultTier: async () => undefined,
      nowMs: () => 1_790_500_000_000,
    };
  }

  it('holds a steer-pinned VM user below steer, then restores the exact prior row', async () => {
    const fake = fakeTrustSql([ownerSteerRow]);
    const holdPath = await holdDir();
    const hold = await holdPhysicalPhaseDBelowSteer(
      { vmDevicePubkey, runId: 'p505-physical-run-16', holdPath },
      deps(fake),
    );
    expect(hold.held.effective).toEqual({ tier: 'message', source: 'override' });
    expect(fake.rows.get(vmUser)?.tier).toBe('message');
    const record = JSON.parse(await readFile(holdPath, 'utf8'));
    expect(record).toMatchObject({
      schemaVersion: PHASE_D_TIER_HOLD_SCHEMA,
      workspaceId: PHASE_D_WORKSPACE,
      githubUserId: vmUser,
      prior: { tier: 'steer', note: ownerSteerRow.note, expiresAtMs: null, gate: false },
    });
    await expect(
      holdPhysicalPhaseDBelowSteer({ vmDevicePubkey, runId: 'p505-physical-run-17', holdPath }, deps(fake)),
    ).rejects.toThrow('tier hold already exists');

    const restored = await restorePhysicalPhaseDTier({ holdPath }, deps(fake));
    expect(restored).toMatchObject({ restored: true, githubUserId: vmUser });
    const row = fake.rows.get(vmUser)!;
    expect([row.tier, row.note, row.expires_at, row.gate, row.created_ts]).toEqual([
      'steer',
      ownerSteerRow.note,
      null,
      false,
      ownerSteerRow.created_ts,
    ]);
    expect(fake.audit).toEqual(['trust:comms-set', 'trust:comms-set']);
    // Idempotent: the EXIT-trap restore after a normal restore is a no-op.
    expect(await restorePhysicalPhaseDTier({ holdPath }, deps(fake))).toMatchObject({
      restored: false,
      reason: 'no-hold',
    });
  });

  it('removes the row it created when the VM user had no prior override', async () => {
    const fake = fakeTrustSql();
    const holdPath = await holdDir();
    await holdPhysicalPhaseDBelowSteer({ vmDevicePubkey, runId: 'p505-physical-run-16', holdPath }, deps(fake));
    expect(fake.rows.get(vmUser)?.tier).toBe('message');
    await restorePhysicalPhaseDTier({ holdPath }, deps(fake));
    expect(fake.rows.has(vmUser)).toBe(false);
    expect(fake.audit).toEqual(['trust:comms-set', 'trust:comms-remove']);
  });

  it('refuses holds it could not restore exactly or cannot attribute', async () => {
    const gateOnly = fakeTrustSql([{ ...ownerSteerRow, tier: null, gate: true }]);
    await expect(
      holdPhysicalPhaseDBelowSteer(
        { vmDevicePubkey, runId: 'p505-physical-run-16', holdPath: await holdDir() },
        deps(gateOnly),
      ),
    ).rejects.toThrow('gate-only');
    expect(gateOnly.rows.get(vmUser)?.tier).toBeNull();

    const unmapped = fakeTrustSql([ownerSteerRow]);
    await expect(
      holdPhysicalPhaseDBelowSteer(
        {
          vmDevicePubkey: generateEd25519KeypairDer().pubkeyBase64,
          runId: 'p505-physical-run-16',
          holdPath: await holdDir(),
        },
        deps(unmapped),
      ),
    ).rejects.toThrow('attested hive member');
    expect(unmapped.rows.get(vmUser)?.tier).toBe('steer');

    await expect(
      holdPhysicalPhaseDBelowSteer(
        { vmDevicePubkey, runId: 'p505-physical-run-16', holdPath: join(tmpdir(), 'elsewhere.json') },
        deps(unmapped),
      ),
    ).rejects.toThrow(PHASE_D_TIER_HOLD_FILE);
  });

  it('keeps a malformed hold record instead of guessing a restore', async () => {
    const fake = fakeTrustSql([ownerSteerRow]);
    const holdPath = await holdDir();
    await writeFile(holdPath, JSON.stringify({ schemaVersion: PHASE_D_TIER_HOLD_SCHEMA, githubUserId: -1 }));
    await expect(restorePhysicalPhaseDTier({ holdPath }, deps(fake))).rejects.toThrow('malformed');
    expect(await readFile(holdPath, 'utf8')).toContain(PHASE_D_TIER_HOLD_SCHEMA);
    expect(fake.rows.get(vmUser)?.tier).toBe('steer');
  });
});

describe('P-505 Phase D event capture waits for the one signed event (WI-10003787)', () => {
  type EventRow = { id: number; observed_at: string; body: Record<string, unknown> };
  type CaptureSql = NonNullable<Parameters<typeof capturePhysicalPhaseDEvent>[1]>['sql'];

  async function signedRow(
    id: number,
    seq: number,
    stagingSha: string,
    tower: ReturnType<typeof generateEd25519KeypairDer>,
  ): Promise<EventRow> {
    const payload = await signStagingAdvance(
      { devicePubkeyBase64: tower.pubkeyBase64, epoch: 4, seq, stagingSha, nowMs: Date.parse('2026-09-29T00:05:00Z') },
      (bytes) => Promise.resolve(signWithPrivateKeyDer(tower.privateKeyDer, bytes)),
    );
    return {
      id,
      observed_at: '2026-09-29 00:05:03.933+00',
      body: {
        fed_event: { key: 'pot-git:staging-advance', source: 'git-sync-integrator', repo_key: 'gh-1303510992', payload },
      },
    };
  }

  /** A fake sql that answers successive queries from `batches`, repeating the last one. */
  function scriptedSql(batches: EventRow[][]): { sql: CaptureSql; queries: () => number } {
    let calls = 0;
    const sql = (async () => {
      const batch = batches[Math.min(calls, batches.length - 1)] ?? [];
      calls += 1;
      return batch;
    }) as unknown as CaptureSql;
    return { sql, queries: () => calls };
  }

  /** A virtual clock: sleep advances time instead of waiting. */
  function virtualClock(): { nowMs: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let now = Date.parse('2026-09-29T00:04:00Z');
    const sleeps: number[] = [];
    return {
      nowMs: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      sleeps,
    };
  }

  it('keeps polling while the event has not landed and returns it once it does (run 27 shape)', async () => {
    const tower = generateEd25519KeypairDer();
    const head = oid('e');
    const row = await signedRow(22035519, 56, head, tower);
    const fake = scriptedSql([[], [], [row]]);
    const clock = virtualClock();
    const event = await capturePhysicalPhaseDEvent(
      { hostId: 'tower', afterRowId: 0, integratorDeviceKey: tower.pubkeyBase64, stagingSha: head, waitMs: 600_000 },
      { sql: fake.sql, nowMs: clock.nowMs, sleep: clock.sleep },
    );
    expect(event.schemaVersion).toBe(PHASE_D_EVENT_SCHEMA);
    expect(event.rowId).toBe(22035519);
    expect(event.payload.seq).toBe(56);
    expect(fake.queries()).toBe(3);
    expect(clock.sleeps).toEqual([PHASE_D_EVENT_POLL_MS, PHASE_D_EVENT_POLL_MS]);
  });

  it('fails at once on two signed events for one head instead of waiting them out', async () => {
    const tower = generateEd25519KeypairDer();
    const head = oid('e');
    const fake = scriptedSql([[await signedRow(54, 54, head, tower), await signedRow(55, 55, head, tower)]]);
    const clock = virtualClock();
    await expect(
      capturePhysicalPhaseDEvent(
        { hostId: 'tower', afterRowId: 0, integratorDeviceKey: tower.pubkeyBase64, stagingSha: head, waitMs: 600_000 },
        { sql: fake.sql, nowMs: clock.nowMs, sleep: clock.sleep },
      ),
    ).rejects.toThrow(PHASE_D_EVENT_DUPLICATE_MARKER);
    expect(fake.queries()).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('ignores events for other heads, other devices and unsigned rows while waiting', async () => {
    const tower = generateEd25519KeypairDer();
    const other = generateEd25519KeypairDer();
    const head = oid('e');
    const noise = [
      await signedRow(1, 1, oid('f'), tower),
      await signedRow(2, 2, head, other),
      { id: 3, observed_at: '2026-09-29 00:05:00+00', body: { fed_event: { source: 'git-sync-integrator', payload: {} } } },
    ];
    const fake = scriptedSql([noise, [...noise, await signedRow(4, 3, head, tower)]]);
    const clock = virtualClock();
    const event = await capturePhysicalPhaseDEvent(
      { hostId: 'vm', afterRowId: 0, integratorDeviceKey: tower.pubkeyBase64, stagingSha: head, waitMs: 60_000 },
      { sql: fake.sql, nowMs: clock.nowMs, sleep: clock.sleep },
    );
    expect(event.rowId).toBe(4);
    expect(fake.queries()).toBe(2);
  });

  it('gives up at the deadline with a not-arrived error, and a zero wait reads exactly once', async () => {
    const tower = generateEd25519KeypairDer();
    const head = oid('e');
    const input = { hostId: 'tower' as const, afterRowId: 0, integratorDeviceKey: tower.pubkeyBase64, stagingSha: head };

    const waiting = scriptedSql([[]]);
    const clock = virtualClock();
    await expect(
      capturePhysicalPhaseDEvent({ ...input, waitMs: 12_000 }, { sql: waiting.sql, nowMs: clock.nowMs, sleep: clock.sleep }),
    ).rejects.toThrow(/expected exactly one signed production staging event.*none arrived within 12s/);
    expect(clock.sleeps).toEqual([PHASE_D_EVENT_POLL_MS, PHASE_D_EVENT_POLL_MS, 2_000]);
    expect(waiting.queries()).toBe(4);

    const once = scriptedSql([[]]);
    const idle = virtualClock();
    await expect(
      capturePhysicalPhaseDEvent(input, { sql: once.sql, nowMs: idle.nowMs, sleep: idle.sleep }),
    ).rejects.toThrow('none arrived within 0s');
    expect(once.queries()).toBe(1);
    expect(idle.sleeps).toEqual([]);
  });

  it('caps the wait at the scenario phase deadline', async () => {
    const tower = generateEd25519KeypairDer();
    const fake = scriptedSql([[]]);
    const clock = virtualClock();
    const started = clock.nowMs();
    await expect(
      capturePhysicalPhaseDEvent(
        { hostId: 'tower', afterRowId: 0, integratorDeviceKey: tower.pubkeyBase64, stagingSha: oid('e'), waitMs: 10 * PHASE_D_EVENT_WAIT_MAX_MS },
        { sql: fake.sql, nowMs: clock.nowMs, sleep: clock.sleep },
      ),
    ).rejects.toThrow(`none arrived within ${PHASE_D_EVENT_WAIT_MAX_MS / 1000}s`);
    expect(clock.nowMs() - started).toBe(PHASE_D_EVENT_WAIT_MAX_MS);
  });
});
