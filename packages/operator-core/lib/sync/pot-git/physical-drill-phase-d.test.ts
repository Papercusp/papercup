import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { signStagingAdvance } from './staging-advance';
import { defaultRunGit } from './storage';
import { physicalDrillGitSyncSlug } from './physical-drill-phase-a';
import {
  PHASE_D_EVENT_SCHEMA,
  PHASE_D_INPUT_SCHEMA,
  PHASE_D_MUTATION_SCHEMA,
  PHASE_D_OBSERVATION_SCHEMA,
  PHASE_D_RATIFICATION_SCHEMA,
  PHASE_D_SENTINEL,
  createPhysicalPhaseDMutation,
  dirtyPhysicalPhaseDWorktree,
  validatePhysicalPhaseD,
  type PhysicalPhaseDInput,
  type PhysicalPhaseDObservation,
  type PhysicalPhaseDTrigger,
} from './physical-drill-phase-d';

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
    repoPath: `/${input.hostId}/.papercusp/pot-git/hello-world-3-pot/gh-1296269.git`,
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
    repoKey: 'gh-1296269',
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
        repoKey: 'gh-1296269',
        payload: firstAdvance,
      },
      destinationEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'vm',
        rowId: 501,
        observedAt: '2026-08-13T20:04:10.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1296269',
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
        repoKey: 'gh-1296269',
        payload: secondAdvance,
      },
      destinationEvent: {
        schemaVersion: PHASE_D_EVENT_SCHEMA,
        hostId: 'vm',
        rowId: 502,
        observedAt: '2026-08-13T20:08:10.000Z',
        key: 'pot-git:staging-advance',
        source: 'git-sync-integrator',
        repoKey: 'gh-1296269',
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

    const dirty = await dirtyPhysicalPhaseDWorktree({ runId: 'p505-phase-d-real-1' }, { repoPath, worktreePath });
    expect(dirty.protectedPath).toBe(PHASE_D_SENTINEL);
    expect(await run(['status', '--porcelain=v1'], worktreePath)).toContain(PHASE_D_SENTINEL);
    expect(await run(['rev-parse', 'HEAD'], worktreePath)).toBe(mutation.headOid);
  });
});
