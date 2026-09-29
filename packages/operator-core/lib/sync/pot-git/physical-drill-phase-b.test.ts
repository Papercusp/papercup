import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { buildSigrefs } from './sigrefs';
import { deviceNamespaceKey } from './storage';
import { peerNamespaceRefspec } from './fetch-transport';
import { PHASE_A_POT_HOME, PHASE_A_REPO_KEY, physicalDrillGitSyncSlug } from './physical-drill-phase-a';
import {
  PHASE_B_INPUT_SCHEMA,
  capturePhysicalPhaseBRepo,
  createPhysicalPhaseBCommit,
  phaseBObservationLag,
  validatePhysicalPhaseB,
  type PhysicalPhaseBDirection,
  type PhysicalPhaseBDirectionInput,
  type PhysicalPhaseBHost,
  type PhysicalPhaseBInput,
} from './physical-drill-phase-b';

const roots: string[] = [];
const tower = generateEd25519KeypairDer();
const vm = generateEd25519KeypairDer();
const times = Array.from({ length: 32 }, (_, index) =>
  new Date(Date.parse('2026-08-13T20:00:00.000Z') + index * 1_000).toISOString(),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runGit(repo: string, args: string[], input?: string): string {
  const result = spawnSync('git', ['--git-dir', repo, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function newRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `p505-phase-b-${label}-`));
  roots.push(root);
  const repo = join(root, PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
  const initialized = spawnSync('git', ['init', '--bare', repo], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  return repo;
}

function signer(device: typeof tower): (bytes: Buffer) => Promise<Buffer> {
  return (bytes) => Promise.resolve(signWithPrivateKeyDer(device.privateKeyDer, bytes));
}

async function seedBothNamespaces(repo: string): Promise<void> {
  for (const [device, label, version] of [
    [tower, 'tower-base', 7],
    [vm, 'vm-base', 17],
  ] as const) {
    const blob = runGit(repo, ['hash-object', '-w', '--stdin'], `${label}\n`);
    runGit(repo, ['update-ref', `refs/namespaces/${deviceNamespaceKey(device.pubkeyBase64)}/refs/heads/base`, blob]);
    await buildSigrefs(repo, device.pubkeyBase64, signer(device), {
      nowMs: Date.parse(times[0]!),
      version,
    });
  }
}

function trigger(
  host: PhysicalPhaseBHost,
  role: 'source-publish' | 'destination-receive',
  startedAt: string,
  finishedAt: string,
) {
  return {
    tool: 'git-sync:run' as const,
    installSlug: physicalDrillGitSyncSlug(host),
    host,
    role,
    fired: true as const,
    startedAt,
    finishedAt,
  };
}

async function runDirection(input: {
  direction: PhysicalPhaseBDirection;
  runId: string;
  sourceRepo: string;
  destinationRepo: string;
  sourceHost: PhysicalPhaseBHost;
  destinationHost: PhysicalPhaseBHost;
  sourceDevice: typeof tower;
  destinationDevice: typeof tower;
  offset: number;
  priorVersion: number;
}): Promise<PhysicalPhaseBDirectionInput> {
  const at = (delta: number) => times[input.offset + delta]!;
  const sourceBefore = capturePhysicalPhaseBRepo({
    hostId: input.sourceHost,
    direction: input.direction,
    state: 'absent',
    repoPath: input.sourceRepo,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    runId: input.runId,
    observedAt: at(1),
  });
  const destinationBefore = capturePhysicalPhaseBRepo({
    hostId: input.destinationHost,
    direction: input.direction,
    state: 'absent',
    repoPath: input.destinationRepo,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    runId: input.runId,
    observedAt: at(2),
  });
  const mutation = createPhysicalPhaseBCommit({
    sourceHost: input.sourceHost,
    direction: input.direction,
    repoPath: input.sourceRepo,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    runId: input.runId,
    createdAt: at(3),
  });
  await buildSigrefs(input.sourceRepo, input.sourceDevice.pubkeyBase64, signer(input.sourceDevice), {
    nowMs: Date.parse(at(5)),
    version: input.priorVersion + 1,
  });
  const sourceAfter = capturePhysicalPhaseBRepo({
    hostId: input.sourceHost,
    direction: input.direction,
    state: 'present',
    repoPath: input.sourceRepo,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    runId: input.runId,
    observedAt: at(6),
  });
  runGit(input.destinationRepo, ['fetch', input.sourceRepo, peerNamespaceRefspec(input.sourceDevice.pubkeyBase64)]);
  const destinationAfter = capturePhysicalPhaseBRepo({
    hostId: input.destinationHost,
    direction: input.direction,
    state: 'present',
    repoPath: input.destinationRepo,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    runId: input.runId,
    observedAt: at(9),
  });
  return {
    direction: input.direction,
    sourceHost: input.sourceHost,
    destinationHost: input.destinationHost,
    sourceDeviceKey: input.sourceDevice.pubkeyBase64,
    destinationDeviceKey: input.destinationDevice.pubkeyBase64,
    window: { startedAt: at(0), finishedAt: at(10) },
    mutation,
    triggers: {
      sourcePublish: trigger(input.sourceHost, 'source-publish', at(4), at(5)),
      destinationReceive: trigger(input.destinationHost, 'destination-receive', at(7), at(8)),
    },
    observations: { sourceBefore, destinationBefore, sourceAfter, destinationAfter },
    latencyMs: Date.parse(at(9)) - Date.parse(at(4)),
  };
}

async function fixture(): Promise<PhysicalPhaseBInput> {
  const towerRepo = newRepo('tower');
  const vmRepo = newRepo('vm');
  await seedBothNamespaces(towerRepo);
  await seedBothNamespaces(vmRepo);
  const runId = 'p505-phase-b-unit-1';
  const towerToVm = await runDirection({
    direction: 'tower-to-vm',
    runId,
    sourceRepo: towerRepo,
    destinationRepo: vmRepo,
    sourceHost: 'tower',
    destinationHost: 'vm',
    sourceDevice: tower,
    destinationDevice: vm,
    offset: 1,
    priorVersion: 7,
  });
  const vmToTower = await runDirection({
    direction: 'vm-to-tower',
    runId,
    sourceRepo: vmRepo,
    destinationRepo: towerRepo,
    sourceHost: 'vm',
    destinationHost: 'tower',
    sourceDevice: vm,
    destinationDevice: tower,
    offset: 13,
    priorVersion: 17,
  });
  return {
    schemaVersion: PHASE_B_INPUT_SCHEMA,
    runId,
    window: { startedAt: times[0]!, finishedAt: times[24]! },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    directions: [towerToVm, vmToTower],
  };
}

function clone(input: PhysicalPhaseBInput): PhysicalPhaseBInput {
  return JSON.parse(JSON.stringify(input)) as PhysicalPhaseBInput;
}

describe('P-505 fixed physical Phase B bidirectional ref-announcement executor core', () => {
  it('accepts exact signed namespace, commit payload, object-count, and latency evidence in both directions', async () => {
    const verdict = validatePhysicalPhaseB(await fixture());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        phase: 'B',
        planItem: 'P-303',
        status: 'complete',
        complete: true,
        missingAssertions: [],
        assertions: {
          freshRunBoundCommitInEachDeviceNamespace: true,
          sourceSigrefsAdvancedAfterEachCommit: true,
          canonicalRefAnnouncePublishAndReceiveTicksTriggered: true,
          exactSignedNamespaceSnapshotReachedPeer: true,
          exactCommitAndPayloadReachedPeer: true,
          referencedObjectsExistOnBothHosts: true,
          bidirectionalTransferObserved: true,
          nativeV2PackPathOnly: true,
        },
        directions: [
          { direction: 'tower-to-vm', latencyMs: 5_000, reachableObjectCount: 3, sigrefsVersion: 8 },
          { direction: 'vm-to-tower', latencyMs: 5_000, reachableObjectCount: 3, sigrefsVersion: 18 },
        ],
      },
    });
  });

  it('creates only the derived source namespace ref and refuses a pre-existing run ref', async () => {
    const repo = newRepo('mutation');
    await seedBothNamespaces(repo);
    const created = createPhysicalPhaseBCommit({
      sourceHost: 'tower',
      direction: 'tower-to-vm',
      repoPath: repo,
      sourceDeviceKey: tower.pubkeyBase64,
      runId: 'p505-phase-b-mutation',
      createdAt: times[3],
    });
    expect(created.ref).toContain(`refs/namespaces/${deviceNamespaceKey(tower.pubkeyBase64)}/`);
    expect(runGit(repo, ['rev-parse', created.ref])).toBe(created.oid);
    expect(() =>
      createPhysicalPhaseBCommit({
        sourceHost: 'tower',
        direction: 'tower-to-vm',
        repoPath: repo,
        sourceDeviceKey: tower.pubkeyBase64,
        runId: 'p505-phase-b-mutation',
      }),
    ).toThrow(/pre-existing transfer ref/);
    expect(() =>
      createPhysicalPhaseBCommit({
        sourceHost: 'vm',
        direction: 'tower-to-vm',
        repoPath: repo,
        sourceDeviceKey: tower.pubkeyBase64,
        runId: 'p505-phase-b-wrong-host',
      }),
    ).toThrow(/must be authored on tower/);
  });

  it('rejects pre-banked destination evidence and a mismatched transferred object count', async () => {
    const input = clone(await fixture());
    input.directions[0].observations.destinationBefore = clone(input).directions[0].observations.destinationAfter;
    input.directions[1].observations.destinationAfter.objectCounts.reachableFromTransfer += 1;
    const verdict = validatePhysicalPhaseB(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'tower-to-vm.destinationBefore must prove the transfer ref absent before mutation',
        'vm-to-tower source and destination reachable object counts must match exactly',
      ]),
    );
  });

  it('rejects a spoofed sigrefs snapshot even when the ref and commit OIDs match', async () => {
    const input = clone(await fixture());
    input.directions[0].observations.destinationAfter.signedSigrefs!.device_pubkey = vm.pubkeyBase64;
    const verdict = validatePhysicalPhaseB(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      "tower-to-vm.destinationAfter must contain the source device's valid signed sigrefs",
    );
  });

  it('rejects a caller-shaped trigger, invented latency, or reversed causal order', async () => {
    const input = clone(await fixture());
    input.directions[0].triggers.destinationReceive.host = 'tower';
    input.directions[0].latencyMs = 1;
    input.directions[1].triggers.sourcePublish.startedAt = times[31]!;
    const verdict = validatePhysicalPhaseB(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'Phase B vm destination-receive must use the fixed canonical git-sync:run trigger',
        'tower-to-vm latencyMs must exactly measure the bounded physical transfer',
        'vm-to-tower observations do not preserve commit-before-publish-before-receive causal order',
      ]),
    );
  });

  // P-505 run 33b: the tower source was read once, after the fresh sigrefs were
  // signed and announced but before its local sigrefs ref moved. The wait
  // predicate must call exactly that store lagging and every accepted after-store
  // converged, or the scenario either rejects a good transfer or waits forever.
  it('reports convergence lag on the run-33b source shape and none on accepted evidence', async () => {
    const accepted = await fixture();
    for (const direction of accepted.directions) {
      const expected = {
        oid: direction.mutation.oid,
        beforeSigrefsVersion: direction.observations.sourceBefore.signedSigrefs!.version,
      };
      expect(phaseBObservationLag(direction.observations.sourceAfter, expected)).toEqual([]);
      expect(phaseBObservationLag(direction.observations.destinationAfter, expected)).toEqual([]);
    }

    const lagging = clone(accepted);
    const forward = lagging.directions[0];
    forward.observations.sourceAfter.sigrefsOid = forward.observations.sourceBefore.sigrefsOid;
    forward.observations.sourceAfter.signedSigrefs = forward.observations.sourceBefore.signedSigrefs;
    expect(
      phaseBObservationLag(forward.observations.sourceAfter, {
        oid: forward.mutation.oid,
        beforeSigrefsVersion: forward.observations.sourceBefore.signedSigrefs!.version,
      }),
    ).toEqual(['sigrefs version', 'signed transfer ref']);
    expect(validatePhysicalPhaseB(lagging).errors).toEqual(
      expect.arrayContaining([
        'tower-to-vm source sigrefs version must advance after the fresh commit',
        'tower-to-vm post-commit sigrefs must sign the exact fresh transfer ref and OID',
      ]),
    );

    const absent = { ...accepted.directions[1].observations.destinationAfter, refOid: null };
    expect(
      phaseBObservationLag(absent, {
        oid: accepted.directions[1].mutation.oid,
        beforeSigrefsVersion: accepted.directions[1].observations.sourceBefore.signedSigrefs!.version,
      }),
    ).toEqual(['transfer ref']);
  });
});
