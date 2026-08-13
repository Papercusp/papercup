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
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  physicalDrillSigningBytes,
  validatePhysicalDrillEvidence,
} from './sync/pot-git/physical-drill-evidence';
import {
  physicalDrillHostReceiptSigningBytes,
} from './sync/pot-git/physical-drill-host-receipt';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from './identity/ed25519';

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

const drill = readFileSync(
  join(repoRoot(), 'papercusp-desktop', 'bin', 'hive-git-drill.sh'),
  'utf8',
);
const physicalProbe = readFileSync(
  join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-probe.sh'),
  'utf8',
);
const physicalScenarioPath = join(
  repoRoot(),
  'papercusp-desktop',
  'bin',
  'vm-rig',
  'hive-git-physical-scenario.sh',
);
const physicalScenario = readFileSync(physicalScenarioPath, 'utf8');
const gateMatch = drill.match(
  /# ZERO-SKIP-RELEASE-GATE-BEGIN[^\n]*\n([\s\S]*?)# ZERO-SKIP-RELEASE-GATE-END/,
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
afterAll(() => rmSync(evidenceDir, { recursive: true, force: true }));

function physicalFixture(): Record<string, any> {
  const towerLog = join(evidenceDir, 'tower.log');
  const vmLog = join(evidenceDir, 'vm.log');
  writeFileSync(towerLog, 'tower physical witness\n');
  writeFileSync(vmLog, 'vm physical witness\n');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const oldCore = generateEd25519KeypairDer();
  const newCore = generateEd25519KeypairDer();
  const oid = (digit: string) => digit.repeat(40);
  const fixture: Record<string, any> = {
    schemaVersion: 'hive-git-physical-evidence/v1',
    plan: 'p2p-git-live-activation-2026-07-09',
    runId: 'physical-run-2026-08-13T120000Z',
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
    legVerdicts: [...'ABCDEFG'].map((leg, index) => ({
      leg,
      status: 'pass',
      scope: 'physical',
      observedAt: `2026-08-13T12:${String(index).padStart(2, '0')}:00Z`,
    })),
    legE: {
      planItem: 'P-306',
      status: 'pass',
      writerDeviceKey: tower.pubkeyBase64,
      assertions: {
        bothConsumedBridgedMode: true,
        bothCommitOnly: true,
        membersDidNotDirectPush: true,
        soleBridgeWriter: true,
        upstreamUnchanged: true,
        canonicalDescendsFromAdmitted: true,
        watchdogIntervalsObserved: 2,
        watchdogFalseAlarms: 0,
        divergenceRefused: true,
        rollbackLegacyObserved: true,
      },
      oids: {
        ingressHead: oid('1'),
        lastAdmitted: oid('1'),
        canonicalStaging: oid('2'),
        egressHead: oid('2'),
        remoteStaging: oid('2'),
        upstreamBefore: oid('3'),
        upstreamAfter: oid('3'),
        divergenceCanonicalBefore: oid('2'),
        divergenceCanonicalAfter: oid('2'),
      },
    },
    legG: {
      planItem: 'P-308',
      status: 'pass',
      afterLegs: [...'ABCDEF'],
      assertions: {
        preFailureConverged: true,
        survivorElected: true,
        grantReady: true,
        successorDescendsFromPreFailure: true,
        successorFederatedAndAccepted: true,
        oldAuthorityRejectedStaleEpochSeq: true,
        oldAuthorityCouldNotMoveRefs: true,
        retryableUnknownShaHeldCursor: true,
        retryableUngrantedEpochHeldCursor: true,
        retryAcceptedAfterEvidence: true,
        pgBlipFailedOpenLegacy: true,
        pgBlipNoForcePush: true,
        pgBlipLoserNoisy: true,
        restartCoreKeyChanged: true,
        stableDeviceIdentityPreserved: true,
        postRestartRoundTripExact: true,
      },
      epochs: { priorAccepted: 7, successorGranted: 8, basis: 'crash-takeover' },
      cursor: { beforeRetry: 41, duringUnknownSha: 41, duringUngrantedEpoch: 41, afterAccept: 42 },
      devices: {
        oldAuthority: tower.pubkeyBase64,
        survivor: vm.pubkeyBase64,
        stableDeviceKeyBefore: vm.pubkeyBase64,
        stableDeviceKeyAfter: vm.pubkeyBase64,
        oldCoreKey: oldCore.pubkeyBase64,
        newCoreKey: newCore.pubkeyBase64,
      },
      oids: {
        preFailureStaging: oid('2'),
        successorStaging: oid('4'),
        receiverStaging: oid('4'),
        beforeStaleAuthorityReplay: oid('4'),
        afterStaleAuthorityReplay: oid('4'),
        postRestartCanonical: oid('5'),
        postRestartWorktree: oid('5'),
      },
    },
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
      signature: signWithPrivateKeyDer(
        device.privateKeyDer,
        physicalDrillHostReceiptSigningBytes(unsigned),
      ).toString('base64'),
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

function runGate(input: {
  fail: number;
  skipped: number;
  requireZeroSkips?: boolean;
}): { status: number | null; output: string } {
  expect(gateMatch, 'zero-skip release gate markers must remain in the drill').toBeTruthy();
  const script = [
    'set -uo pipefail',
    'PASS=7',
    `FAIL=${input.fail}`,
    `SKIPPED=${input.skipped}`,
    `REQUIRE_ZERO_SKIPS=${input.requireZeroSkips ? 1 : 0}`,
    gateMatch![1],
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
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

  it('keeps the canonical producer pinned to the checked-in physical E/G scenario', () => {
    expect(physicalProbe).toContain('hive-git-physical-scenario.sh');
    expect(physicalProbe).toContain('canonical E/G scenario driver is not executable');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" preflight');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" sign');
    expect(physicalProbe).toContain('"$TSX" "$PRODUCER" finalize');
    expect(physicalProbe).not.toContain('HIVE_GIT_PHYSICAL_SCENARIO_CMD');
    expect(existsSync(physicalScenarioPath)).toBe(true);
    expect(statSync(physicalScenarioPath).mode & 0o111).not.toBe(0);
    expect(physicalProbe.indexOf('"$SCENARIO" --require-ready')).toBeLessThan(
      physicalProbe.indexOf('ssh "${SSH_OPTS[@]}"'),
    );
  });

  it('installs only the offline scenario contract and emits nothing before fixed A-G executors land', () => {
    const contract = spawnSync(physicalScenarioPath, ['--contract-check'], { encoding: 'utf8' });
    expect(contract.status).toBe(0);
    expect(JSON.parse(contract.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-scenario-contract/v1',
      implementationState: 'offline-contract-v1',
      ready: false,
      phases: [...'ABCDEFG'],
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

    const attempted = spawnSync(
      physicalScenarioPath,
      [output, towerIdentity, vmIdentity],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09',
        },
      },
    );
    expect(attempted.status).toBe(1);
    expect(attempted.stderr).toContain('scenario is not execution-ready (offline-contract-v1)');
    expect(existsSync(output)).toBe(false);
    expect(physicalScenario).toContain('run_all_phases');
    expect(physicalScenario).not.toContain('HIVE_GIT_PHYSICAL_SCENARIO_CMD');
    expect(physicalScenario).not.toMatch(/^\s*(?:ssh|scp|psql|git|systemctl)\b/m);
  });

  it('refuses the canonical wrapper before its first VM ssh while the scenario is incomplete', () => {
    const runDir = mkdtempSync(join(evidenceDir, 'scenario-wrapper-'));
    const fakeBin = join(runDir, 'bin');
    const sshMarker = join(runDir, 'ssh-was-called');
    const { mkdirSync, chmodSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(fakeBin);
    const fakeSsh = join(fakeBin, 'ssh');
    writeFileSync(fakeSsh, `#!/usr/bin/env bash\nprintf called > ${JSON.stringify(sshMarker)}\nexit 99\n`);
    chmodSync(fakeSsh, 0o755);

    const probe = spawnSync(
      join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-probe.sh'),
      [join(runDir, 'evidence.json'), join(runDir, 'trust.json')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          HIVE_GIT_PHYSICAL_PLAN: 'p2p-git-live-activation-2026-07-09',
        },
      },
    );
    expect(probe.status).toBe(1);
    expect(probe.stderr).toContain('scenario is not execution-ready (offline-contract-v1)');
    expect(existsSync(sshMarker)).toBe(false);
  });

  it('accepts a same-run A-G physical artifact only with hash-matching witnesses from both hosts', () => {
    const fixture = physicalFixture();
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict).toMatchObject({ ok: true, runId: 'physical-run-2026-08-13T120000Z', errors: [] });
  });

  it('rejects a self-declared locally signed fixture without an out-of-manifest VM-rig trust anchor', () => {
    const verdict = validatePhysicalDrillEvidence(physicalFixture());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'trusted physical-rig anchor is required outside the evidence manifest',
    );
  });

  it('rejects a hand-written trust anchor that has no keychain-bound host receipts', () => {
    const fixture = physicalFixture();
    const trust = trustedPhysicalAnchor(fixture);
    delete trust.receipts;
    const verdict = validatePhysicalDrillEvidence(fixture, trust);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'trusted anchor must contain exactly two keychain-bound host receipts',
    );
  });

  it('executes the real validator CLI against an attested evidence file', () => {
    const evidencePath = join(evidenceDir, 'accepted-evidence.json');
    const trustPath = join(evidenceDir, 'accepted-trust.json');
    const fixture = physicalFixture();
    writeFileSync(evidencePath, `${JSON.stringify(fixture)}\n`);
    writeFileSync(trustPath, `${JSON.stringify(trustedPhysicalAnchor(fixture))}\n`);
    const result = spawnSync(join(repoRoot(), 'node_modules', '.bin', 'tsx'), [validatorPath, evidencePath, trustPath], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      schemaVersion: 'hive-git-physical-evidence/v1',
    });
  });

  it('rejects a manifest changed after either physical device attested it', () => {
    const fixture = physicalFixture();
    fixture.legE.assertions.watchdogIntervalsObserved = 3;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain(
      'not a valid signature over the canonical evidence payload',
    );
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
    expect(verdict.errors).toContain(
      'legVerdicts.D.observedAt must fall inside the one physical-run window',
    );
  });

  it('rejects a Leg E OID chain that did not reach the remote staging ref', () => {
    const fixture = physicalFixture();
    fixture.legE.oids.remoteStaging = '9'.repeat(40);
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legE canonicalStaging/remoteStaging must match exactly');
  });

  it('rejects a Leg G retry that advanced the cursor before missing evidence arrived', () => {
    const fixture = physicalFixture();
    fixture.legG.cursor.duringUnknownSha = 42;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'legG retryable unknown-sha/ungranted-epoch must hold the fed-event cursor',
    );
  });

  it('rejects a Leg G takeover without a strictly higher authority epoch', () => {
    const fixture = physicalFixture();
    fixture.legG.epochs.successorGranted = 7;
    const verdict = validatePhysicalDrillEvidence(fixture, trustedPhysicalAnchor(fixture));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'legG.epochs.successorGranted must be strictly greater than priorAccepted',
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
