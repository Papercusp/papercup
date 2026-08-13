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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePhysicalDrillEvidence } from './sync/pot-git/physical-drill-evidence';

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
const gateMatch = drill.match(
  /# ZERO-SKIP-RELEASE-GATE-BEGIN[^\n]*\n([\s\S]*?)# ZERO-SKIP-RELEASE-GATE-END/,
);

const evidenceDir = mkdtempSync(join(tmpdir(), 'hive-git-physical-evidence-'));
afterAll(() => rmSync(evidenceDir, { recursive: true, force: true }));

function physicalFixture(): Record<string, any> {
  const towerLog = join(evidenceDir, 'tower.log');
  const vmLog = join(evidenceDir, 'vm.log');
  writeFileSync(towerLog, 'tower physical witness\n');
  writeFileSync(vmLog, 'vm physical witness\n');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const tower = 'A'.repeat(43);
  const vm = 'B'.repeat(43);
  const oldCore = 'C'.repeat(43);
  const newCore = 'D'.repeat(43);
  const oid = (digit: string) => digit.repeat(40);
  return {
    schemaVersion: 'hive-git-physical-evidence/v1',
    plan: 'p2p-git-live-activation-2026-07-09',
    runId: 'physical-run-2026-08-13T120000Z',
    window: { startedAt: '2026-08-13T12:00:00Z', finishedAt: '2026-08-13T12:30:00Z' },
    topology: {
      kind: 'two-physical-machines',
      hosts: [
        { id: 'tower', deviceKey: tower },
        { id: 'vm', deviceKey: vm },
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
      writerDeviceKey: tower,
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
        oldAuthority: tower,
        survivor: vm,
        stableDeviceKeyBefore: vm,
        stableDeviceKeyAfter: vm,
        oldCoreKey: oldCore,
        newCoreKey: newCore,
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
    const inventory = [...drill.matchAll(/^skipp "LEG ([A-G]) \(P-(\d+)\)/gm)].map(
      ([, leg, item]) => `${leg}/P-${item}`,
    );
    expect(inventory).toEqual(['E/P-306', 'G/P-308']);
    expect(drill).toContain('HIVE_GIT_PHYSICAL_PROBE_CMD');
    expect(drill).toContain('physical-drill-evidence.ts');
  });

  it('accepts a same-run A-G physical artifact only with hash-matching witnesses from both hosts', () => {
    const verdict = validatePhysicalDrillEvidence(physicalFixture());
    expect(verdict).toMatchObject({ ok: true, runId: 'physical-run-2026-08-13T120000Z', errors: [] });
  });

  it('rejects a structure-only pass claim with no raw physical-host artifacts', () => {
    const fixture = physicalFixture();
    fixture.artifacts = [];
    const verdict = validatePhysicalDrillEvidence(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('raw witness from each physical host');
  });

  it('rejects a Leg E OID chain that did not reach the remote staging ref', () => {
    const fixture = physicalFixture();
    fixture.legE.oids.remoteStaging = '9'.repeat(40);
    const verdict = validatePhysicalDrillEvidence(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('legE canonicalStaging/remoteStaging must match exactly');
  });

  it('rejects a Leg G retry that advanced the cursor before missing evidence arrived', () => {
    const fixture = physicalFixture();
    fixture.legG.cursor.duringUnknownSha = 42;
    const verdict = validatePhysicalDrillEvidence(fixture);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'legG retryable unknown-sha/ungranted-epoch must hold the fed-event cursor',
    );
  });

  it('rejects a Leg G takeover without a strictly higher authority epoch', () => {
    const fixture = physicalFixture();
    fixture.legG.epochs.successorGranted = 7;
    const verdict = validatePhysicalDrillEvidence(fixture);
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
