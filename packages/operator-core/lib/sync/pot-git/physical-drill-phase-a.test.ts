import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubOriginNamespaceKey } from './github-ingress';
import {
  PHASE_A_GITHUB_ORIGIN_NAMESPACE,
  PHASE_A_GITHUB_REMOTE,
  PHASE_A_INPUT_SCHEMA,
  PHASE_A_POT_HOME,
  PHASE_A_REPO_KEY,
  capturePhysicalPhaseARepo,
  quarantinePhysicalPhaseARepo,
  validatePhysicalPhaseA,
  type PhysicalPhaseAInput,
} from './physical-drill-phase-a';
import { deviceNamespaceKey } from './storage';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { SIGREFS_REF, sigrefsSigningBytes, type SignedSigrefs } from './sigrefs';

const roots: string[] = [];
const towerDevice = generateEd25519KeypairDer();
const vmDevice = generateEd25519KeypairDer();
const towerKey = towerDevice.pubkeyBase64;
const vmKey = vmDevice.pubkeyBase64;
const times = [
  '2026-08-13T18:00:00.000Z',
  '2026-08-13T18:00:01.000Z',
  '2026-08-13T18:00:02.000Z',
  '2026-08-13T18:00:03.000Z',
  '2026-08-13T18:00:04.000Z',
  '2026-08-13T18:00:05.000Z',
  '2026-08-13T18:00:06.000Z',
  '2026-08-13T18:00:07.000Z',
  '2026-08-13T18:00:08.000Z',
] as const;

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

function repoPath(root: string): string {
  return join(root, PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
}

function createRepo(root: string, refs: Array<[string, string]>): string {
  const repo = repoPath(root);
  const init = spawnSync('git', ['init', '--bare', repo], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (init.status !== 0) throw new Error(init.stderr);
  for (const [name, body] of refs) {
    const oid = runGit(repo, ['hash-object', '-w', '--stdin'], body);
    runGit(repo, ['update-ref', name, oid]);
  }
  return repo;
}

function createWitnessedRepo(root: string, refs: Array<[string, string]>): string {
  const repo = createRepo(root, refs);
  for (const [device, ts, version] of [
    [towerDevice, Date.parse(times[0]), 7],
    [vmDevice, Date.parse(times[5]), 18],
  ] as const) {
    const namespace = deviceNamespaceKey(device.pubkeyBase64);
    const payload = {
      v: 1,
      device_pubkey: device.pubkeyBase64,
      version,
      ts,
      refs: refs
        .filter(([name]) => name.startsWith(`refs/namespaces/${namespace}/`) && !name.endsWith(`/${SIGREFS_REF}`))
        .map(([name]) => ({
          ref: name.slice(`refs/namespaces/${namespace}/`.length),
          sha: runGit(repo, ['rev-parse', name]),
        })),
    };
    const signed: SignedSigrefs = {
      ...payload,
      sig: signWithPrivateKeyDer(device.privateKeyDer, sigrefsSigningBytes(payload)).toString('base64'),
    };
    const oid = runGit(repo, ['hash-object', '-w', '--stdin'], JSON.stringify(signed));
    runGit(repo, ['update-ref', `refs/namespaces/${namespace}/${SIGREFS_REF}`, oid]);
  }
  return repo;
}

function newRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `p505-phase-a-${label}-`));
  roots.push(root);
  return root;
}

function fixture(): PhysicalPhaseAInput {
  const towerRoot = newRoot('tower');
  const vmRoot = newRoot('vm');
  const towerNamespace = deviceNamespaceKey(towerKey);
  const vmNamespace = deviceNamespaceKey(vmKey);
  const refs: Array<[string, string]> = [
    [`refs/namespaces/${towerNamespace}/refs/heads/work`, 'tower-work'],
    [`refs/namespaces/${vmNamespace}/refs/heads/work`, 'vm-work'],
  ];
  const towerRepo = createWitnessedRepo(towerRoot, refs);
  const vmRepo = createWitnessedRepo(vmRoot, refs);
  const towerBefore = capturePhysicalPhaseARepo({
    hostId: 'tower',
    state: 'present',
    repoPath: towerRepo,
    ownDeviceKey: towerKey,
    peerDeviceKey: vmKey,
    observedAt: times[1],
  });
  const quarantine = quarantinePhysicalPhaseARepo({ repoPath: vmRepo, runId: 'run-physical-a-1' });
  quarantine.observedAt = times[2];
  const vmAbsent = capturePhysicalPhaseARepo({
    hostId: 'vm',
    state: 'absent',
    repoPath: vmRepo,
    ownDeviceKey: vmKey,
    peerDeviceKey: towerKey,
    observedAt: times[3],
  });
  createWitnessedRepo(vmRoot, refs);
  const towerAfter = capturePhysicalPhaseARepo({
    hostId: 'tower',
    state: 'present',
    repoPath: towerRepo,
    ownDeviceKey: towerKey,
    peerDeviceKey: vmKey,
    observedAt: times[6],
  });
  const vmAfter = capturePhysicalPhaseARepo({
    hostId: 'vm',
    state: 'present',
    repoPath: vmRepo,
    ownDeviceKey: vmKey,
    peerDeviceKey: towerKey,
    observedAt: times[7],
  });
  return {
    schemaVersion: PHASE_A_INPUT_SCHEMA,
    runId: 'run-physical-a-1',
    window: { startedAt: times[0], finishedAt: times[8] },
    identities: { towerDeviceKey: towerKey, vmDeviceKey: vmKey },
    quarantine,
    bootstrap: {
      tool: 'git-sync:run',
      installSlug: 'hello-world-3-pot',
      targetHost: 'vm',
      fired: true,
      startedAt: times[4],
      finishedAt: times[5],
    },
    observations: { towerBefore, vmAbsent, towerAfter, vmAfter },
  };
}

describe('P-505 fixed physical Phase A cold-join executor core', () => {
  it('keeps the fixed canary on the registry-pinned self-hive repo key', () => {
    expect(PHASE_A_REPO_KEY).toBe('gh-1303510992');
  });

  it('accepts only a signed, absence-before-canonical-bootstrap two-store witness', () => {
    const verdict = validatePhysicalPhaseA(fixture());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        phase: 'A',
        planItem: 'P-302',
        status: 'complete',
        complete: true,
        missingAssertions: [],
        assertions: {
          vmStoreQuarantinedByScenario: true,
          vmAbsenceObservedBeforeBootstrap: true,
          canonicalGitSyncBootstrapTriggered: true,
          bothPhysicalDeviceNamespacesOnBothHosts: true,
          namespaceRefOidsMatch: true,
          referencedObjectsExistOnBothHosts: true,
          oneObjectDatabasePerRepo: true,
          identityDerivedNamespacesObserved: true,
          eachDeviceWritesOnlyItsOwnNamespace: true,
        },
      },
    });
  });

  it('cannot label a warm VM store absent', () => {
    const root = newRoot('warm');
    const repo = createRepo(root, []);
    expect(() =>
      capturePhysicalPhaseARepo({
        hostId: 'vm',
        state: 'absent',
        repoPath: repo,
        ownDeviceKey: vmKey,
        peerDeviceKey: towerKey,
      }),
    ).toThrow(/expected absent repo/);
  });

  it('quarantines only the fixed canonical target and preserves it as a sibling', () => {
    const root = newRoot('quarantine');
    const repo = createRepo(root, []);
    const result = quarantinePhysicalPhaseARepo({ repoPath: repo, runId: 'run-physical-a-2' });
    expect(result).toMatchObject({ method: 'atomic-rename', sourcePath: repo });
    expect(result.quarantinePath).toBe(`${repo}.p505-phase-a-run-physical-a-2`);
    expect(() =>
      quarantinePhysicalPhaseARepo({
        repoPath: join(root, 'wrong-pot', 'wrong.git'),
        runId: 'run-physical-a-3',
      }),
    ).toThrow(/must target/);
  });

  it('rejects ref divergence, missing objects, alternates, and a single-store witness', () => {
    const input = fixture();
    input.observations.vmAfter.refs[0]!.oid = 'a'.repeat(40);
    input.observations.vmAfter.refs[0]!.objectExists = false;
    input.observations.vmAfter.alternates = ['/prebanked/object-store'];
    input.observations.vmAfter.repoFingerprint = input.observations.towerAfter.repoFingerprint;
    const verdict = validatePhysicalPhaseA(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not resolve to a local object'),
        'vm object database must not use alternates',
        'tower and vm namespaced ref OIDs must match exactly after bootstrap',
        'tower and vm observations must come from distinct physical repo directories',
      ]),
    );
  });

  it('excludes ONLY the per-host synthetic github-origin namespace from ref parity (P-505 run 8, WI-10003595)', () => {
    // The pot's github-origin namespace is derived from its remote, not a device key.
    expect(PHASE_A_GITHUB_ORIGIN_NAMESPACE).toBe(githubOriginNamespaceKey(PHASE_A_GITHUB_REMOTE));
    expect(PHASE_A_GITHUB_ORIGIN_NAMESPACE.startsWith('759ec12f598691d3')).toBe(true);

    // Each host ingresses GitHub on its own: different branch AND different OID.
    const input = fixture();
    const [towerRef, vmRef] = input.observations.towerAfter.refs;
    input.observations.towerAfter.refs.push({
      ...towerRef!,
      name: `refs/namespaces/${PHASE_A_GITHUB_ORIGIN_NAMESPACE}/refs/heads/staging`,
    });
    input.observations.vmAfter.refs.push({
      ...vmRef!,
      name: `refs/namespaces/${PHASE_A_GITHUB_ORIGIN_NAMESPACE}/refs/heads/main`,
    });
    const verdict = validatePhysicalPhaseA(input);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);

    // Control: the SAME divergence under any other namespace still fails parity.
    const other = fixture();
    const otherNamespace = 'f'.repeat(64);
    other.observations.towerAfter.refs.push({
      ...other.observations.towerAfter.refs[0]!,
      name: `refs/namespaces/${otherNamespace}/refs/heads/staging`,
    });
    other.observations.vmAfter.refs.push({
      ...other.observations.vmAfter.refs[1]!,
      name: `refs/namespaces/${otherNamespace}/refs/heads/main`,
    });
    expect(validatePhysicalPhaseA(other).errors).toContain(
      'tower and vm namespaced ref OIDs must match exactly after bootstrap',
    );
  });

  it('rejects a non-canonical bootstrap or a causal timestamp inversion', () => {
    const input = fixture();
    input.bootstrap.tool = 'git-sync:run';
    // The retired joinHiveAsView member slug (WI-10003546) is not the VM's install.
    input.bootstrap.installSlug = 'hello-world' as never;
    input.bootstrap.targetHost = 'vm';
    input.bootstrap.startedAt = times[2];
    input.bootstrap.finishedAt = times[2];
    input.quarantine.method = 'atomic-rename';
    input.quarantine.sourcePath = '/tmp/not-the-observed-store';
    const verdict = validatePhysicalPhaseA(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'VM bootstrap must be the fixed canonical git-sync:run invocation',
        'Phase A observations do not preserve absence-before-bootstrap causal order',
        'VM store absence must come from the scenario atomic-quarantine operation',
      ]),
    );
  });

  it('rejects a peer-spoofed namespace snapshot even when the ref OIDs match', () => {
    const input = fixture();
    const witness = input.observations.vmAfter.namespaceWitnesses.find((value) => value.deviceKey === vmKey)!;
    witness.signed.device_pubkey = towerKey;
    const verdict = validatePhysicalPhaseA(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      `vm namespace ${deviceNamespaceKey(vmKey)} sigrefs signature is invalid`,
    );
  });

  it('rejects a VM own-namespace signature banked before the cold bootstrap', () => {
    const input = fixture();
    for (const observation of [input.observations.towerAfter, input.observations.vmAfter]) {
      observation.namespaceWitnesses.find((value) => value.deviceKey === vmKey)!.signed.ts = Date.parse(times[1]);
    }
    const verdict = validatePhysicalPhaseA(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      'VM own-namespace signature must be created after cold bootstrap starts and before VM observation',
    );
  });
});
