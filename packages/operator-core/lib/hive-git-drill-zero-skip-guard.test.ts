/**
 * D-002 / P-505 — the canonical hive-git drill has two legitimate verdicts:
 *
 *  - its default single-box scaffold may pass while explicitly inventorying
 *    rig-gated legs as SKIP; and
 *  - release acceptance must refuse every remaining skip.
 *
 * Extract the real summary block from the shipping bash script so this test
 * fails if its exit semantics drift without running the heavyweight drill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { physicalDrillSigningBytes, validatePhysicalDrillEvidence } from './sync/pot-git/physical-drill-evidence';
import { physicalDrillHostReceiptSigningBytes } from './sync/pot-git/physical-drill-host-receipt';
import { PHASE_A_REPO_KEY, physicalDrillGitSyncSlug } from './sync/pot-git/physical-drill-phase-a';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from './identity/ed25519';
import { stagingAdvanceSigningBytes } from './sync/pot-git/staging-advance';
import {
  PHASE_G_INPUT_SCHEMA,
  executePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './sync/pot-git/physical-drill-phase-g';
import { buildPhysicalPhaseHInput } from './sync/pot-git/physical-drill-phase-h.fixture';
import { buildPhysicalPhaseIInput } from './sync/pot-git/physical-drill-phase-i.fixture';
import { buildPhysicalPhaseJInput } from './sync/pot-git/physical-drill-phase-j.fixture';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/hive-git-drill.sh');
}

const drill = readFileSync(join(repoRoot(), 'papercusp-desktop', 'bin', 'hive-git-drill.sh'), 'utf8');
const physicalProbe = readFileSync(
  join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-probe.sh'),
  'utf8',
);
const physicalScenarioPath = join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-scenario.sh');
const physicalScenario = readFileSync(physicalScenarioPath, 'utf8');
const capabilityBashJobs = readFileSync(
  join(repoRoot(), 'packages', 'operator-core', 'lib', 'agent-tools', 'capability', 'bash-jobs.ts'),
  'utf8',
);
const gitSyncAction = readFileSync(
  join(repoRoot(), 'packages', 'operator-core', 'lib', 'harness', 'git-sync', 'git-sync-action.ts'),
  'utf8',
);
const gateMatch = drill.match(/# ZERO-SKIP-RELEASE-GATE-BEGIN[^\n]*\n([\s\S]*?)# ZERO-SKIP-RELEASE-GATE-END/);
const sourceOverlayMatch = physicalProbe.match(
  /\/\/ VM-RUN-SOURCE-OVERLAY-BEGIN\n([\s\S]*?)\/\/ VM-RUN-SOURCE-OVERLAY-END/,
);
const failureDiagnosticCleanupMatch = physicalProbe.match(
  /# FAILED-RUN-DIAGNOSTIC-CLEANUP-BEGIN\n([\s\S]*?)# FAILED-RUN-DIAGNOSTIC-CLEANUP-END/,
);

const evidenceDir = mkdtempSync(join(tmpdir(), 'hive-git-physical-evidence-'));
const trustByFixture = new WeakMap<Record<string, any>, Record<string, any>>();
const validatorPath = join(
  repoRoot(),
  'packages',
  'operator-core',
  'lib',
  'sync',
  'pot-git',
  'physical-drill-evidence.ts',
);
const VALIDATOR_CLI_TIMEOUT_MS = 120_000;
const VALIDATOR_TEST_TIMEOUT_MS = VALIDATOR_CLI_TIMEOUT_MS + 30_000;
const physicalRunId = 'physical-run-2026-08-13T120000Z';
let physicalPhaseGBaseline: PhysicalPhaseGInput;

beforeAll(async () => {
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const result = await executePhysicalPhaseG(
    { runId: physicalRunId, towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    { now: () => '2026-08-13T12:20:00Z' },
  );
  physicalPhaseGBaseline = {
    schemaVersion: PHASE_G_INPUT_SCHEMA,
    runId: physicalRunId,
    window: { startedAt: '2026-08-13T12:19:00Z', finishedAt: '2026-08-13T12:21:00Z' },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    result,
  };
}, 60_000);
afterAll(() => rmSync(evidenceDir, { recursive: true, force: true }));

function physicalLegD(
  tower: ReturnType<typeof generateEd25519KeypairDer>,
  vm: ReturnType<typeof generateEd25519KeypairDer>,
): Record<string, any> {
  const runId = 'physical-run-2026-08-13T120000Z';
  const base = 'a'.repeat(40);
  const first = 'b'.repeat(40);
  const second = 'c'.repeat(40);
  const dirtyHash = 'd'.repeat(64);
  const advance = (seq: number, stagingSha: string, ts: number) => {
    const payload = {
      v: 1,
      device_pubkey: tower.pubkeyBase64,
      epoch: 9,
      seq,
      staging_sha: stagingSha,
      ts,
    };
    return {
      ...payload,
      sig: signWithPrivateKeyDer(tower.privateKeyDer, stagingAdvanceSigningBytes(payload)).toString('base64'),
    };
  };
  const firstAdvance = advance(1, first, Date.parse('2026-08-13T12:12:00Z'));
  const secondAdvance = advance(2, second, Date.parse('2026-08-13T12:17:00Z'));
  const trigger = (host: 'tower' | 'vm', role: string, startedAt: string, finishedAt: string) => ({
    tool: 'git-sync:run',
    installSlug: physicalDrillGitSyncSlug(host),
    host,
    role,
    fired: true,
    startedAt,
    finishedAt,
  });
  const observation = (input: {
    hostId: 'tower' | 'vm';
    stage: string;
    stagingSha: string;
    rowId: number;
    seq: number;
    observedAt: string;
    worktreeHead?: string;
    dirty?: boolean;
  }) => ({
    schemaVersion: 'hive-git-physical-phase-d-observation/v1',
    hostId: input.hostId,
    runId,
    stage: input.stage,
    observedAt: input.observedAt,
    repoPath: `/${input.hostId}/.papercusp/pot-git/hello-world-3-pot/${PHASE_A_REPO_KEY}.git`,
    worktreePath: `/${input.hostId}/hello-world-3-pot`,
    integratorDeviceKey: tower.pubkeyBase64,
    integratorNamespaceStagingOid: input.stagingSha,
    canonicalStagingOid: input.stagingSha,
    worktreeHeadOid: input.worktreeHead ?? input.stagingSha,
    dirtyPaths: input.dirty ? ['p505-phase-d-overlap.txt'] : [],
    protectedPath: 'p505-phase-d-overlap.txt',
    protectedFileSha256: input.dirty ? dirtyHash : null,
    cursor: {
      lastEventId: input.rowId,
      epochSeq: { epoch: 9, seq: input.seq },
      stagingSha: input.stagingSha,
    },
  });
  const event = (hostId: 'tower' | 'vm', rowId: number, observedAt: string, payload: Record<string, any>) => ({
    schemaVersion: 'hive-git-physical-phase-d-event/v1',
    hostId,
    rowId,
    observedAt,
    key: 'pot-git:staging-advance',
    source: 'git-sync-integrator',
    repoKey: PHASE_A_REPO_KEY,
    payload,
  });
  const pending = {
    workspaceId: 'papercusp-workspace',
    potSlug: 'hello-world-3-pot',
    repoKey: PHASE_A_REPO_KEY,
    devicePubkey: vm.pubkeyBase64,
    headSha: first,
    authorGithubUserId: 4243,
    reason: 'below-steer-tier',
    state: 'pending',
    createdTs: Date.parse('2026-08-13T12:10:30Z'),
    ratifiedTs: null,
  };
  return {
    schemaVersion: 'hive-git-physical-phase-d-input/v1',
    runId,
    window: { startedAt: '2026-08-13T12:08:00Z', finishedAt: '2026-08-13T12:19:00Z' },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    belowSteer: {
      mutation: {
        schemaVersion: 'hive-git-physical-phase-d-mutation/v1',
        runId,
        kind: 'below-steer',
        sourceHost: 'vm',
        sourceDeviceKey: vm.pubkeyBase64,
        method: 'fixed-worktree-commit',
        worktreePath: '/vm/hello-world-3-pot',
        protectedPath: 'p505-phase-d-overlap.txt',
        baseOid: base,
        headOid: first,
        payloadSha256: '1'.repeat(64),
        createdAt: '2026-08-13T12:09:00Z',
      },
      publishTrigger: trigger('vm', 'below-steer-publish', '2026-08-13T12:09:10Z', '2026-08-13T12:09:30Z'),
      queueTrigger: trigger('tower', 'queue-receive', '2026-08-13T12:10:00Z', '2026-08-13T12:10:20Z'),
      pendingReceipt: pending,
      ratification: {
        schemaVersion: 'hive-git-physical-phase-d-ratification/v1',
        tool: 'ratifyIntegrationRequest',
        accepted: true,
        observedAt: '2026-08-13T12:11:00Z',
        pending,
        ratified: { ...pending, state: 'ratified', ratifiedTs: Date.parse('2026-08-13T12:11:00Z') },
      },
    },
    firstAdvance: {
      integratorTrigger: trigger('tower', 'ratified-integrate', '2026-08-13T12:11:10Z', '2026-08-13T12:11:40Z'),
      sourceEvent: event('tower', 101, '2026-08-13T12:12:01Z', firstAdvance),
      destinationEvent: event('vm', 501, '2026-08-13T12:12:10Z', firstAdvance),
      destinationTrigger: trigger('vm', 'first-bridge', '2026-08-13T12:12:20Z', '2026-08-13T12:12:40Z'),
      sourceObservation: observation({ hostId: 'tower', stage: 'first-source', stagingSha: first, rowId: 101, seq: 1, observedAt: '2026-08-13T12:12:41Z' }),
      destinationObservation: observation({ hostId: 'vm', stage: 'first-destination', stagingSha: first, rowId: 501, seq: 1, observedAt: '2026-08-13T12:12:42Z' }),
    },
    dirtyAdvance: {
      mutation: {
        schemaVersion: 'hive-git-physical-phase-d-mutation/v1',
        runId,
        kind: 'dirty-overlap',
        sourceHost: 'tower',
        sourceDeviceKey: tower.pubkeyBase64,
        method: 'fixed-worktree-commit',
        worktreePath: '/tower/hello-world-3-pot',
        protectedPath: 'p505-phase-d-overlap.txt',
        baseOid: first,
        headOid: second,
        payloadSha256: '2'.repeat(64),
        createdAt: '2026-08-13T12:15:00Z',
      },
      integratorTrigger: trigger('tower', 'dirty-integrate', '2026-08-13T12:16:10Z', '2026-08-13T12:16:40Z'),
      sourceEvent: event('tower', 102, '2026-08-13T12:17:01Z', secondAdvance),
      destinationEvent: event('vm', 502, '2026-08-13T12:17:10Z', secondAdvance),
      destinationTrigger: trigger('vm', 'dirty-bridge', '2026-08-13T12:17:20Z', '2026-08-13T12:17:40Z'),
      dirtyBefore: observation({ hostId: 'vm', stage: 'dirty-before', stagingSha: first, rowId: 501, seq: 1, observedAt: '2026-08-13T12:14:00Z', dirty: true }),
      dirtyAfter: observation({ hostId: 'vm', stage: 'dirty-after', stagingSha: second, worktreeHead: first, rowId: 502, seq: 2, observedAt: '2026-08-13T12:17:41Z', dirty: true }),
    },
  };
}

function physicalLegE(
  tower: ReturnType<typeof generateEd25519KeypairDer>,
  vm: ReturnType<typeof generateEd25519KeypairDer>,
): Record<string, any> {
  const runId = 'physical-run-2026-08-13T120000Z';
  const upstreamBefore = '1'.repeat(40);
  const ingress = '2'.repeat(40);
  const canonicalBefore = '3'.repeat(40);
  const canonicalAfter = '4'.repeat(40);
  const divergence = '5'.repeat(40);
  const clearBridge = {
    at: Date.parse('2026-08-13T12:21:40Z'),
    ran: true,
    skipped: null,
    egressTarget: 'fork',
    lastAdmitted: ingress,
    egressHead: canonicalAfter,
    divergence: 'clear',
    needsOwner: false,
    errors: [],
  };
  const trigger = (
    host: 'tower' | 'vm',
    role: string,
    startedAt: string,
    finishedAt: string,
  ) => ({
    tool: 'git-sync:run',
    installSlug: physicalDrillGitSyncSlug(host),
    host,
    role,
    fired: true,
    startedAt,
    finishedAt,
  });
  const observation = (input: {
    hostId: 'tower' | 'vm';
    deviceKey: string;
    stage: string;
    observedAt: string;
    mode: 'legacy' | 'bridged';
    canonical?: string;
    upstream?: string;
    remote?: string;
    bridge?: Record<string, any> | null;
    bridgeEscalation?: Record<string, any> | null;
  }) => ({
    schemaVersion: 'hive-git-physical-phase-e-observation/v1',
    runId,
    hostId: input.hostId,
    deviceKey: input.deviceKey,
    stage: input.stage,
    observedAt: input.observedAt,
    mode: { value: input.mode, source: 'set' },
    routine: {
      active: true,
      lastFiredAt: input.observedAt,
      pushMode: input.mode === 'bridged' ? 'commit-only:bridged' : 'legacy',
      lastStatus: 'ok',
      lastPushed: [],
      headSha: input.canonical ?? canonicalAfter,
      watchdogAlerted: false,
      watchdogErrorSweeps: 0,
      watchdogStallSweeps: 0,
      githubBridge: input.bridge ?? null,
      // WI-10004055: the finished fire whose verdict this observation read.
      fire: {
        active: false,
        phase: 'complete',
        startedAt: Date.parse(input.observedAt) - 1,
        completedAt: Date.parse(input.observedAt) - 1,
        outcomeStatus: 'nothing',
      },
    },
    refs: {
      canonicalStaging: input.canonical ?? canonicalAfter,
      upstreamDefault: input.upstream ?? ingress,
      remoteStaging: input.remote ?? canonicalAfter,
    },
    bridgeEscalation: input.bridgeEscalation ?? null,
    watchdogEscalation: null,
  });
  const watchdog = (ordinal: 1 | 2, startedAt: string, finishedAt: string) => ({
    schemaVersion: 'hive-git-physical-phase-e-watchdog/v1',
    runId,
    hostId: 'tower',
    ordinal,
    tool: 'checkGitSyncStall',
    startedAt,
    finishedAt,
    fixedRoutineActive: true,
    fixedPushMode: 'commit-only:bridged',
    fixedWatchdogAlerted: false,
    fixedWatchdogErrorSweeps: 0,
    fixedWatchdogStallSweeps: 0,
    alarmed: [],
    recovered: [],
  });
  return {
    schemaVersion: 'hive-git-physical-phase-e-input/v1',
    runId,
    window: { startedAt: '2026-08-13T12:19:00Z', finishedAt: '2026-08-13T12:28:00Z' },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    before: {
      tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'legacy-before', observedAt: '2026-08-13T12:19:10Z', mode: 'legacy', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
      vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'legacy-before', observedAt: '2026-08-13T12:19:20Z', mode: 'legacy', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
    },
    activation: {
      modeChange: {
        schemaVersion: 'hive-git-physical-phase-e-mode-change/v1',
        runId,
        hostId: 'tower',
        tool: 'setPotGitMode',
        from: 'legacy',
        to: 'bridged',
        workspaceId: 'papercusp-workspace',
        potHomeSlug: 'hello-world-3-pot',
        observedAt: '2026-08-13T12:19:30Z',
      },
      towerTrigger: trigger('tower', 'tower-member', '2026-08-13T12:19:40Z', '2026-08-13T12:19:50Z'),
      vmTrigger: trigger('vm', 'vm-member', '2026-08-13T12:20:00Z', '2026-08-13T12:20:10Z'),
      tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'bridged-member', observedAt: '2026-08-13T12:20:20Z', mode: 'bridged', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore, bridge: { ...clearBridge, at: Date.parse('2026-08-13T12:20:10Z') } }),
      vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'bridged-member', observedAt: '2026-08-13T12:20:30Z', mode: 'bridged', canonical: canonicalBefore, upstream: upstreamBefore, remote: canonicalBefore }),
    },
    healthy: {
      ingressMutation: {
        schemaVersion: 'hive-git-physical-phase-e-mutation/v1',
        runId,
        kind: 'ingress',
        hostId: 'tower',
        method: 'fixed-empty-commit-ff-push',
        remoteRole: 'upstream',
        remoteRef: 'refs/heads/main',
        baseOid: upstreamBefore,
        canonicalOid: canonicalBefore,
        headOid: ingress,
        createdAt: '2026-08-13T12:21:00Z',
      },
      ingressTrigger: trigger('tower', 'healthy-ingress', '2026-08-13T12:21:10Z', '2026-08-13T12:21:15Z'),
      integrateTrigger: trigger('tower', 'healthy-integrate', '2026-08-13T12:21:20Z', '2026-08-13T12:21:25Z'),
      egressTrigger: trigger('tower', 'healthy-egress', '2026-08-13T12:21:30Z', '2026-08-13T12:21:35Z'),
      observation: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'healthy-egress', observedAt: '2026-08-13T12:21:40Z', mode: 'bridged', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter, bridge: clearBridge }),
    },
    watchdogSweeps: [
      watchdog(1, '2026-08-13T12:22:00Z', '2026-08-13T12:22:01Z'),
      watchdog(2, '2026-08-13T12:24:00Z', '2026-08-13T12:24:01Z'),
    ],
    divergence: {
      before: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'divergence-before', observedAt: '2026-08-13T12:25:00Z', mode: 'bridged', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter, bridge: clearBridge }),
      mutation: {
        schemaVersion: 'hive-git-physical-phase-e-mutation/v1',
        runId,
        kind: 'fork-ahead',
        hostId: 'tower',
        method: 'fixed-empty-commit-ff-push',
        remoteRole: 'fork',
        remoteRef: 'refs/heads/staging',
        baseOid: canonicalAfter,
        canonicalOid: canonicalAfter,
        headOid: divergence,
        createdAt: '2026-08-13T12:25:10Z',
      },
      trigger: trigger('tower', 'divergence-egress', '2026-08-13T12:25:20Z', '2026-08-13T12:25:30Z'),
      after: observation({
        hostId: 'tower',
        deviceKey: tower.pubkeyBase64,
        stage: 'divergence-after',
        observedAt: '2026-08-13T12:25:40Z',
        mode: 'bridged',
        canonical: canonicalAfter,
        upstream: ingress,
        remote: divergence,
        // WI-10004055: the verdict of the divergence-egress fire, written after its trigger.
        bridge: { ...clearBridge, at: Date.parse('2026-08-13T12:25:35Z'), divergence: 'escalate' },
        bridgeEscalation: { signals: [{ kind: 'egress-non-ff', localSha: canonicalAfter, remoteSha: divergence }] },
      }),
      recovery: {
        schemaVersion: 'hive-git-physical-phase-e-recovery/v1',
        runId,
        hostId: 'tower',
        method: 'fixed-force-with-lease-restore',
        remoteRef: 'refs/heads/staging',
        expectedDivergenceOid: divergence,
        restoredOid: canonicalAfter,
        observedRemoteOid: canonicalAfter,
        observedAt: '2026-08-13T12:26:00Z',
      },
    },
    rollback: {
      modeChange: {
        schemaVersion: 'hive-git-physical-phase-e-mode-change/v1',
        runId,
        hostId: 'tower',
        tool: 'setPotGitMode',
        from: 'bridged',
        to: 'legacy',
        workspaceId: 'papercusp-workspace',
        potHomeSlug: 'hello-world-3-pot',
        observedAt: '2026-08-13T12:27:00Z',
      },
      towerTrigger: trigger('tower', 'rollback-observe', '2026-08-13T12:27:10Z', '2026-08-13T12:27:15Z'),
      vmTrigger: trigger('vm', 'rollback-observe', '2026-08-13T12:27:20Z', '2026-08-13T12:27:25Z'),
      tower: observation({ hostId: 'tower', deviceKey: tower.pubkeyBase64, stage: 'legacy-after', observedAt: '2026-08-13T12:27:30Z', mode: 'legacy', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter }),
      vm: observation({ hostId: 'vm', deviceKey: vm.pubkeyBase64, stage: 'legacy-after', observedAt: '2026-08-13T12:27:40Z', mode: 'legacy', canonical: canonicalAfter, upstream: ingress, remote: canonicalAfter }),
    },
  };
}

function physicalLegF(
  tower: ReturnType<typeof generateEd25519KeypairDer>,
  vm: ReturnType<typeof generateEd25519KeypairDer>,
): Record<string, any> {
  const runId = 'physical-run-2026-08-13T120000Z';
  const namespace = (deviceKey: string) => Buffer.from(deviceKey, 'base64').toString('hex');
  const hostResult = (
    hostId: 'tower' | 'vm',
    deviceKey: string,
    peerDeviceKey: string,
    observedAt: string,
  ) => {
    const live = namespace(deviceKey);
    const departed = namespace(peerDeviceKey);
    const beforeRefs = [
      `refs/namespaces/${departed}/published/v1`,
      `refs/namespaces/${live}/published/v1`,
      `refs/namespaces/${live}/published/v2`,
      `refs/namespaces/${live}/published/v3`,
      `refs/namespaces/${live}/refs/heads/work`,
    ].sort();
    const afterRefs = [
      `refs/archive/namespaces/${departed}/published/v1`,
      `refs/namespaces/${live}/published/v2`,
      `refs/namespaces/${live}/published/v3`,
      `refs/namespaces/${live}/refs/heads/work`,
    ].sort();
    return {
      schemaVersion: 'hive-git-physical-phase-f-host/v1',
      runId,
      planItem: 'P-307',
      hostId,
      deviceKey,
      peerDeviceKey,
      observedAt,
      productionSurfaces: ['gcHiveGitRepo', 'checkPublishGuard'],
      namespaces: { live, departed },
      gc: {
        beforeRefs,
        afterRefs,
        result: {
          archivedNamespaces: [departed],
          deletedRefs: [
            `refs/namespaces/${live}/published/v1`,
            `refs/namespaces/${departed}/published/v1`,
          ],
          errors: [],
          keptRefs: afterRefs.filter((ref) => ref.startsWith('refs/namespaces/')),
          reclaimedTmpPacks: 0,
          reclaimedTmpPackBytes: 0,
        },
      },
      guards: {
        clean: {
          ok: true,
          refusalCode: null,
          newObjectCount: 3,
          newTotalBytes: 280,
          oversizeCount: 0,
          secretFindingCount: 0,
          errors: [],
        },
        secret: {
          ok: false,
          refusalCode: 'secrets',
          newObjectCount: 3,
          newTotalBytes: 340,
          oversizeCount: 0,
          secretFindingCount: 1,
          errors: ['credential.txt: planted AWS access key'],
        },
        oversized: {
          ok: false,
          refusalCode: 'blob-over-cap',
          newObjectCount: 3,
          newTotalBytes: 6_400,
          oversizeCount: 1,
          secretFindingCount: 0,
          errors: ['oversized.bin: 6144 bytes > cap 4096'],
        },
      },
      temporaryReposRemoved: true,
    };
  };
  return {
    schemaVersion: 'hive-git-physical-phase-f-input/v1',
    runId,
    window: { startedAt: '2026-08-13T12:28:00Z', finishedAt: '2026-08-13T12:29:50Z' },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    hostResults: [
      hostResult('tower', tower.pubkeyBase64, vm.pubkeyBase64, '2026-08-13T12:29:00Z'),
      hostResult('vm', vm.pubkeyBase64, tower.pubkeyBase64, '2026-08-13T12:29:30Z'),
    ],
  };
}

function physicalFixture(): Record<string, any> {
  const towerLog = join(evidenceDir, 'tower.log');
  const vmLog = join(evidenceDir, 'vm.log');
  writeFileSync(towerLog, 'tower physical witness\n');
  writeFileSync(vmLog, 'vm physical witness\n');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const fixture: Record<string, any> = {
    schemaVersion: 'hive-git-physical-evidence/v3',
    plan: 'p2p-git-live-activation-2026-07-09',
    runId: physicalRunId,
    window: { startedAt: '2026-08-13T12:00:00Z', finishedAt: '2026-08-13T12:30:00Z' },
    topology: {
      kind: 'two-physical-machines',
      hosts: [
        { id: 'tower', deviceKey: tower.pubkeyBase64 },
        { id: 'vm', deviceKey: vm.pubkeyBase64 },
      ],
    },
    artifacts: [
      { host: 'tower', path: towerLog, sha256: digest(towerLog) },
      { host: 'vm', path: vmLog, sha256: digest(vmLog) },
    ],
    legVerdicts: [...'ABCDEFGHIJ'].map((leg, index) => ({
      leg,
      status: 'pass',
      scope: 'physical',
      observedAt: `2026-08-13T12:${String(index).padStart(2, '0')}:00Z`,
    })),
    legD: physicalLegD(tower, vm),
    legE: physicalLegE(tower, vm),
    legF: physicalLegF(tower, vm),
    legG: (() => {
      const input = structuredClone(physicalPhaseGBaseline);
      input.identities = { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 };
      input.result.physicalExecutionBinding = {
        provenance: 'outer-manifest-host-receipts',
        towerDeviceKey: tower.pubkeyBase64,
        vmDeviceKey: vm.pubkeyBase64,
      };
      return input;
    })(),
    legH: buildPhysicalPhaseHInput({
      runId: physicalRunId,
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
      startMs: Date.parse('2026-08-13T12:20:00Z'),
    }),
    legI: buildPhysicalPhaseIInput({
      runId: physicalRunId,
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
      startMs: Date.parse('2026-08-13T12:25:00Z'),
    }),
    // PHASE_J_FIXTURE_WINDOW_MS is 5min, so 12:24–12:29 sits inside the 12:00–12:30 run window.
    legJ: buildPhysicalPhaseJInput({
      runId: physicalRunId,
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
      startMs: Date.parse('2026-08-13T12:24:00Z'),
    }),
  };
  const bytes = physicalDrillSigningBytes(fixture);
  fixture.attestations = [tower, vm].map((device) => ({
    deviceKey: device.pubkeyBase64,
    signature: signWithPrivateKeyDer(device.privateKeyDer, bytes).toString('base64'),
  }));
  const receipts = [
    { hostId: 'tower', device: tower, githubUserId: 4242, githubLogin: 'tower-owner', fingerprint: '8'.repeat(64) },
    { hostId: 'vm', device: vm, githubUserId: 4243, githubLogin: 'vm-owner', fingerprint: '9'.repeat(64) },
  ].map(({ hostId, device, githubUserId, githubLogin, fingerprint }) => {
    const unsigned = {
      schemaVersion: 'hive-git-physical-host-receipt/v1',
      runId: fixture.runId,
      hostId,
      deviceKey: device.pubkeyBase64,
      keychainId: `${githubUserId}:${hostId}-machine`,
      githubUserId,
      githubLogin,
      machineFingerprint: fingerprint,
      evidenceSigningSha256: createHash('sha256').update(bytes).digest('hex'),
      signedAt: '2026-08-13T12:30:30.000Z',
      evidenceAttestation: fixture.attestations.find(
        (attestation: Record<string, any>) => attestation.deviceKey === device.pubkeyBase64,
      ).signature,
    };
    return {
      ...unsigned,
      signature: signWithPrivateKeyDer(device.privateKeyDer, physicalDrillHostReceiptSigningBytes(unsigned)).toString(
        'base64',
      ),
    };
  });
  trustByFixture.set(fixture, {
    schemaVersion: 'hive-git-physical-trust/v1',
    source: 'papercusp-vm-rig/v1',
    runId: fixture.runId,
    observedAt: fixture.window.finishedAt,
    hosts: receipts.map((receipt) => ({
      id: receipt.hostId,
      deviceKey: receipt.deviceKey,
      machineFingerprint: receipt.machineFingerprint,
    })),
    receipts,
  });
  return fixture;
}

function trustedPhysicalAnchor(fixture: Record<string, any>): Record<string, any> {
  const trust = trustByFixture.get(fixture);
  if (!trust) throw new Error('fixture trust anchor was not initialized');
  return trust;
}

function runGate(input: { fail: number; skipped: number; requireZeroSkips?: boolean }): {
  status: number | null;
  output: string;
} {
  expect(gateMatch, 'zero-skip release gate markers must remain in the drill').toBeTruthy();
  const script = [
    'set -uo pipefail',
    'PASS=7',
    `FAIL=${input.fail}`,
    `SKIPPED=${input.skipped}`,
    `REQUIRE_ZERO_SKIPS=${input.requireZeroSkips ? 1 : 0}`,
    gateMatch![1],
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('D-002 hive-git zero-skip release acceptance', () => {
  it('pins the current explicit skip inventory to E/P-306 and G/P-308', () => {
    const inventory = [...drill.matchAll(/^\s*skipp "LEG ([A-G]) \(P-(\d+)\)/gm)].map(
      ([, leg, item]) => `${leg}/P-${item}`,
    );
    expect(inventory).toEqual(['E/P-306', 'G/P-308']);
    expect(drill).toContain('HIVE_GIT_PHYSICAL_PROBE_CMD');
    expect(drill).toContain('physical-drill-evidence.ts');
    expect(drill).toContain('bin/vm-rig/hive-git-physical-probe.sh');
    expect(drill).not.toContain('HIVE_GIT_PHYSICAL_EVIDENCE_FILE');
  });

  it('requires durable capability:bash provenance before a physical probe can run', () => {
    expect(capabilityBashJobs).toContain('CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV');
    expect(capabilityBashJobs).toContain('enrolment.enrolled ? enrolment.taskId :');
    expect(capabilityBashJobs).toContain('const childEnv =');
    expect(drill).toContain('PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID');
    expect(drill).toContain('physical E/G adapter requires a durable capability:bash background task enrollment');
    expect(physicalProbe).toContain('physical run requires a durable capability:bash background task enrollment');
    expect(drill.indexOf('physical E/G adapter requires a durable capability:bash background task enrollment')).toBeLessThan(
      drill.indexOf('"$physical_probe_cmd" "$physical_evidence_file" "$physical_trust_file"'),
    );
  });

  it('preserves a bounded sanitized Phase A bundle only when the physical probe fails', () => {
    expect(failureDiagnosticCleanupMatch).not.toBeNull();
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'hive-git-failure-diagnostics-'));
    const failedRunRoot = join(fixtureRoot, 'failed-run');
    const successfulRunRoot = join(fixtureRoot, 'successful-run');
    const failedDiagnostics = join(fixtureRoot, 'evidence.json.failure-diagnostics');
    const successfulDiagnostics = join(fixtureRoot, 'success.json.failure-diagnostics');
    const runCleanup = (runRoot: string, diagnosticsRoot: string, status: number) => {
      const script = [
        'set -euo pipefail',
        'ssh() { return 0; }',
        'SSH_OPTS=()',
        "VM='fixture-vm'",
        "remote_source='/tmp/hive-git-physical-source.123'",
        'source_preflight=0',
        'run_dir="$1"',
        'failure_diagnostics_out="$2"',
        failureDiagnosticCleanupMatch![1],
        'trap cleanup EXIT',
        `exit ${status}`,
      ].join('\n');
      return spawnSync('bash', ['-c', script, 'diagnostic-cleanup-test', runRoot, diagnosticsRoot], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
    };

    try {
      const phaseA = join(failedRunRoot, 'phase-a');
      mkdirSync(phaseA, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(phaseA, 'bootstrap-raw.json'),
        JSON.stringify({ status: 'failed', accessToken: 'super-secret-token', publicResult: 'kept' }),
      );
      writeFileSync(
        join(phaseA, 'tower-after.json'),
        JSON.stringify({ refOid: 'a'.repeat(40), note: `token github_pat_${'A'.repeat(32)}` }),
      );
      writeFileSync(
        join(phaseA, 'verdict.err'),
        'Authorization: Bearer super-secret-token\nstrict convergence failed\n',
      );
      writeFileSync(join(phaseA, 'raw.bin'), 'not a diagnostic extension');
      writeFileSync(join(failedRunRoot, 'not-allowlisted.json'), JSON.stringify({ secret: 'must-not-copy' }));
      writeFileSync(join(failedRunRoot, 'tower-identity.json'), JSON.stringify({ privateKey: 'must-not-copy' }));
      // WI-10003767: a Phase D failure must bank the failing phase's NESTED files.
      // A hand-listed allow-list named Phase A only, so P-505 run 24 kept nothing
      // of Phase D.
      const dirtyAdvance = join(failedRunRoot, 'phase-d', 'dirty-advance');
      mkdirSync(dirtyAdvance, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dirtyAdvance, 'before-observation.json'),
        JSON.stringify({ dirtyPaths: ['505-phase-d-overlap.txt'], token: 'phase-d-secret' }),
      );
      writeFileSync(join(dirtyAdvance, 'destination-bridge-1.json'), JSON.stringify({ attempt: 1 }));
      writeFileSync(join(dirtyAdvance, 'destination-bridge-2.json'), JSON.stringify({ attempt: 2 }));
      writeFileSync(join(failedRunRoot, 'phase-d', 'verdict.err'), 'Phase D rejected\n');

      const failed = runCleanup(failedRunRoot, failedDiagnostics, 37);
      expect(failed.status).toBe(37);
      expect(failed.stderr).toContain(`preserved failed-run diagnostics at ${failedDiagnostics}`);
      expect(existsSync(failedRunRoot)).toBe(false);
      expect(existsSync(failedDiagnostics)).toBe(true);
      expect(statSync(failedDiagnostics).mode & 0o777).toBe(0o700);

      const manifest = JSON.parse(readFileSync(join(failedDiagnostics, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        schemaVersion: 'hive-git-physical-failure-diagnostics/v1',
        exitStatus: 37,
        sanitized: true,
        caps: { perFileBytes: 256 * 1024, totalBytes: 1024 * 1024 },
      });
      // Priority order under the byte cap: the latest (failing) phase first, its
      // named observations before numbered poll attempts, newest attempt first.
      expect(manifest.included.map((entry: { path: string }) => entry.path)).toEqual([
        'phase-d/dirty-advance/before-observation.json',
        'phase-d/verdict.err',
        'phase-d/dirty-advance/destination-bridge-2.json',
        'phase-d/dirty-advance/destination-bridge-1.json',
        'phase-a/bootstrap-raw.json',
        'phase-a/tower-after.json',
        'phase-a/verdict.err',
      ]);
      const phaseDObservation = readFileSync(
        join(failedDiagnostics, 'phase-d', 'dirty-advance', 'before-observation.json'),
        'utf8',
      );
      expect(phaseDObservation).toContain('505-phase-d-overlap.txt');
      expect(phaseDObservation).not.toContain('phase-d-secret');
      const banked = [
        readFileSync(join(failedDiagnostics, 'phase-a', 'bootstrap-raw.json'), 'utf8'),
        readFileSync(join(failedDiagnostics, 'phase-a', 'tower-after.json'), 'utf8'),
        readFileSync(join(failedDiagnostics, 'phase-a', 'verdict.err'), 'utf8'),
      ].join('\n');
      expect(banked).toContain('publicResult');
      expect(banked).toContain('[REDACTED]');
      expect(banked).not.toContain('super-secret-token');
      expect(banked).not.toContain('github_pat_');
      expect(existsSync(join(failedDiagnostics, 'phase-a', 'raw.bin'))).toBe(false);
      expect(existsSync(join(failedDiagnostics, 'not-allowlisted.json'))).toBe(false);
      expect(existsSync(join(failedDiagnostics, 'tower-identity.json'))).toBe(false);

      mkdirSync(join(successfulRunRoot, 'phase-a'), { recursive: true, mode: 0o700 });
      writeFileSync(join(successfulRunRoot, 'phase-a', 'verdict.json'), '{"ok":true}\n');
      const successful = runCleanup(successfulRunRoot, successfulDiagnostics, 0);
      expect(successful.status).toBe(0);
      expect(existsSync(successfulRunRoot)).toBe(false);
      expect(existsSync(successfulDiagnostics)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps the canonical producer pinned to the checked-in physical E/G scenario', () => {
    expect(physicalProbe).toContain('hive-git-physical-scenario.sh');
    expect(physicalProbe).toContain('canonical E/G scenario driver is not executable');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" preflight');
    expect(physicalProbe).toContain('HIVE_GIT_PHYSICAL_EXECUTE="$HIVE_GIT_PHYSICAL_PLAN"');
    // WI-10004062: both hosts stage the ONE commit pinned at probe start, never a
    // HEAD re-resolved per host (a git-sync commit between them would split them).
    expect(physicalProbe).toContain('git -C "$REPO_ROOT" archive --format=tar "$source_sha" --');
    expect(physicalProbe).not.toContain('git -C "$REPO_ROOT" archive --format=tar HEAD');
    expect(physicalProbe).toContain(
      'packages libs scripts package.json tsconfig.base.json',
    );
    expect(physicalProbe).not.toContain(
      'packages/operator-core libs/generic scripts package.json tsconfig.base.json',
    );
    // WI-39361 — SUBMODULE CONTENTS MUST BE STAGED FROM EACH SUBMODULE'S OWN REPO.
    // `git archive` never includes a submodule's files; it emits the bare mount-point
    // directory, silently. So the superproject archive asserted above stages ZERO
    // files for all 37 libs/ submodules, and the previous hand-rolled single archive
    // covered libs/papercusp ONLY — leaving libs/papercusp-shared (a declared
    // workspace + direct operator-core dependency) resolving on the rig to the
    // installed bundle's stale copy. That surfaced as an unresolvable import naming a
    // SYMBOL, which reads as a broken export rather than an unstaged file.
    //
    // Pin the .gitmodules-DERIVED loop specifically: a hand-list is what re-arms the
    // trap the next time a submodule is added, so "it stages libs/papercusp" is not a
    // strong enough assertion to keep.
    expect(physicalProbe).toContain('--get-regexp');
    expect(physicalProbe).toContain(
      'archive --format=tar --prefix="$sm_path/" "${staged_submodule_shas[$i]}"',
    );
    expect(physicalProbe).toContain('staged_submodules+=("$sm_path")');
    // ...and pin the recurrence guard, so a staging regression fails at the probe
    // naming the missing path instead of downstream on the rig.
    expect(physicalProbe).toContain('staged submodule tree contains NO FILES on the VM');
    expect(physicalProbe).toContain('required submodule is not initialised on the tower');
    // The overlay must derive from every staged canonical workspace registry,
    // not a root-only directory hand-list that misses nested repositories.
    expect(physicalProbe).toContain('const workspaceRegistryPaths = [...new Set([');
    expect(physicalProbe).toContain("fs.globSync('**/package.json'");
    expect(physicalProbe).toContain('const registryRoot = path.dirname(registryPath)');
    expect(physicalProbe).toContain('for (const pattern of workspacePatterns)');
    expect(physicalProbe).toContain('root package.json has no workspace registry');
    expect(physicalProbe).toContain('entry.isDirectory() || entry.isSymbolicLink()');
    expect(physicalProbe).toContain("fs.symlinkSync(packageRoot, target, 'dir')");
    // EI-20963370585400416 — staging all `packages` fixes today's omitted
    // coordination adapter, while the runtime closure check makes the whole
    // class fail before identity lookup if any direct Papercusp dependency
    // still resolves into the installed (potentially stale) bundle.
    expect(physicalProbe).toContain(".filter((name) => name.startsWith('@papercusp/'))");
    expect(physicalProbe).toContain('fs.realpathSync(target)');
    expect(physicalProbe).toContain(
      'operator-core workspace dependencies were not staged into the VM run-source overlay',
    );
    expect(physicalProbe).not.toContain(
      "ln -s '$VM_DEP_SOURCE/node_modules' '$remote_source/node_modules'",
    );
    expect(physicalProbe).toContain("VM='aviweiss@172.31.44.2'");
    expect(physicalProbe).toMatch(
      /VM_IDENTITY_DIR="\$\{PCUSP_VM_IDENTITY_DIR:-\/Users\/[^/]+\/\.papercusp-workspaces\/\.shared\/\.papercusp\/identity\}"/,
    );
    expect(physicalProbe).toContain(
      "PAPERCUSP_IDENTITY_DIR='$VM_IDENTITY_DIR' '$VM_NODE' '$VM_TSX' '$VM_PRODUCER' identity vm '$VM_CACHE'",
    );
    expect(physicalProbe).toContain(
      "PAPERCUSP_IDENTITY_DIR='$VM_IDENTITY_DIR' '$VM_NODE' '$VM_TSX' '$VM_PRODUCER' sign '$remote_unsigned' vm '$VM_CACHE'",
    );
    // The probe's VM target is the hardcoded VM= above and must never be env-overridable,
    // so the probe never READS PCUSP_VM_SSH. Its one legitimate use is handing that
    // hardcoded target to the rig-preflight producer mode as child env (P-003,
    // physical-drill-iteration-speed): every occurrence must be exactly that assignment.
    expect(physicalProbe).not.toMatch(/\$\{?PCUSP_VM_SSH/);
    for (const use of physicalProbe.matchAll(/PCUSP_VM_SSH\S*/g)) {
      expect(use[0]).toBe('PCUSP_VM_SSH="$VM"');
    }
    expect(physicalProbe).not.toContain('PCUSP_VM_PHYSICAL_PRODUCER');
    expect(physicalProbe).toContain('staged VM physical-drill producer does not match the pinned tower snapshot');
    expect(physicalProbe).toContain('tower identity command produced no JSON');
    expect(physicalProbe).toContain('VM identity command produced no JSON');
    expect(physicalProbe).toContain('HIVE_GIT_PHYSICAL_VM_SOURCE="$remote_source"');
    expect(physicalProbe).toContain("if [ \"${1:-}\" = '--source-preflight' ]");
    expect(physicalProbe).toContain('hive-git-physical-source-preflight/v1');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" phase-e-preflight');
    expect(physicalProbe.indexOf('"$TSX" "$PRODUCER" phase-e-preflight')).toBeLessThan(
      physicalProbe.indexOf('ssh "${SSH_OPTS[@]}"'),
    );
    expect(physicalProbe.indexOf('hive-git-physical-source-preflight/v1')).toBeLessThan(
      physicalProbe.indexOf('HIVE_GIT_PHYSICAL_EXECUTE="$HIVE_GIT_PHYSICAL_PLAN"'),
    );
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" sign');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" finalize');
    expect(physicalProbe).not.toContain('HIVE_GIT_PHYSICAL_SCENARIO_CMD');
    expect(existsSync(physicalScenarioPath)).toBe(true);
    expect(statSync(physicalScenarioPath).mode & 0o111).not.toBe(0);
    expect(physicalProbe.indexOf('"$SCENARIO" --require-ready')).toBeLessThan(
      physicalProbe.indexOf('ssh "${SSH_OPTS[@]}"'),
    );
  });

  it('names the missing staged VM source root instead of emitting ERR_MODULE_NOT_FOUND', () => {
    // EI-20407955869521811. The staged root reaches the scenario ONLY as
    // HIVE_GIT_PHYSICAL_VM_SOURCE on the probe's single invocation, and the
    // probe's EXIT trap removes /tmp/hive-git-physical-source.* on every run,
    // so a post-interruption caller has nothing to inherit. Before this guard
    // an unset value was pasted into VM_PRODUCER as the absolute nonsense path
    // '/packages/operator-core/lib/sync/pot-git/physical-drill-producer.ts',
    // which the VM reported as ERR_MODULE_NOT_FOUND — an error that reads as a
    // broken VM dev-source tree and sends the reader hunting there. Measured
    // 2026-09-05: the VM's dev-source tree and its tsx loader are both PRESENT,
    // so that reading was always a misdiagnosis of a missing input.
    expect(physicalScenario).toContain('HIVE_GIT_PHYSICAL_VM_SOURCE is unset');
    expect(physicalScenario).toContain('hive-git-physical-probe.sh');
    expect(physicalScenario).toContain("require_absolute 'HIVE_GIT_PHYSICAL_VM_SOURCE' \"$VM_SOURCE\"");

    // The shape check pins the same staging contract the probe's own cleanup
    // guard enforces, so a hand-supplied root (notably the installed dev-source
    // tree, which carries no producer at all) is refused by name.
    expect(physicalScenario).toContain('/tmp/hive-git-physical-source.[0-9]*) ;;');
    expect(physicalScenario).toContain('is not a probe-staged source root');
    expect(physicalProbe).toContain("case '$remote_source' in /tmp/hive-git-physical-source.[0-9]*)");

    // The absolute-path helper must be DEFINED before the VM_SOURCE gate calls
    // it; bash resolves functions at call time, so the reverse order fails with
    // a bare "command not found" and defeats the diagnostic entirely.
    expect(physicalScenario.indexOf('require_absolute() {')).toBeLessThan(
      physicalScenario.indexOf("require_absolute 'HIVE_GIT_PHYSICAL_VM_SOURCE'"),
    );

    // The destructive-execution grant is the safety gate and must speak first:
    // a caller with no grant has to be told about the grant, not about an input
    // this driver would never have used.
    expect(
      physicalScenario.indexOf('destructive physical run requires HIVE_GIT_PHYSICAL_EXECUTE'),
    ).toBeLessThan(physicalScenario.indexOf('HIVE_GIT_PHYSICAL_VM_SOURCE is unset'));

    // The refusal must name a mode that actually exists, or it reproduces the
    // very misdirection it was added to remove.
    expect(physicalScenario).toContain('--source-preflight');
    expect(physicalProbe).toContain("if [ \"${1:-}\" = '--source-preflight' ]");
  });

  it('refuses a resumed physical scenario with no staged VM source root', () => {
    // Behavioural half of the guard above. The unset leg fires before the ssh
    // probe, so this runs hermetically on any box — no VM required.
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'hive-git-vm-source-'));
    try {
      const towerIdentity = join(fixtureRoot, 'tower-identity.json');
      const vmIdentity = join(fixtureRoot, 'vm-identity.json');
      // Well-formed, DISTINCT host identities: identity validation runs before
      // the VM_SOURCE gate, so a placeholder would refuse there instead and the
      // test would never exercise the gate it exists to pin.
      const identity = (hostId: string, byte: number) => ({
        schemaVersion: 'hive-git-physical-host-identity/v1',
        hostId,
        deviceKey: Buffer.alloc(32, byte).toString('base64'),
        machineFingerprint: byte.toString(16).repeat(64),
      });
      writeFileSync(towerIdentity, JSON.stringify(identity('tower', 1)));
      writeFileSync(vmIdentity, JSON.stringify(identity('vm', 2)));

      const result = spawnSync(
        physicalScenarioPath,
        [join(fixtureRoot, 'unsigned-evidence.json'), towerIdentity, vmIdentity],
        {
          encoding: 'utf8',
          timeout: 120_000,
          killSignal: 'SIGKILL',
          env: {
            ...process.env,
            HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09',
            // The grant is the safety gate and speaks first, so it must be
            // present for the run to reach the VM_SOURCE gate at all. Nothing
            // destructive executes: the refusal below is the next statement.
            HIVE_GIT_PHYSICAL_EXECUTE: 'p2p-git-live-activation-2026-07-09',
            HIVE_GIT_PHYSICAL_VM_SOURCE: '',
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('HIVE_GIT_PHYSICAL_VM_SOURCE is unset');
      // The recovery action must be in the refusal itself, not left to be
      // rediscovered: this is the whole point of the diagnostic.
      expect(result.stderr).toContain('hive-git-physical-probe.sh');
      // The pre-fix symptom must be gone.
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(result.stderr).not.toContain(
        '/packages/operator-core/lib/sync/pot-git/physical-drill-producer.ts',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('overlays packages declared only by a nested workspace registry', () => {
    expect(sourceOverlayMatch).not.toBeNull();
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'hive-git-source-overlay-'));
    const runRoot = join(fixtureRoot, 'run');
    const installedRoot = join(fixtureRoot, 'installed');
    const writeManifest = (root: string, manifest: Record<string, unknown>) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    };

    try {
      writeManifest(runRoot, { name: 'fixture-root', workspaces: ['packages/*'] });
      writeManifest(join(runRoot, 'packages', 'operator-core'), {
        name: '@papercusp/operator-core',
        dependencies: {
          '@papercusp/root-package': '*',
          '@papercusp/file-claim': 'file:../../libs/papercusp/packages/file-claim',
        },
      });
      writeManifest(join(runRoot, 'packages', 'root-package'), { name: '@papercusp/root-package' });
      writeManifest(join(runRoot, 'libs', 'papercusp'), {
        name: 'nested-registry',
        workspaces: ['packages/*'],
      });
      writeManifest(join(runRoot, 'libs', 'papercusp', 'packages', 'file-claim'), {
        name: '@papercusp/file-claim',
      });
      mkdirSync(join(installedRoot, 'node_modules', '@papercusp', 'root-package'), { recursive: true });
      mkdirSync(join(installedRoot, 'node_modules', '@papercusp', 'file-claim'), { recursive: true });

      const result = spawnSync(process.execPath, ['-', runRoot, installedRoot], {
        input: sourceOverlayMatch![1],
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(realpathSync(join(runRoot, 'node_modules', '@papercusp', 'root-package'))).toBe(
        realpathSync(join(runRoot, 'packages', 'root-package')),
      );
      expect(realpathSync(join(runRoot, 'node_modules', '@papercusp', 'file-claim'))).toBe(
        realpathSync(join(runRoot, 'libs', 'papercusp', 'packages', 'file-claim')),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('installs the ready fixed A-I scenario but refuses physical mutation without the explicit execution grant', () => {
    const contract = spawnSync(physicalScenarioPath, ['--contract-check'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-scenario-contract/v1',
      implementationState: 'ready-v1',
      ready: true,
      phases: [...'ABCDEFGHIJ'],
      phaseContracts: {
        A: 'executor-installed',
        B: 'executor-installed',
        C: 'executor-installed',
        D: 'executor-installed',
        E: 'executor-installed',
        F: 'executor-installed',
        G: 'executor-installed',
        H: 'executor-installed',
        I: 'executor-installed',
        J: 'executor-installed',
      },
    });

    const runDir = mkdtempSync(join(evidenceDir, 'scenario-contract-'));
    const output = join(runDir, 'unsigned-evidence.json');
    const towerIdentity = join(runDir, 'tower-identity.json');
    const vmIdentity = join(runDir, 'vm-identity.json');
    const identity = (hostId: string, byte: number) => ({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId,
      deviceKey: Buffer.alloc(32, byte).toString('base64'),
      machineFingerprint: byte.toString(16).repeat(64),
    });
    writeFileSync(towerIdentity, JSON.stringify(identity('tower', 1)));
    writeFileSync(vmIdentity, JSON.stringify(identity('vm', 2)));

    const attempted = spawnSync(physicalScenarioPath, [output, towerIdentity, vmIdentity], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09',
      },
    });
    expect(attempted.status).toBe(1);
    expect(attempted.stderr).toContain(
      'destructive physical run requires HIVE_GIT_PHYSICAL_EXECUTE to equal the canonical plan slug',
    );
    expect(existsSync(output)).toBe(false);
    expect(physicalScenario).toContain('run_all_phases');
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_SCENARIO_CMD');
    expect(physicalScenario).toContain('phase-a-quarantine');
    expect(physicalScenario).toContain("'$VM_CALL' git-sync:run");
    expect(physicalScenario).toContain('phase-a-verify');
    expect(physicalScenario).toContain('physical VM source must be the canonical probe staging directory');
    expect(physicalScenario).toContain('physical VM producer digest does not match the tower');
    expect(physicalScenario.indexOf('verify_physical_vm_source')).toBeLessThan(
      physicalScenario.lastIndexOf('run_all_phases'),
    );
    expect(physicalScenario).toContain('physical_run_id="p505-physical-');
    // Phases D-H and J bind the one physical run id (A-C mint their own, by design).
    // A floor, so a phase that stops deriving it fails while a new phase needs no bump.
    expect((physicalScenario.match(/local run_id="\$physical_run_id"/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(physicalScenario.indexOf('[ "$IMPLEMENTATION_STATE" = \'ready-v1\' ]')).toBeLessThan(
      physicalScenario.lastIndexOf('run_all_phases'),
    );
  });

  it('restores a missing or stale VM driver through deploy.sh before any phase runs', () => {
    // WI-2039874 (2026-09-27): the VM's /tmp lost vmcall.sh while its operator
    // was healthy, and Phase A misreported "could not reach the VM operator".
    const fnStart = physicalScenario.indexOf('vm_driver_digests() {');
    const ensureStart = physicalScenario.indexOf('ensure_vm_driver_current() {');
    expect(fnStart).toBeGreaterThan(-1);
    expect(ensureStart).toBeGreaterThan(fnStart);
    const functions = physicalScenario.slice(fnStart, physicalScenario.indexOf('\n}\n', ensureStart) + 3);
    const callSite = physicalScenario.indexOf('\nverify_physical_vm_source\nensure_vm_driver_current\n');
    expect(callSite).toBeGreaterThan(-1);
    expect(callSite).toBeLessThan(physicalScenario.lastIndexOf('run_all_phases'));

    const root = mkdtempSync(join(tmpdir(), 'hive-git-vm-driver-'));
    try {
      const here = join(root, 'vm-rig');
      const repo = join(root, 'repo');
      const vm = join(root, 'vm');
      const bin = join(root, 'bin');
      for (const dir of [here, join(repo, 'scripts'), vm, bin]) mkdirSync(dir, { recursive: true });
      const srcCall = join(here, 'vmcall.sh');
      const srcMcp = join(repo, 'scripts', 'mcp-call.mjs');
      const vmCall = join(vm, 'vmcall.sh');
      const vmMcp = join(vm, 'mcp-call.mjs');
      const deployLog = join(root, 'deploy.log');
      writeFileSync(srcCall, '#!/bin/sh\necho vmcall-current\n');
      writeFileSync(srcMcp, '// mcp-call current\n');
      // ssh stub: drop the -o options and the host, then run the remote command locally.
      writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec bash -c "$1"\n');
      chmodSync(join(bin, 'ssh'), 0o755);

      const run = (deployRestores: boolean) => {
        rmSync(deployLog, { force: true });
        const restore = deployRestores
          ? `cp '${srcCall}' '${vmCall}'; chmod 755 '${vmCall}'; cp '${srcMcp}' '${vmMcp}'\n`
          : '';
        writeFileSync(join(here, 'deploy.sh'), `#!/usr/bin/env bash\necho "$*" >> '${deployLog}'\n${restore}`);
        chmodSync(join(here, 'deploy.sh'), 0o755);
        const script = [
          'SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)',
          'VM=stub@vm',
          `HERE='${here}'`,
          `REPO_ROOT='${repo}'`,
          `VM_CALL='${vmCall}'`,
          `VM_MCP_CALL='${vmMcp}'`,
          'DEPLOY="$HERE/deploy.sh"',
          "fail() { printf 'FAIL: %s\\n' \"$1\" >&2; exit 9; }",
          functions,
          'ensure_vm_driver_current',
          'echo DRIVER_OK',
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        const deploys = existsSync(deployLog) ? readFileSync(deployLog, 'utf8').trim().split('\n') : [];
        return { ...result, deploys };
      };

      // Missing driver (the observed incident): restored through deploy.sh, then the run proceeds.
      const missing = run(true);
      expect(missing.status, missing.stderr).toBe(0);
      expect(missing.stdout).toContain('DRIVER_OK');
      expect(missing.deploys).toEqual(['stub@vm']);
      expect(readFileSync(vmCall, 'utf8')).toBe(readFileSync(srcCall, 'utf8'));

      // Current driver: no redeploy.
      const current = run(true);
      expect(current.status, current.stderr).toBe(0);
      expect(current.deploys).toEqual([]);

      // Stale mcp-call.mjs whose deploy does not repair it: fail closed before any phase.
      writeFileSync(vmMcp, '// mcp-call stale\n');
      const stale = run(false);
      expect(stale.status).toBe(9);
      expect(stale.stdout).not.toContain('DRIVER_OK');
      expect(stale.stderr).toContain('VM driver still missing or stale after');
      expect(stale.deploys).toEqual(['stub@vm']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes a request-only-host tower git-sync refusal to the named background-worker host, and fails closed on a refused publish', () => {
    // WI-2039874, P-505 run 11 (2026-09-28): the tower's request-serving
    // operator (:3070, PAPERCUSP_BACKGROUND_WORKERS=0) refused the Phase B
    // source publish as request-only-host. The scenario wrote the refusal to
    // source-publish-raw.json and moved on, so the tower never re-signed its
    // namespace and the VM receive loop waited out a publish that never ran.
    const retryStart = physicalScenario.indexOf('git_sync_refusal_retry_url() {');
    const runStart = physicalScenario.indexOf('run_tower_git_sync() {');
    const requireStart = physicalScenario.indexOf('require_git_sync_fired() {');
    expect(retryStart).toBeGreaterThan(-1);
    expect(runStart).toBeGreaterThan(retryStart);
    expect(requireStart).toBeGreaterThan(runStart);
    const functions = physicalScenario.slice(retryStart, physicalScenario.indexOf('\n}\n', requireStart) + 3);

    // Every mutating fire whose effect a later step depends on is checked; the
    // tolerant receive/bridge polling loops are not.
    for (const site of [
      'run_tower_git_sync >"$forward_dir/source-publish-raw.json"',
      'run_vm_git_sync >"$reverse_dir/source-publish-raw.json"',
      'run_vm_git_sync >"$first_dir/publish-raw.json"',
      'run_tower_git_sync >"$first_dir/integrate-raw.json"',
      'run_tower_git_sync >"$dirty_dir/integrate-raw.json"',
      'run_tower_git_sync >"$phase_dir/tower-member-raw.json"',
      'run_vm_git_sync >"$phase_dir/vm-member-raw.json"',
      'run_tower_git_sync >"$phase_dir/healthy-ingress-raw.json"',
      'run_tower_git_sync >"$phase_dir/healthy-integrate-raw.json"',
      'run_tower_git_sync >"$phase_dir/healthy-egress-raw.json"',
      'run_tower_git_sync >"$phase_dir/divergence-egress-raw.json"',
      'run_tower_git_sync >"$phase_dir/rollback-tower-raw.json"',
      'run_vm_git_sync >"$phase_dir/rollback-vm-raw.json"',
    ]) {
      const at = physicalScenario.indexOf(site);
      expect(at, site).toBeGreaterThan(-1);
      const next = physicalScenario.slice(at + site.length, physicalScenario.indexOf('\n', physicalScenario.indexOf('\n', at) + 1) + 1);
      expect(next, site).toContain('require_git_sync_fired ');
    }

    const refusal = JSON.stringify({
      ok: false, fired: false, status: 'refused', success: false, committed: false, reason: 'request-only-host',
      retry: { tool: 'git-sync:run', host_role: 'background-workers', dev_box_url: 'http://127.0.0.1:3271' },
    });
    const fired = JSON.stringify({ ok: true, fired: true, status: 'committed', success: true, committed: true });
    const root = mkdtempSync(join(tmpdir(), 'hive-git-tower-sync-'));
    try {
      const log = join(root, 'ptool.log');
      const out = join(root, 'publish-raw.json');
      const ptool = join(root, 'ptool');
      const timedOut = join(root, 'timed-out-once');
      // The exact failure ptool prints when its client deadline beats the
      // server's reply (P-505 run 13, WI-10003638).
      const unknownOutcome =
        'ptool: tools/call git-sync:run failed: MCP error -32001: Request timed out; the tool call may have executed. outcome=unknown; idempotencyKey=from-ptool';
      writeFileSync(ptool, [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> '${log}'`,
        'cat >/dev/null',
        'case "$STUB_MODE:$*" in',
        `  direct:*) printf '%s\\n' '${fired}' ;;`,
        `  route:*--url=http://127.0.0.1:3271*) printf '%s\\n' '${fired}' ;;`,
        `  unknown-once:*--url=http://127.0.0.1:3271*)`,
        `    if [ -e '${timedOut}' ]; then printf '%s\\n' '${fired}'; else : > '${timedOut}'; echo '${unknownOutcome}' >&2; exit 1; fi ;;`,
        `  unknown-always:*--url=http://127.0.0.1:3271*) echo '${unknownOutcome}' >&2; exit 1 ;;`,
        `  *) printf '%s\\n' '${refusal}' ;;`,
        'esac',
        '',
      ].join('\n'));
      chmodSync(ptool, 0o755);
      const keyOf = (call: string) => /--idempotency-key=(\S+)/.exec(call)?.[1];

      const run = (mode: 'direct' | 'route' | 'refuse' | 'unknown-once' | 'unknown-always') => {
        rmSync(log, { force: true });
        rmSync(timedOut, { force: true });
        const script = [
          'set -euo pipefail',
          `TOWER_CALL='${ptool}'`,
          'TOWER_GIT_SYNC_SLUG=hello-world-3-pot',
          'PHASE_A_POT_HOME=hello-world-3-pot',
          "fail() { printf 'FAIL: %s\\n' \"$*\" >&2; exit 9; }",
          functions,
          `run_tower_git_sync >'${out}'`,
          `require_git_sync_fired '${out}' 'tower source-publish'`,
          'echo PUBLISH_OK',
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
          env: { ...process.env, STUB_MODE: mode, TOWER_GIT_SYNC_REPLAY_WAIT_SEC: '0' },
        });
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
        return { ...result, calls, output: existsSync(out) ? readFileSync(out, 'utf8') : '' };
      };

      // A host that can fire does so on the first call; no second call.
      const direct = run('direct');
      expect(direct.status, direct.stderr).toBe(0);
      expect(direct.stdout).toContain('PUBLISH_OK');
      expect(direct.calls).toHaveLength(1);
      expect(direct.calls[0]).not.toContain('--url=');

      // The observed incident: refused on the request-only host, then fired on
      // the host the refusal names, and the recorded result is the fired one.
      const routed = run('route');
      expect(routed.status, routed.stderr).toBe(0);
      expect(routed.stdout).toContain('PUBLISH_OK');
      expect(routed.calls).toHaveLength(2);
      expect(routed.calls[0]).not.toContain('--url=');
      expect(routed.calls[1]).toContain('--url=http://127.0.0.1:3271');
      expect(JSON.parse(routed.output).fired).toBe(true);

      // Still refused after routing: fail closed at the publish, not 20
      // minutes later in the receive loop.
      const refused = run('refuse');
      expect(refused.status).toBe(9);
      expect(refused.stdout).not.toContain('PUBLISH_OK');
      expect(refused.stderr).toContain('tower source-publish git-sync:run did not fire (refused: request-only-host)');

      // WI-10003638 (P-505 run 13): the re-fire's ptool deadline beat a lagging
      // bg-host, so the outcome was unknown. The scenario replays the SAME key,
      // which the transport answers from its stored result, and records the
      // fired result. The request-only attempt used a DIFFERENT key, so the
      // shared replay store cannot hand the refusal back to the re-fire.
      const replayed = run('unknown-once');
      expect(replayed.status, replayed.stderr).toBe(0);
      expect(replayed.stdout).toContain('PUBLISH_OK');
      expect(replayed.calls).toHaveLength(3);
      expect(replayed.calls[1]).toContain('--url=http://127.0.0.1:3271');
      expect(replayed.calls[2]).toContain('--url=http://127.0.0.1:3271');
      const keys = replayed.calls.map(keyOf);
      expect(keys.every(Boolean)).toBe(true);
      expect(keys[2]).toBe(keys[1]);
      expect(keys[1]).not.toBe(keys[0]);
      expect(replayed.stderr).toContain(`replaying idempotency key ${keys[1]}`);
      expect(JSON.parse(replayed.output).fired).toBe(true);

      // A host that never answers is bounded: two replays, then the publish
      // fails with ptool's status instead of looping.
      const lost = run('unknown-always');
      expect(lost.status).not.toBe(0);
      expect(lost.stdout).not.toContain('PUBLISH_OK');
      expect(lost.calls).toHaveLength(4);
      expect(new Set(lost.calls.slice(1).map(keyOf)).size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins a falsifiable Phase A cold-join adapter contract with no command override', () => {
    const phaseAScenario = physicalScenario.slice(
      physicalScenario.indexOf('phase_a_storage_join()'),
      physicalScenario.indexOf('phase_b_ref_announce()'),
    );
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'A'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_A_CMD: 'printf synthetic-pass',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'A',
      planItem: 'P-302',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        potHomeSlug: 'hello-world-3-pot',
        repoKey: PHASE_A_REPO_KEY,
        topology: 'tower-to-vm-cold-join',
      },
      causalOrder: [
        'towerStoreObserved',
        'vmStoreQuarantinedByScenario',
        'vmStoreAbsenceObserved',
        'canonicalGitSyncBootstrapTriggered',
        'vmStoreRecreatedAfterBootstrap',
        'twoHostNamespaceAndObjectParityObserved',
      ],
      requiredObservations: [
        'towerBareRepo',
        'vmBareRepo',
        'bothPhysicalDeviceNamespacesOnBothHosts',
        'namespaceRefOidsMatch',
        'referencedObjectsExistOnBothHosts',
        'oneObjectDatabasePerRepo',
        'deviceSignedExactNamespaceSnapshots',
        'freshVmOwnNamespaceSignature',
        'bootstrapCompletedAfterObservedAbsence',
      ],
      forbiddenEvidence: [
        'preExistingVmStoreAsColdJoinProof',
        'singleHostObservation',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ],
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_A_CMD');
    expect(physicalScenario).toContain('now_iso()');
    expect(physicalScenario).not.toContain('%S.000Z');
    expect(phaseAScenario).toContain('while :; do');
    expect(phaseAScenario.indexOf('>"$phase_dir/tower-after.json"')).toBeLessThan(
      phaseAScenario.indexOf('>"$phase_dir/vm-after.json"'),
    );
    expect(phaseAScenario).toContain('phase-a-verify "$phase_dir/verify-input.json"');
    expect(phaseAScenario).toContain(
      'phase A canonical bootstrap did not reach strict two-host convergence within 20 minutes',
    );
    // WI-10003632: quarantine + absence must be ONE VM process. A separate
    // `phase-a-observe vm absent` ssh launch loses the race to the VM's
    // scheduled git-sync bootstrap tick (P-505 run 12).
    expect(phaseAScenario).toContain('phase-a-quarantine-observe');
    expect(phaseAScenario).not.toContain('phase-a-observe vm absent');
    expect(phaseAScenario.indexOf('phase-a-quarantine-observe')).toBeLessThan(
      phaseAScenario.indexOf('run_vm_git_sync >'),
    );
    expect(physicalScenario).toContain('dev:dogfood_substrate_status');
    expect(physicalScenario).toContain('"substrateActive"');
    expect(physicalScenario).toContain('"reachedSubstrateOwner"');
    expect(physicalScenario).toContain('"healthInputsObserved"');
    expect(physicalScenario).toContain('"bootedCount"');
    expect(physicalScenario).toContain('"harnesses[].workspaceId"');
    expect(physicalScenario).toContain('"harnesses[].harnessSlug"');
    expect(physicalScenario).toContain('"harnesses[].verdict"');
    expect(physicalScenario).toContain('"harnesses[].reasons"');
    expect(physicalScenario).toContain('"contentConnectivity[].topicHex"');
    expect(physicalScenario).toContain('"contentConnectivity[].contentPeers"');
    expect(physicalScenario).toContain('"contentConnectivity[].lastContentAnnounceRecvMs"');
    expect(physicalScenario).toContain('"targetHarness"');
    expect(physicalScenario).toContain('status?.reachedSubstrateOwner === true');
    expect(physicalScenario).toContain('status?.healthInputsObserved === true');
    expect(physicalScenario).toContain('status.bootedCount > 0');
    expect(physicalScenario).toContain('content.contentPeers > 0');
    expect(physicalScenario).toContain('announceAgeMs <= maxAnnounceAgeMs');
    expect(physicalScenario).toContain('const sameTopic = tower.contentTopicHex === vm.contentTopicHex');
    expect(physicalScenario).toContain(
      'row?.workspaceId === workspaceId && row?.harnessSlug === harnessSlug',
    );
    expect(physicalScenario).toContain('PHASE_A_TOWER_STATUS_ARGS');
    expect(physicalScenario).toContain('PHASE_A_VM_STATUS_ARGS');
    expect(phaseAScenario.indexOf('require_phase_a_two_host_substrate_ready >')).toBeLessThan(
      phaseAScenario.indexOf('phase-a-quarantine'),
    );

  });

  it('fails closed before Phase A quarantine when the VM handle is booted but its exact topic has zero peers', () => {
    const runDir = mkdtempSync(join(evidenceDir, 'phase-a-substrate-readiness-'));
    const fakeBin = join(runDir, 'bin');
    const output = join(runDir, 'unsigned-evidence.json');
    const towerIdentity = join(runDir, 'tower-identity.json');
    const vmIdentity = join(runDir, 'vm-identity.json');
    const quarantineMarker = join(runDir, 'quarantine-reached');
    const projectionMarker = join(runDir, 'readiness-projection-received');
    const identity = (hostId: string, byte: number) => ({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId,
      deviceKey: Buffer.alloc(32, byte).toString('base64'),
      machineFingerprint: byte.toString(16).repeat(64),
    });
    writeFileSync(towerIdentity, JSON.stringify(identity('tower', 1)));
    writeFileSync(vmIdentity, JSON.stringify(identity('vm', 2)));
    mkdirSync(fakeBin);

    const producer = join(
      repoRoot(),
      'packages',
      'operator-core',
      'lib',
      'sync',
      'pot-git',
      'physical-drill-producer.ts',
    );
    const producerSha = createHash('sha256').update(readFileSync(producer)).digest('hex');
    // The scenario refuses to run without a probe-staged tower snapshot (WI-10004062) and
    // resolves its tower producer from it. A symlink keeps that producer's bytes (the sha the
    // fake VM echoes) and its import resolution identical to the checked-in file.
    const towerSource = join(runDir, 'hive-git-physical-tower-source.test');
    const stagedProducerDir = join(towerSource, 'packages', 'operator-core', 'lib', 'sync', 'pot-git');
    mkdirSync(stagedProducerDir, { recursive: true });
    symlinkSync(producer, join(stagedProducerDir, 'physical-drill-producer.ts'));
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const driverDigests = `${sha(join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'vmcall.sh'))} ${sha(
      join(repoRoot(), 'scripts', 'mcp-call.mjs'),
    )}`;
    // Tripwire: a stale-driver verdict would run the real deploy.sh, whose scp
    // is not covered by the fake ssh and would reach the real rig VM.
    const scpMarker = join(runDir, 'scp-attempted');
    writeFileSync(join(fakeBin, 'scp'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${scpMarker}'\nexit 97\n`);
    chmodSync(join(fakeBin, 'scp'), 0o755);
    const fakeSsh = join(fakeBin, 'ssh');
    writeFileSync(
      fakeSsh,
      `#!/bin/sh
case "$*" in
  *vmcall.sh*mcp-call.mjs*shasum*) printf '%s\\n' '${driverDigests}' ;;
  *shasum*) printf '%s\\n' '${producerSha}' ;;
  *dev:dogfood_substrate_status*)
    if printf '%s\\n' "$*" | grep -F '"projection"' >/dev/null \
      && printf '%s\\n' "$*" | grep -F '"harnesses[].harnessSlug"' >/dev/null; then
      printf '%s\\n' received > '${projectionMarker}'
      printf '%s\\n' '{"substrateActive":true,"reachedSubstrateOwner":true,"healthInputsObserved":true,"bootedCount":1,"harnesses":[{"workspaceId":"papercusp-workspace","harnessSlug":"hello-world","verdict":"healthy","reasons":[]}],"contentConnectivity":[{"workspaceId":"papercusp-workspace","harnessSlug":"hello-world","topicHex":"${'ab'.repeat(32)}","contentPeers":0,"lastContentAnnounceRecvMs":${Date.now()}}]}'
    else
      printf '%s\\n' '{"summary":"payload preview omitted","_projection":{"kind":"bounded-payload","truncated":true}}'
    fi
    ;;
  *phase-a-quarantine*) printf '%s\\n' reached > '${quarantineMarker}'; exit 90 ;;
  *) exit 91 ;;
esac
`,
    );
    chmodSync(fakeSsh, 0o755);

    const attempted = spawnSync(
      physicalScenarioPath,
      [output, towerIdentity, vmIdentity],
      {
        encoding: 'utf8',
        timeout: 120_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09',
          HIVE_GIT_PHYSICAL_EXECUTE: 'p2p-git-live-activation-2026-07-09',
          HIVE_GIT_PHYSICAL_VM_SOURCE: '/tmp/hive-git-physical-source.123',
          HIVE_GIT_PHYSICAL_TOWER_SOURCE: towerSource,
        },
      },
    );

    expect(attempted.status).toBe(1);
    expect(attempted.stderr).toContain(
      'phase A VM substrate readiness gate failed: exact topic has no live, recent remote content peer',
    );
    // If the dispatch projection regresses away, the fake returns the same
    // spill wrapper observed on the physical VM and this marker stays absent.
    expect(existsSync(projectionMarker)).toBe(true);
    expect(existsSync(quarantineMarker)).toBe(false);
    expect(existsSync(scpMarker)).toBe(false);
    expect(existsSync(output)).toBe(false);
  });

  it('pins a bidirectional Phase B ref-announcement adapter with no direct-fetch or command override seam', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'B'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_B_CMD: 'git fetch synthetic bundle',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'B',
      planItem: 'P-303',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        potHomeSlug: 'hello-world-3-pot',
        repoKey: PHASE_A_REPO_KEY,
        topology: 'bidirectional-tower-vm-ref-announce',
      },
      causalOrder: [
        'transferRefAbsentOnBothHosts',
        'freshSourceNamespaceCommitCreated',
        'sourceGitSyncPublishTriggered',
        'sourceSignedSigrefsAdvanced',
        'destinationGitSyncReceiveTriggered',
        'exactSignedNamespaceAndObjectsObservedOnDestination',
        'reverseDirectionRepeated',
      ],
      requiredObservations: [
        'freshRunBoundCommitInEachDeviceNamespace',
        'sourceAndDestinationPreMutationAbsence',
        'deviceSignedExactNamespaceSnapshot',
        'sameSigrefsOidOnSourceAndDestination',
        'sameCommitAndPayloadOnSourceAndDestination',
        'reachableObjectCounts',
        'boundedTransferLatency',
        'canonicalGitSyncPublishAndReceiveTicks',
      ],
      forbiddenEvidence: [
        'preExistingTransferRef',
        'directGitFetch',
        'bundleTransfer',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ],
      transport: 'ref-announce-protomux-git-upload-pack-v2',
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_B_CMD');
    expect(physicalScenario).toContain('phase-b-commit tower tower-to-vm');
    expect(physicalScenario).toContain('phase-b-commit vm vm-to-tower');
    expect(physicalScenario).toContain('phase-b-verify');
    expect(physicalScenario).toContain('git-sync:run');
    expect(physicalScenario).not.toMatch(/['"]git (?:fetch|bundle)/);
  });

  // WI-10003717 (P-505 run 14): the verifier orders destinationReceive.finishedAt
  // BEFORE destinationAfter.observedAt. A finish stamp taken after the receive
  // loop's `break` always lands after the successful observation, so Phase B
  // rejected every physically-converged run. Pin the stamp inside the loop,
  // between the receive fire and the observation, in both directions.
  it('stamps each Phase B receive finish between the receive fire and the destination observation', () => {
    const start = physicalScenario.indexOf('phase_b_ref_announce()');
    const end = physicalScenario.indexOf('phase_c_trust_negative_controls()');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const phaseB = physicalScenario.slice(start, end);
    const legs = [
      {
        fire: 'run_vm_git_sync >"$forward_dir/destination-receive-$attempt.json"',
        stamp: 'forward_receive_finished="$(now_iso)"',
        observe: "phase-b-observe vm tower-to-vm present",
      },
      {
        fire: 'run_tower_git_sync >"$reverse_dir/destination-receive-$attempt.json"',
        stamp: 'reverse_receive_finished="$(now_iso)"',
        observe: 'phase-b-observe tower vm-to-tower present',
      },
    ];
    for (const leg of legs) {
      const fire = phaseB.indexOf(leg.fire);
      expect(fire, leg.fire).toBeGreaterThan(-1);
      const stamp = phaseB.indexOf(leg.stamp, fire);
      const observe = phaseB.indexOf(leg.observe, fire);
      expect(stamp, `${leg.stamp} must follow the receive fire`).toBeGreaterThan(fire);
      expect(observe, `${leg.observe} must follow the receive fire`).toBeGreaterThan(fire);
      expect(stamp, `${leg.stamp} must precede ${leg.observe}`).toBeLessThan(observe);
      // Exactly one stamp: a second one after the loop would re-break the order.
      expect(phaseB.split(leg.stamp).length - 1).toBe(1);
    }
  });

  // P-505 run 33b: the source store was read ONCE right after its publish fire,
  // which can return in_progress, and Phase B rejected a transfer the VM had
  // already received. Each source read must carry the convergence expectation,
  // retry on the producer's exit 3 with a git-sync nudge, and re-stamp the
  // publish finish inside that loop, before the observation.
  it('reads each Phase B source store until its signed sigrefs cover the fresh commit', () => {
    const start = physicalScenario.indexOf('phase_b_ref_announce()');
    const end = physicalScenario.indexOf('phase_c_trust_negative_controls()');
    const phaseB = physicalScenario.slice(start, end);
    const legs = [
      {
        fired: `require_git_sync_fired "$forward_dir/source-publish-raw.json"`,
        stamp: 'forward_publish_finished="$(now_iso)"',
        observe: '"$tower_device" "$run_id" "$forward_oid" "$forward_before_version"',
        output: '>"$forward_dir/source-after.json"',
        nudge: 'run_tower_git_sync >"$forward_dir/source-publish-nudge-$attempt.json"',
        destination: `'$tower_device' '$run_id' '$forward_oid' '$forward_before_version'`,
      },
      {
        fired: `require_git_sync_fired "$reverse_dir/source-publish-raw.json"`,
        stamp: 'reverse_publish_finished="$(now_iso)"',
        observe: `'$vm_device' '$run_id' '$reverse_oid' '$reverse_before_version'`,
        output: '>"$reverse_dir/source-after.json"',
        nudge: 'run_vm_git_sync >"$reverse_dir/source-publish-nudge-$attempt.json"',
        destination: '"$vm_device" "$run_id" "$reverse_oid" "$reverse_before_version"',
      },
    ];
    for (const leg of legs) {
      const fired = phaseB.indexOf(leg.fired);
      const loop = phaseB.indexOf('while :; do', fired);
      const stamp = phaseB.indexOf(leg.stamp, fired);
      const observe = phaseB.indexOf(leg.observe, fired);
      const output = phaseB.indexOf(leg.output, observe);
      const retry = phaseB.indexOf('[ "$rc" -eq 3 ]', output);
      const nudge = phaseB.indexOf(leg.nudge, retry);
      expect(fired, leg.fired).toBeGreaterThan(-1);
      expect(loop, 'the source read must sit in a retry loop').toBeGreaterThan(fired);
      expect(stamp, `${leg.stamp} must be inside the loop`).toBeGreaterThan(loop);
      expect(observe, `${leg.observe} must follow the stamp`).toBeGreaterThan(stamp);
      expect(output, 'the expectation must be on the source-after observation').toBeGreaterThan(observe);
      expect(retry, 'only exit 3 (not converged) may retry').toBeGreaterThan(output);
      expect(nudge, leg.nudge).toBeGreaterThan(retry);
      expect(phaseB.split(leg.stamp).length - 1).toBe(1);
      // The destination waits for the same signed snapshot, not just the ref.
      expect(phaseB.indexOf(leg.destination, nudge), leg.destination).toBeGreaterThan(nudge);
    }
  });

  // WI-10003711: Phase A's strict parity must not depend on the 10-min scheduled
  // tick. Its poll loop drives both hosts' production receive, rate-limited, the
  // same way Phase B drives each attempt.
  it('drives both hosts receive inside the Phase A parity poll instead of waiting on the scheduled tick', () => {
    const start = physicalScenario.indexOf('local receive_drive=0 next_receive_drive=');
    const end = physicalScenario.indexOf('phase_b_ref_announce()');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const loop = physicalScenario.slice(start, end);
    expect(loop).toContain('run_vm_git_sync >"$phase_dir/drive-vm-receive-$receive_drive.log"');
    expect(loop).toContain('run_tower_git_sync >"$phase_dir/drive-tower-receive-$receive_drive.log"');
    expect(loop).toContain('next_receive_drive=$((SECONDS + 120))');
    expect(loop.indexOf('phase-a-verify')).toBeLessThan(loop.indexOf('drive-vm-receive'));
  });

  it('signs integrator-authored namespace refs before the worktree bridge in the same git-sync tick', () => {
    const publish = gitSyncAction.indexOf("runCheckpointedStep('git-sync:ref-announce'");
    const integrate = gitSyncAction.indexOf("runCheckpointedStep('git-sync:integrator'");
    const postIntegratorPublish = gitSyncAction.indexOf(
      "runCheckpointedStep('git-sync:ref-announce-post-integrator'",
    );
    const bridge = gitSyncAction.indexOf("runCheckpointedStep('git-sync:worktree-bridge'");

    expect(publish).toBeGreaterThan(-1);
    expect(integrate).toBeGreaterThan(publish);
    expect(postIntegratorPublish).toBeGreaterThan(integrate);
    expect(bridge).toBeGreaterThan(postIntegratorPublish);

    const postIntegratorStep = gitSyncAction.slice(postIntegratorPublish, bridge);
    expect(postIntegratorStep).toContain('runRefAnnounceLeg(slug, workspaceId, { receive: false })');
    expect(gitSyncAction).toContain('if (options.receive === false) return;');
  });

  it('pins two-host Phase C trust controls to the production sigrefs and scope-serve primitives', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'C'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_C_CMD: 'printf synthetic-pass',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'C',
      planItem: 'P-304',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        potHomeSlug: 'hello-world-3-pot',
        repoKey: PHASE_A_REPO_KEY,
        topology: 'two-host-local-trust-negative-controls',
      },
      causalOrder: [
        'runBoundThirdDeviceKeyGeneratedOnEachHost',
        'honestNamespaceHeadCreatedAndSigned',
        'relayHeadMutatedAfterSignature',
        'authenticSignatureAccepted',
        'servedHeadReconciledAgainstSignedSnapshot',
        'staleSignedSnapshotRejectedByVersionFence',
        'nonMemberScopeServeRejected',
        'honestHeadRestored',
        'twoHostEvidenceAggregated',
      ],
      requiredObservations: [
        'distinctRunBoundThirdDeviceOnEachPhysicalHost',
        'realGitHonestAndRogueCommits',
        'validEd25519SignedSnapshot',
        'exactRelayHeadMismatch',
        'rollbackRefusalFromMonotonicVersionFence',
        'nonMemberRefusalFromScopeServeGate',
        'realBareScopeRepoOnEachHost',
        'postControlHonestHeadRestoration',
      ],
      forbiddenEvidence: [
        'singleHostControl',
        'sharedThirdDeviceKey',
        'unverifiedSignature',
        'restoredBeforeMismatchObserved',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ],
      trustPrimitives: ['acceptFetchedSigrefs', 'reconcileFetchedHeads', 'authorizeScopeRepoServe'],
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_C_CMD');
    expect(physicalScenario).toContain('phase-c-run tower');
    expect(physicalScenario).toContain('phase-c-run vm');
    expect(physicalScenario).toContain('phase-c-verify');
  });

  it('pins Phase D to the production request, ratification, staging-event, and worktree-bridge spine', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'D'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_D_CMD: 'git fetch synthetic && git update-ref synthetic',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'D',
      planItem: 'P-305',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        potHomeSlug: 'hello-world-3-pot',
        repoKey: PHASE_A_REPO_KEY,
        topology: 'vm-below-steer-to-tower-integrator-to-vm-worktree',
      },
      causalOrder: [
        'freshVmBelowSteerCommitCreated',
        'vmGitSyncPublishTriggered',
        'towerGitSyncQueueReceiveTriggered',
        'exactPendingRequestObserved',
        'productionRatificationApplied',
        'towerGitSyncIntegrationTriggered',
        'towerSignedStagingAdvanceObserved',
        'vmReceivedIdenticalSignedAdvance',
        'vmCanonicalAndWorktreeFastForwarded',
        'vmOverlapFileMadeDirty',
        'freshTowerOverlapCommitCreated',
        'towerSecondSignedAdvanceObserved',
        'vmMirrorAndCursorAdvanced',
        'vmWorktreeHeadAndDirtyFileObservedUntouched',
      ],
      requiredObservations: [
        'freshRunBoundBelowSteerHead',
        'exactVisibleIntegrationRequest',
        'ratifyIntegrationRequestResult',
        'productionGitSyncTriggers',
        'signedStagingAdvanceOnBothPhysicalHosts',
        'integratorNamespaceAndCanonicalStagingOids',
        'worktreeBridgeCursorEpochSeqAndEventRow',
        'secondFreshOverlappingAdvance',
        'unchangedDirtyWorktreeHead',
        'unchangedProtectedFileHash',
      ],
      forbiddenEvidence: [
        'localSecondWorktreeAsPhysicalProof',
        'directGitFetch',
        'directRefMutation',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
        'callerSelectedRepoOrWorktree',
      ],
      productionSurfaces: [
        'git-sync:run',
        'setCommsTrust',
        'listIntegrationRequests',
        'ratifyIntegrationRequest',
        'pot-git:staging-advance',
        'worktree-bridge',
      ],
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_D_CMD');
    expect(physicalScenario).toContain('phase-d-request pending');
    expect(physicalScenario).toContain('phase-d-ratify');
    expect(physicalScenario).toContain('phase-d-event tower');
    expect(physicalScenario).toContain('phase-d-event vm');
    expect(physicalScenario).toContain('phase-d-verify');
    expect(physicalScenario).not.toMatch(/['"]git (?:fetch|update-ref)/);
  });

  it('waits for the tower staging event and fails fast on a duplicate (WI-10003787)', () => {
    // P-505 run 27: the tower integrate returned in_progress and a one-shot
    // phase-d-event read ran before the single signed event landed.
    const towerCaptures = physicalScenario.match(/phase-d-event tower 0 [^\n]*/g) ?? [];
    expect(towerCaptures).toHaveLength(2);
    for (const call of towerCaptures) expect(call).toContain('"$PHASE_D_TOWER_EVENT_WAIT_SEC"');
    const wait = Number(/^PHASE_D_TOWER_EVENT_WAIT_SEC=(\d+)$/m.exec(physicalScenario)?.[1]);
    expect(wait).toBeGreaterThan(45);
    expect(wait).toBeLessThanOrEqual(1200);
    const vmLoops = physicalScenario.match(/phase-d-event vm 0 [\s\S]*?\n {4}phase_d_fail_on_duplicate_event /g) ?? [];
    expect(vmLoops).toHaveLength(2);
    expect(physicalScenario).toContain("grep -q 'duplicate signed production staging events'");
  });

  it('waits for each converged Phase D observation instead of reading a host once (WI-10003811)', () => {
    // P-505 run 30: first-source and first-destination were read 7-23s after
    // the signed event and caught both hosts mid-flight.
    const converged = [
      ['tower first-source', '"$first_head"', '"$first_dir/source-observation.json" 1200'],
      ['vm first-destination', '"$first_head"', '"$first_dir/destination-observation.json" 1200'],
      ['vm dirty-after', '"$second_head"', '"$dirty_dir/after-observation.json" 300'],
    ] as const;
    for (const [stage, head, tail] of converged) {
      const call = new RegExp(
        `phase_d_observe_converged ${stage} "\\$tower_device" "\\$run_id" ${head.replace(/\$/g, '\\$')} \\\\\\n\\s+${tail.replace(/\$/g, '\\$')}\\n`,
      );
      expect(physicalScenario, stage).toMatch(call);
      // No one-shot read of the same stage survives beside the waiting one.
      expect(physicalScenario, stage).not.toMatch(new RegExp(`phase-d-observe ${stage} `));
    }
    // The dirty-after bound stays inside the dirt lock's 30-minute TTL.
    expect(Number(/dirty-after [^\n]*\\\n\s+"\$dirty_dir\/after-observation\.json" (\d+)/.exec(physicalScenario)?.[1])).toBeLessThan(1800);
    // Exit 3 means "not converged yet": retry after nudging git-sync; anything else fails.
    expect(physicalScenario).toMatch(/\[ "\$rc" -eq 3 \] \\\n\s+\|\| fail "phase D \$host \$stage observation failed/);
    expect(physicalScenario).toContain('if [ "$host" = tower ]; then run_tower_git_sync; else run_vm_git_sync; fi');
  });

  it('holds the VM author below steer only across the below-steer window and always undoes it (WI-10003723)', () => {
    // P-505 run 15: the tower pinned the VM user at 'steer', so the integrator
    // auto-integrated the VM head and the pending request never appeared.
    const at = (needle: string, from = 0) => {
      const i = physicalScenario.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const phaseD = at('phase_d_worktree_materialization() {\n');
    const trapAt = at('trap phase_d_restore_on_exit EXIT', phaseD);
    const holdAt = at('"$TSX" "$PRODUCER" phase-d-tier-hold "$vm_device" "$run_id" "$PHASE_D_TIER_HOLD"', phaseD);
    const cacheWaitAt = at('sleep 35', holdAt);
    const commitAt = at('phase-d-commit vm below-steer', phaseD);
    const ratifyAt = at('"$TSX" "$PRODUCER" phase-d-ratify', phaseD);
    const restoreAt = at('phase_d_tier_restore >"$phase_dir/tier-restore.json"', phaseD);
    const dirtyAt = at("phase-d-dirty '$run_id'", phaseD);
    const dirtyArmedAt = at('PHASE_D_VM_DIRTY_RUN="$run_id"', phaseD);
    const verifyAt = at('"$TSX" "$PRODUCER" phase-d-verify', phaseD);
    const resetAt = at('phase_d_vm_reset >"$dirty_dir/reset.json"', phaseD);
    const untrapAt = at('trap - EXIT', phaseD);
    expect(trapAt).toBeLessThan(holdAt);
    expect(holdAt).toBeLessThan(cacheWaitAt);
    expect(cacheWaitAt).toBeLessThan(commitAt);
    expect(ratifyAt).toBeLessThan(restoreAt);
    expect(restoreAt).toBeLessThan(verifyAt);
    expect(dirtyAt).toBeLessThan(dirtyArmedAt);
    expect(verifyAt).toBeLessThan(resetAt);
    expect(resetAt).toBeLessThan(untrapAt);
    expect(untrapAt).toBeLessThan(at('phase_e_github_bridge() {'));

    const exitHandler = physicalScenario.slice(
      at('phase_d_restore_on_exit() {'),
      physicalScenario.indexOf('\n}\n', at('phase_d_restore_on_exit() {')),
    );
    expect(exitHandler).toContain('phase_d_tier_restore');
    expect(exitHandler).toContain('phase_d_vm_reset');
    // The handler must not replace the scenario's own exit status.
    expect(exitHandler).not.toMatch(/(?:^|[;&|]\s*)exit\b/m);
  });

  it('pins Phase E to commit-only members, the sole bridge writer, watchdog sweeps, and fail-closed recovery', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'E'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_E_CMD: 'git push synthetic refs/heads/staging',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'E',
      planItem: 'P-306',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        potHomeSlug: 'hello-world-3-pot',
        repoKey: PHASE_A_REPO_KEY,
        topology: 'two-host-commit-only-members-to-single-github-bridge-writer',
      },
      causalOrder: [
        'legacyModeObservedOnBothHosts',
        'bridgedModePersistedThroughSetPotGitMode',
        'bothPhysicalMemberGitSyncTicksTriggered',
        'bothMembersObservedCommitOnlyWithNoDirectPushes',
        'freshFixedUpstreamIngressCreated',
        'bridgeIngressAdmissionAndIntegrationTicksTriggered',
        'lastAdmittedReachedExactIngressHead',
        'canonicalAndForkStagingConverged',
        'twoProductionWatchdogSweepsStayedQuiet',
        'freshForkAheadControlCreated',
        'bridgeReportedStructuredEgressNonFastForward',
        'canonicalStayedFixedDuringDivergence',
        'forkRestoredWithForceWithLease',
        'legacyModeRestoredAndObservedOnBothHosts',
      ],
      requiredObservations: [
        'federatedModeRowOnBothPhysicalHosts',
        'commitOnlyRoutineMetadataAndEmptyLastPushed',
        'freshUpstreamHead',
        'githubBridgeLastAdmitted',
        'canonicalStagingOid',
        'forkRemoteStagingOid',
        'productionGitSyncTriggers',
        'twoDistinctCheckGitSyncStallResults',
        'structuredEgressNonFfEscalation',
        'unchangedCanonicalAcrossForkAheadControl',
        'forceWithLeaseRecoveryRecord',
        'legacyRollbackOnBothHosts',
      ],
      forbiddenEvidence: [
        'memberDirectPush',
        'summaryOnlyLegPass',
        'singleHostObservation',
        'callerSelectedRepoRefOrRemote',
        'directCanonicalRefMutation',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ],
      productionSurfaces: [
        'setPotGitMode',
        'git-sync:run',
        'runGithubBridgeLeg',
        'checkGitSyncStall',
        'github-bridge-divergence',
      ],
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_E_CMD');
    expect(physicalScenario).toContain('phase-e-mode bridged');
    expect(physicalScenario).toContain('phase-e-observe vm bridged-member');
    expect(physicalScenario).toContain('phase-e-ingress');
    expect(physicalScenario).toContain('phase-e-watchdog 1');
    expect(physicalScenario).toContain('phase-e-watchdog 2');
    expect(physicalScenario).toContain('phase-e-diverge');
    expect(physicalScenario).toContain('phase-e-recover');
    expect(physicalScenario).toContain('phase-e-mode legacy');
    expect(physicalScenario).toContain('trap phase_e_restore_on_exit EXIT');
    expect(physicalScenario).toContain('phase-e-verify');
    expect(physicalScenario).not.toMatch(/['"]git (?:fetch|push|update-ref)/);
  });

  it('reads each fire-judged tower stage only after the fire its trigger started has finished (WI-10004055)', () => {
    // 0.0.25 shakedown: git-sync:run answered in_progress at 45s, and a one-shot
    // divergence-after read landed ~20ms before the fire wrote divergence=escalate.
    const phaseE = physicalScenario.slice(
      physicalScenario.indexOf('phase_e_github_bridge() {'),
      physicalScenario.indexOf('phase_f_lifecycle_safety() {'),
    );
    for (const [stage, started] of [
      ['bridged-member', 'tower_member_started'],
      ['healthy-egress', 'egress_started'],
      ['divergence-after', 'divergence_started'],
    ] as const) {
      expect(phaseE).toContain(
        `phase-e-observe tower ${stage} "$tower_device" "$run_id" "$PHASE_E_MODE_WAIT_SEC" "$${started}"`,
      );
      // The trigger start must be stamped BEFORE its git-sync:run call.
      const stampAt = phaseE.indexOf(`${started}="$(now_iso)"`);
      expect(stampAt, started).toBeGreaterThan(-1);
      expect(stampAt).toBeLessThan(phaseE.indexOf('run_tower_git_sync', stampAt));
      expect(phaseE.indexOf('run_tower_git_sync', stampAt)).toBeLessThan(phaseE.indexOf(`phase-e-observe tower ${stage} `));
    }
  });

  it('starts Phase E from a recorded legacy baseline, waits for each stage mode, and always restores the canary mode (WI-10003791)', () => {
    // P-505 run 28: the canary had been bridged since 2026-07-17, so the drill's
    // legacy→bridged flip could not start, and its RETURN-trap cleanup would
    // never have run under set -e.
    const phaseE = physicalScenario.slice(
      physicalScenario.indexOf('phase_e_github_bridge() {'),
      physicalScenario.indexOf('phase_f_lifecycle_safety() {'),
    );
    const at = (needle: string, from = 0) => {
      const i = phaseE.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(phaseE).not.toContain('trap _phase_e_cleanup RETURN');
    expect(phaseE).not.toMatch(/trap [^\n]* RETURN/);
    const readAt = at('phase-e-mode-read >"$phase_dir/original-mode.json"');
    const restoreArmedAt = at('PHASE_E_RESTORE_MODE="$original_mode"');
    const trapAt = at('trap phase_e_restore_on_exit EXIT');
    const baselineAt = at('phase-e-mode-ensure legacy "$run_id"');
    const startedAt = at('started_at="$(now_iso)"');
    const flipAt = at('phase-e-mode bridged "$run_id"');
    const rollbackAt = at('phase-e-mode legacy "$run_id"');
    const finishedAt = at('finished_at="$(now_iso)"', rollbackAt);
    const restoreAt = at('phase-e-mode-ensure "$PHASE_E_RESTORE_MODE" "$run_id"');
    const verifyAt = at('"$TSX" "$PRODUCER" phase-e-verify');
    const untrapAt = at('trap - EXIT');
    expect(readAt).toBeLessThan(restoreArmedAt);
    expect(restoreArmedAt).toBeLessThan(trapAt);
    expect(trapAt).toBeLessThan(baselineAt);
    expect(baselineAt).toBeLessThan(startedAt);
    expect(startedAt).toBeLessThan(flipAt);
    expect(flipAt).toBeLessThan(rollbackAt);
    expect(finishedAt).toBeLessThan(restoreAt);
    expect(restoreAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(untrapAt);

    // Every mode-bearing VM observation waits for federation; the wait is bounded.
    const vmObserves = phaseE.match(/phase-e-observe vm [a-z-]+ '\$vm_device' '\$run_id'[^"]*"/g) ?? [];
    expect(vmObserves).toHaveLength(3);
    for (const call of vmObserves) expect(call).toContain("'$PHASE_E_MODE_WAIT_SEC'");
    const wait = Number(/^PHASE_E_MODE_WAIT_SEC=(\d+)$/m.exec(physicalScenario)?.[1]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1200);

    // Second race: each VM tick after a tower mode flip must wait for the flip to
    // federate to the VM, and a timeout must stop the scenario before the tick.
    const memberAwaitAt = at(`phase-e-await-mode bridged-member '$PHASE_E_MODE_WAIT_SEC'`, flipAt);
    const memberTickAt = at('run_vm_git_sync >"$phase_dir/vm-member-raw.json"', flipAt);
    expect(memberAwaitAt).toBeLessThan(memberTickAt);
    expect(phaseE.slice(memberAwaitAt, memberTickAt)).not.toContain('|| true');
    const rollbackAwaitAt = at(`phase-e-await-mode legacy-after '$PHASE_E_MODE_WAIT_SEC'`, rollbackAt);
    const rollbackTickAt = at('run_vm_git_sync >"$phase_dir/rollback-vm-raw.json"', rollbackAt);
    expect(rollbackAwaitAt).toBeLessThan(rollbackTickAt);
    expect(phaseE.slice(rollbackAwaitAt, rollbackTickAt)).not.toContain('|| true');
    expect(phaseE.match(/run_vm_git_sync >/g) ?? []).toHaveLength(2);

    const exitHandler = physicalScenario.slice(
      physicalScenario.indexOf('phase_e_restore_on_exit() {'),
      physicalScenario.indexOf('\n}\n', physicalScenario.indexOf('phase_e_restore_on_exit() {')),
    );
    expect(exitHandler).toContain('phase-e-recover "$PHASE_E_DIVERGENCE_MUTATION"');
    expect(exitHandler).toContain('phase-e-mode-ensure "$PHASE_E_RESTORE_MODE"');
    expect(exitHandler).not.toMatch(/(?:^|[;&|]\s*)exit\b/m);
  });

  it('pins Phase F to two-host production GC and publish guards over private temporary repositories', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'F'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_F_CMD: 'git update-ref refs/heads/synthetic deadbeef',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'F',
      planItem: 'P-307',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: {
        topology: 'two-host-private-lifecycle-repositories',
        repositoryLifetime: 'one-host-execution',
      },
      causalOrder: [
        'privateBareRepositoriesCreatedOnEachPhysicalHost',
        'liveAndDepartedNamespacesPopulated',
        'productionGcCollectorExecuted',
        'WorkRefAndNewestTwoPublishedRefsRetained',
        'oldestPublishedRefPruned',
        'departedNamespaceArchived',
        'cleanPublishAdmitted',
        'plantedCredentialRefused',
        'oversizedBlobRefused',
        'temporaryRepositoriesRemoved',
        'twoHostLifecycleEvidenceAggregated',
      ],
      requiredObservations: [
        'towerAndVmProductionLifecycleResults',
        'identityDerivedLiveAndDepartedNamespaces',
        'exactBeforeAndAfterRefInventories',
        'gcHiveGitRepoResult',
        'checkPublishGuardCleanResult',
        'checkPublishGuardSecretRefusal',
        'checkPublishGuardOversizedBlobRefusal',
        'temporaryRepositoryCleanup',
      ],
      forbiddenEvidence: [
        'singleHostLifecycleResult',
        'summaryOnlyLegPass',
        'callerSelectedRepoPath',
        'callerSelectedNamespaceOrRetentionCap',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ],
      productionSurfaces: ['gcHiveGitRepo', 'checkPublishGuard'],
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_F_CMD');
    expect(physicalScenario).toContain('phase-f-run tower');
    expect(physicalScenario).toContain('phase-f-run vm');
    expect(physicalScenario).toContain('phase-f-verify');
    expect(physicalScenario).toContain("local run_id=\"$physical_run_id\"");
  });

  it('pins Phase G to the truthful physical-attester versus ephemeral-protocol boundary', () => {
    const contract = spawnSync(physicalScenarioPath, ['--phase-contract', 'G'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        HIVE_GIT_PHYSICAL_PHASE_G_CMD: 'git push --force synthetic',
      },
    });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toMatchObject({
      schemaVersion: 'hive-git-physical-phase-contract/v1',
      phase: 'G',
      planItem: 'P-308',
      state: 'executor-installed',
      ready: true,
      missingAssertions: [],
      target: { topology: 'two-host-attested-ephemeral-protocol-adapter' },
      forbiddenEvidence: expect.arrayContaining([
        'protocolSignerRepresentedAsPhysicalHost',
        'summaryOnlyLegPass',
        'preAuthoredManifest',
        'environmentSuppliedCommand',
      ]),
      productionSurfaces: expect.arrayContaining([
        'nextHivePublicationTerm',
        'requireHiveEffectAuthority',
        'acceptStagingAdvanceFF',
        'runWorktreeBridgeTick',
        'decideWorktreeBridgePersistence',
        'readPotGitMode',
        'runGitSync',
        'openOwnLog',
      ]),
      externalCommandOverrides: false,
    });
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_PHASE_G_CMD');
    expect(physicalScenario).toContain('phase-g-run');
    expect(physicalScenario).toContain('phase-g-verify');
    expect(physicalScenario).toContain(PHASE_G_INPUT_SCHEMA);
    expect(physicalScenario).toContain('assemble_unsigned_evidence');
  });

  it('reports the fixed scenario ready without performing a physical run', () => {
    const readiness = spawnSync(physicalScenarioPath, ['--require-ready'], {
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(readiness.status).toBe(0);
    expect(readiness.stdout).toBe('');
    expect(readiness.stderr).toBe('');
  });

  it('accepts a same-run A-I physical artifact only with hash-matching witnesses from both hosts', () => {
    const fixture = physicalFixture();
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict).toMatchObject({ ok: true, runId: 'physical-run-2026-08-13T120000Z', errors: [] });
  });

  it('rejects a self-declared locally signed fixture without an out-of-manifest VM-rig trust anchor', () => {
    const verdict = validatePhysicalDrillEvidence(physicalFixture());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('trusted physical-rig anchor is required outside the evidence manifest');
  });

  it('rejects a hand-written trust anchor that has no keychain-bound host receipts', () => {
    const fixture = physicalFixture();
    const trust = trustedPhysicalAnchor(fixture);
    delete trust.receipts;
    const verdict = validatePhysicalDrillEvidence(fixture, trust);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('trusted anchor must contain exactly two keychain-bound host receipts');
  });

  it('executes the real validator CLI against an attested evidence file', () => {
    expect(VALIDATOR_CLI_TIMEOUT_MS).toBeLessThan(VALIDATOR_TEST_TIMEOUT_MS);
    const evidencePath = join(evidenceDir, 'accepted-evidence.json');
    const trustPath = join(evidenceDir, 'accepted-trust.json');
    const fixture = physicalFixture();
    writeFileSync(evidencePath, `${JSON.stringify(fixture)}\n`);
    writeFileSync(trustPath, `${JSON.stringify(trustedPhysicalAnchor(fixture))}\n`);
    const result = spawnSync(
      join(repoRoot(), 'node_modules', '.bin', 'tsx'),
      [validatorPath, evidencePath, trustPath],
      {
        encoding: 'utf8',
        timeout: VALIDATOR_CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      schemaVersion: 'hive-git-physical-evidence/v3',
    });
  }, VALIDATOR_TEST_TIMEOUT_MS);

  it('rejects a manifest changed after either physical device attested it', () => {
    const fixture = physicalFixture();
    fixture.legE.watchdogSweeps[1].recovered.push('unrelated-control');
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('not a valid signature over the canonical evidence payload');
  });

  it('rejects a structure-only pass claim with no raw physical-host artifacts', () => {
    const fixture = physicalFixture();
    fixture.artifacts = [];
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('raw witness from each physical host');
  });

  it('rejects a leg verdict banked outside the single physical-run window', () => {
    const fixture = physicalFixture();
    fixture.legVerdicts[3].observedAt = '2026-08-13T13:00:00Z';
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legVerdicts.D.observedAt must fall inside the one physical-run window');
  });

  it('rejects a generic Leg D pass with no embedded production-spine causal evidence', () => {
    const fixture = physicalFixture();
    delete fixture.legD;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legD must be an object');
  });

  it('revalidates the embedded Leg D object and rejects a cursor that did not move', () => {
    const fixture = physicalFixture();
    fixture.legD.dirtyAdvance.dirtyAfter.cursor.lastEventId =
      fixture.legD.dirtyAdvance.dirtyBefore.cursor.lastEventId;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'legD: Phase D dirty-after observation must advance the mirror and production bridge cursor',
    );
  });

  it('rejects Leg D evidence bound to devices other than the two physical attestations', () => {
    const fixture = physicalFixture();
    const other = generateEd25519KeypairDer();
    fixture.legD.identities.vmDeviceKey = other.pubkeyBase64;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legD identities must match the two attesting physical devices exactly');
  });

  it('rejects a generic Leg E pass with no embedded production-spine causal evidence', () => {
    const fixture = physicalFixture();
    fixture.legE = { planItem: 'P-306', status: 'pass' };
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legE must contain the complete validated P-306 causal evidence object');
  });

  it('revalidates the embedded Leg E object and rejects a remote staging miss', () => {
    const fixture = physicalFixture();
    fixture.legE.healthy.observation.refs.remoteStaging = '9'.repeat(40);
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legE: Phase E healthy bridge must clear divergence and FF exact canonical staging to the fork');
  });

  it('rejects Leg E evidence bound to devices other than the two physical attestations', () => {
    const fixture = physicalFixture();
    const other = generateEd25519KeypairDer();
    fixture.legE.identities.vmDeviceKey = other.pubkeyBase64;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legE identities must match the two attesting physical devices exactly');
  });

  it('rejects a generic Leg F pass with no embedded two-host lifecycle evidence', () => {
    const fixture = physicalFixture();
    fixture.legF = { planItem: 'P-307', status: 'pass' };
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legF must contain the complete validated P-307 lifecycle evidence object');
  });

  it('revalidates the embedded Leg F object and rejects an admitted planted credential', () => {
    const fixture = physicalFixture();
    fixture.legF.hostResults[0].guards.secret.ok = true;
    fixture.legF.hostResults[0].guards.secret.refusalCode = null;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legF: Phase F tower planted credential must be refused as secrets');
  });

  it('rejects Leg F evidence bound to devices other than the two physical attestations', () => {
    const fixture = physicalFixture();
    const other = generateEd25519KeypairDer();
    fixture.legF.identities.vmDeviceKey = other.pubkeyBase64;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legF identities must match the two attesting physical devices exactly');
  });

  it('rejects a generic Leg G pass with no complete production-seam evidence', () => {
    const fixture = physicalFixture();
    fixture.legG = { planItem: 'P-308', status: 'pass' };
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legG must contain the complete validated P-308 chaos evidence object');
  });

  it('rejects a Leg G retry that advanced the cursor before missing evidence arrived', () => {
    const fixture = physicalFixture();
    fixture.legG.result.retryPersistence.duringUnknownSha = 42;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legG: Phase G retryable unknown-sha must hold the fed-event cursor');
  });

  it('rejects a Leg G publication without the next owner term', () => {
    const fixture = physicalFixture();
    fixture.legG.result.authorityFence.publication.epoch = 7;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legG: Phase G owner publication must advance to term 8 at a fresh sequence');
  });

  it('rejects a Leg G claimed pass without the owning hive countersignature', () => {
    const fixture = physicalFixture();
    delete fixture.legG.result.authorityFence.successorAdvance.hive_sig;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legG: Phase G successor must verify the owning hive countersignature and signed context');
  });

  it('rejects a Leg G result that relabels an ephemeral authority as a physical host', () => {
    const fixture = physicalFixture();
    fixture.legG.result.protocolIdentities.owningHive = fixture.legG.identities.towerDeviceKey;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'legG: Phase G ephemeral protocol signers must not be represented as physical hosts',
    );
  });

  it('rejects a physical run with no Leg J apply-outage evidence at all', () => {
    const fixture = physicalFixture();
    delete fixture.legJ;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legJ must be an object');
  });

  it('rejects a generic Leg J pass with no complete apply-outage replay evidence', () => {
    const fixture = physicalFixture();
    fixture.legJ = { planItem: 'P-521', status: 'pass' };
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legJ must contain the complete validated P-521 apply-outage replay evidence object');
  });

  it('revalidates the embedded Leg J object and rejects a cursor that skipped the missing write', () => {
    const fixture = physicalFixture();
    fixture.legJ.held[0].cursors[0].position += 1;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error: string) => /^legJ: .*advanced past the missing write/.test(error))).toBe(true);
  });

  it('rejects Leg J evidence from another run, outside the run window, or bound to other devices', () => {
    const foreignRun = physicalFixture();
    foreignRun.legJ = buildPhysicalPhaseJInput({
      runId: `${physicalRunId}-other`,
      towerDeviceKey: foreignRun.legJ.identities.towerDeviceKey,
      vmDeviceKey: foreignRun.legJ.identities.vmDeviceKey,
      startMs: Date.parse('2026-08-13T12:24:00Z'),
    });
    expect(validatePhysicalDrillEvidence(foreignRun, trustedPhysicalAnchor(foreignRun)).errors).toContain(
      'legJ.runId must match the enclosing physical run',
    );

    const lateWindow = physicalFixture();
    lateWindow.legJ.window.finishedAt = '2026-08-13T12:31:00.000Z';
    expect(validatePhysicalDrillEvidence(lateWindow, trustedPhysicalAnchor(lateWindow)).errors).toContain(
      'legJ.window must fall inside the enclosing physical-run window',
    );

    const otherDevice = physicalFixture();
    otherDevice.legJ.identities.vmDeviceKey = generateEd25519KeypairDer().pubkeyBase64;
    expect(validatePhysicalDrillEvidence(otherDevice, trustedPhysicalAnchor(otherDevice)).errors).toContain(
      'legJ identities must match the two attesting physical devices exactly',
    );
  });

  it('preserves the default scaffold pass while reporting unproven legs', () => {
    const result = runGate({ fail: 0, skipped: 2 });
    expect(result.status).toBe(0);
    expect(result.output).toContain('OVERALL: PASS — scaffold + mode round-trip green');
    expect(result.output).toContain('2 Phase-3 legs unproven');
  });

  it('fails release acceptance while any explicit skip remains', () => {
    const result = runGate({ fail: 0, skipped: 2, requireZeroSkips: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('OVERALL: FAIL — release acceptance requires zero skips');
    expect(result.output).toContain('2 Phase-3 legs remain unproven');
  });

  it('passes release acceptance only when failures and skips are both zero', () => {
    const result = runGate({ fail: 0, skipped: 0, requireZeroSkips: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain('OVERALL: PASS — release acceptance green');
    expect(result.output).toContain('all Phase-3 legs ran with zero skips');
  });

  it('never lets zero skips hide a failed assertion', () => {
    const result = runGate({ fail: 1, skipped: 0, requireZeroSkips: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('OVERALL: FAIL');
    expect(result.output).not.toContain('release acceptance green');
  });
});

// WI-10003543: runIntegratorTick is an owner-key-gated hive effect. A Leg D
// heredoc that omits `authority` is silently skipped as 'not-integrator', and a
// non-null assertion on its announcement then crashed Leg D with no diagnosis.
describe('Leg D heredoc wires the owner-key authority and diagnoses a null announcement', () => {
  const start = drill.indexOf('cat > "$LEGD_SCRIPT" <<EOF');
  const legD = drill.slice(start, drill.indexOf('\nEOF\n', start));

  it('locates the Leg D heredoc (calibration)', () => {
    expect(start).toBeGreaterThan(0);
    expect(legD).toContain('runIntegratorTick(');
  });

  it('passes context, accepted floors and authority to every integrator tick', () => {
    const ticks = legD.split('runIntegratorTick({').slice(1).map((t) => t.slice(0, t.indexOf('});')));
    expect(ticks).toHaveLength(2);
    for (const tick of ticks) expect(tick).toMatch(/context, acceptedSnapshots: await acceptedFloors\(\), authority,/);
  });

  it('never non-null-asserts an announcement and pins expectedContext on the bridge', () => {
    expect(legD).not.toMatch(/announcement!/);
    expect(legD).toContain("if (!out.announcement) return failNoAnnouncement('first-tick', out);");
    expect(legD).toContain("if (!out2.announcement) return failNoAnnouncement('second-tick', out2);");
    expect(legD.match(/accept: \{ expectedContext: context, expectedDevice:/g)).toHaveLength(2);
  });
});

// WI-2039874 / P-505 run 3 (2026-09-27): the phase A tower readiness probe passed
// `--client` to the tower ptool, which has never accepted it ("unknown flag
// --client"). The scenario tests fake ptool, so nothing caught it until the rig.
// Derive ptool's accepted flags from ptool.mjs itself so the set cannot drift.
describe('physical scenario tower ptool calls use only flags ptool accepts', () => {
  const ptoolSrc = readFileSync(join(repoRoot(), 'apps', 'operator', 'scripts', 'ptool.mjs'), 'utf8');
  const accepted = new Set([
    ...[...ptoolSrc.matchAll(/'(--[a-z][a-z-]*)'\s*:/g)].map((m) => m[1]),
    ...[...ptoolSrc.matchAll(/a === '(--[a-z][a-z-]*)'/g)].map((m) => m[1]),
  ]);
  function towerCallFlags(script: string): string[][] {
    const lines = script.split('\n');
    const calls: string[][] = [];
    lines.forEach((line, i) => {
      if (!line.includes('"$TOWER_CALL"')) return;
      let text = line;
      for (let j = i; lines[j]?.trimEnd().endsWith('\\') && j + 1 < lines.length; j++) text += `\n${lines[j + 1]}`;
      calls.push([...text.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((m) => m[1]));
    });
    return calls;
  }

  it('reads a real flag table from ptool.mjs (calibration)', () => {
    expect(accepted.has('--json')).toBe(true);
    expect(accepted.has('--workspace')).toBe(true);
    expect(accepted.has('--client')).toBe(false);
  });

  it('every "$TOWER_CALL" invocation passes only accepted flags', () => {
    const calls = towerCallFlags(physicalScenario);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const unsupported = calls.flat().filter((flag) => !accepted.has(flag));
    expect(unsupported).toEqual([]);
  });

  it('flags a reintroduced --client on a tower call (falsifiability control)', () => {
    const mutant = physicalScenario.replace('dev:dogfood_substrate_status --json -', 'dev:dogfood_substrate_status --json - --client x');
    expect(mutant).not.toBe(physicalScenario);
    expect(towerCallFlags(mutant).flat().filter((flag) => !accepted.has(flag))).toEqual(['--client']);
  });
});

// WI-10003961 rig attempt 2: ptool exits 0 on an ok:false result, so the tower's refusal of
// write B went unnoticed and Phase J waited out its whole bound for a write that never existed.
describe('physical Phase J fails fast when the tower refuses a write', () => {
  function createLoop(script: string): string {
    const start = script.indexOf('for w in A B; do');
    return start < 0 ? '' : script.slice(start, script.indexOf('\n  done\n', start));
  }
  const okCheck = /\.ok === true && Array\.isArray\(o\.results\) && o\.results\.length > 0 && o\.results\.every\(\(r\) => r\.ok === true\)/;

  it('locates the Phase J tower-create loop (calibration)', () => {
    expect(createLoop(physicalScenario)).toContain('work_items:create');
  });
  it('checks every create result is ok before continuing', () => {
    const loop = createLoop(physicalScenario);
    expect(loop).toMatch(okCheck);
    expect(loop).toContain('fail "phase J tower refused write $w;');
  });
  it('requires a tower row for BOTH writes after authoring', () => {
    expect(physicalScenario).toContain("fail 'phase J tower has no row for write A'");
    expect(physicalScenario).toContain("fail 'phase J tower has no row for write B'");
  });
  it('a loop without the ok check fails the guard (falsifiability control)', () => {
    const loop = createLoop(physicalScenario);
    const mutant = physicalScenario.replace(loop, loop.replace(okCheck, 'true'));
    expect(mutant).not.toBe(physicalScenario);
    expect(createLoop(mutant)).not.toMatch(okCheck);
  });
});
