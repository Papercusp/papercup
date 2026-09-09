import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  P305_LIFECYCLE_MARKER,
  P305_RELEASE_REGISTRY_NAMESPACE,
  P305_RELEASE_REGISTRY_REPOSITORY,
  buildP305PhaseProbeScript,
  buildP305RollbackScript,
  buildP305SwitchScript,
  normalizeP305LifecycleInput,
  parseP305HostPrepareDiagnostics,
  parseP305PhaseMarker,
  parseP305UpdateReference,
  // @ts-expect-error -- side-effect-free .mjs command contract, deliberately untyped.
} from '../../bin/gcp-bootc-lifecycle-args.mjs';
import {
  buildIapReverseTunnelArgs,
  buildIapScpArgs,
  buildIapSshArgs,
  // @ts-expect-error -- side-effect-free .mjs argv builders, deliberately untyped.
} from '../../bin/gcp-private-vm-session.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const UPDATE_REFERENCE = `${P305_RELEASE_REGISTRY_REPOSITORY}@${DIGEST}`;
const SENTINEL = 'b'.repeat(64);
const BASE = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  subnetwork: 'pc-p046-canary-02-a810e759-subnet',
  stagingBucket: 'gs://p303-image-staging-active-alcove-504205-q3',
  initialGceTarPath: '/tmp/p305-r21/image.tar.gz',
  initialGceTarSha256: 'c'.repeat(64),
  expectedInitialVersion: '0.0.18-r21',
  expectedUpdateVersion: '0.0.18-r31',
  updateImageReference: UPDATE_REFERENCE,
};

const RUNNER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'papercusp-gcp-bootc-lifecycle.mjs',
);
const PRIVATE_VM_SESSION_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'gcp-private-vm-session.mjs',
);

describe('P-305 lifecycle input contract', () => {
  it('requires an exact digest-pinned reference in the image policy namespace', () => {
    expect(parseP305UpdateReference(UPDATE_REFERENCE)).toEqual({
      reference: UPDATE_REFERENCE,
      repository: P305_RELEASE_REGISTRY_REPOSITORY,
      digest: DIGEST,
    });
    for (const invalid of [
      `${P305_RELEASE_REGISTRY_REPOSITORY}:latest`,
      `registry.example.com/papercusp/workspace-host@${DIGEST}`,
      `${P305_RELEASE_REGISTRY_REPOSITORY}@sha256:short`,
      `${P305_RELEASE_REGISTRY_NAMESPACE}/p305-r31-update-20260907t195536z@${DIGEST}`,
    ]) {
      expect(() => parseP305UpdateReference(invalid)).toThrow(/exact digest-pinned/);
    }
  });

  it('normalizes the immutable artifact, release pair and private-network inputs', () => {
    expect(normalizeP305LifecycleInput({ ...BASE, stagingBucket: `${BASE.stagingBucket}/` })).toMatchObject({
      ...BASE,
      stagingBucket: BASE.stagingBucket,
      initialGceTarSha256: BASE.initialGceTarSha256,
      updateDigest: DIGEST,
      machineType: 'e2-standard-2',
    });
    expect(() => normalizeP305LifecycleInput({ ...BASE, initialGceTarPath: 'relative.tar.gz' })).toThrow(
      /must be absolute/,
    );
    expect(() => normalizeP305LifecycleInput({ ...BASE, stagingBucket: 'https://bucket.invalid' })).toThrow(
      /gs:\/\/ bucket URI/,
    );
  });
});

describe('private IAP argv', () => {
  const session = {
    projectId: BASE.projectId,
    instanceName: 'p305-lifecycle-deadbeef',
    zone: BASE.zone,
  };

  it('keeps commands and copies on the no-public-IP IAP path', () => {
    expect(buildIapSshArgs({ ...session, command: 'id' })).toEqual([
      'compute',
      'ssh',
      session.instanceName,
      `--project=${session.projectId}`,
      `--zone=${session.zone}`,
      '--tunnel-through-iap',
      '--quiet',
      '--command',
      'id',
    ]);
    expect(
      buildIapScpArgs({ ...session, sourcePath: '/tmp/probe.sh', remotePath: '/tmp/probe.sh' }),
    ).toContain('--tunnel-through-iap');
  });

  it('reverse-forwards only guest and controller loopback, with forward failure fatal', () => {
    const args = buildIapReverseTunnelArgs({ ...session, remotePort: 5096 });
    expect(args).toContain('--tunnel-through-iap');
    expect(args).toContain('127.0.0.1:5096:127.0.0.1:5096');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).not.toContain('-g');
    expect(() => buildIapReverseTunnelArgs({ ...session, remotePort: 5096, localHost: '0.0.0.0' })).toThrow(
      /loopback/,
    );
  });

  it('binds the child-process spawn used by the reverse-tunnel runtime path', () => {
    const source = readFileSync(PRIVATE_VM_SESSION_SOURCE, 'utf8');
    const spawnImport = "import { spawn } from 'node:child_process';";
    const tunnelSpawn = "const child = spawn('gcloud', args";
    expect(source.match(/import \{ spawn \} from 'node:child_process';/g)).toHaveLength(1);
    expect(source.indexOf(spawnImport)).toBeLessThan(source.indexOf(tunnelSpawn));
  });
});

describe('P-305 guest lifecycle contract', () => {
  it('pairs positive and wrong-key signature controls with identity and retained-data assertions', () => {
    const script = buildP305PhaseProbeScript({
      phase: 'initial',
      expectedVersion: BASE.expectedInitialVersion,
      updateImageReference: UPDATE_REFERENCE,
      sentinelToken: SENTINEL,
    });
    expect(script).toContain('skopeo inspect --policy /etc/containers/policy.json');
    expect(script).toContain('/tmp/p305-wrong-key.pub');
    expect(script).toContain('wrong-signing-key-was-accepted');
    expect(script).toContain('workspace-user-can-read-runtime');
    expect(script).toContain('agent-user-can-read-state');
    expect(script).toContain('runtime_read_group=papercusp-runtime-read');
    expect(script).toContain('runtime-read-gid-drift');
    expect(script).toContain('runtime-release-group-drift');
    expect(script).toContain('workspace-user-in-runtime-read-group');
    expect(script).toContain('service-cannot-read-runtime');
    expect(script).toContain('runtime-still-relies-on-named-user-acl');
    expect(script).not.toContain('runtime-agent-acl-missing');
    expect(script).toContain("'default:user:papercusp-agent:rwx'");
    expect(script).toContain('/var/lib/papercusp/p305-lifecycle');
    expect(script).not.toContain('rm -rf');
    expect(script).toContain(
      `expected_sentinel_sha='${createHash('sha256').update(SENTINEL, 'utf8').digest('hex')}'`,
    );
    expect(script).toContain(`${P305_LIFECYCLE_MARKER} phase=%s`);
  });

  it('preserves typed bounded host-prepare diagnostics before refusing the phase', () => {
    const script = buildP305PhaseProbeScript({
      phase: 'initial',
      expectedVersion: BASE.expectedInitialVersion,
      updateImageReference: UPDATE_REFERENCE,
      sentinelToken: SENTINEL,
    });
    const diagnosticMarker = 'PAPERCUSP-P305-HOST-PREPARE-DIAGNOSTIC';
    expect(script).toContain('systemctl show papercusp-host-prepare.service --property=ActiveState --value');
    expect(script).toContain('systemctl status papercusp-host-prepare.service --no-pager --full');
    expect(script).toContain('journalctl --unit=papercusp-host-prepare.service --boot');
    expect(script.indexOf(diagnosticMarker)).toBeLessThan(script.indexOf('fail host-prepare-not-active'));

    const parsed = parseP305HostPrepareDiagnostics(
      [
        'PAPERCUSP-P305-HOST-PREPARE-STATUS × papercusp-host-prepare.service',
        'PAPERCUSP-P305-HOST-PREPARE-JOURNAL PAPERCUSP-HOST-PREPARE: FATAL firewall table missing',
        `${diagnosticMarker} phase=initial active_state=failed sub_state=failed result=exit-code exec_main_status=1`,
        'PAPERCUSP-P305-FAIL phase=initial host-prepare-not-active',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      phase: 'initial',
      activeState: 'failed',
      subState: 'failed',
      result: 'exit-code',
      execMainStatus: 1,
      statusExcerpt: ['× papercusp-host-prepare.service'],
      journalExcerpt: ['PAPERCUSP-HOST-PREPARE: FATAL firewall table missing'],
    });
    expect(parseP305HostPrepareDiagnostics('PAPERCUSP-P305-FAIL phase=initial host-prepare-not-active')).toBeNull();
  });

  it('stages an enforced signed switch and a direct rollback as distinct operations', () => {
    const switchScript = buildP305SwitchScript(UPDATE_REFERENCE);
    expect(switchScript).toContain(`update_ref='${UPDATE_REFERENCE}'`);
    expect(switchScript).toContain('bootc switch --enforce-container-sigpolicy "$update_ref"');
    expect(switchScript).toContain('bootc status --json');

    const rollbackScript = buildP305RollbackScript();
    expect(rollbackScript).toContain('bootc rollback');
    expect(rollbackScript).not.toContain('bootc switch');
  });

  it('makes updated and rolled-back phases read the existing sentinel instead of recreating it', () => {
    for (const phase of ['updated', 'rolled-back'] as const) {
      const script = buildP305PhaseProbeScript({
        phase,
        expectedVersion: phase === 'updated' ? BASE.expectedUpdateVersion : BASE.expectedInitialVersion,
        updateImageReference: UPDATE_REFERENCE,
        sentinelToken: SENTINEL,
      });
      expect(script).toContain('test -f "$sentinel_path" || fail persisted-sentinel-missing');
      expect(script).not.toContain('sentinel-already-present');
    }
  });

  it('parses exactly one phase marker and rejects phase drift', () => {
    const line = `${P305_LIFECYCLE_MARKER} phase=updated release=0.0.18-r31 boot_id=12345678-1234-1234-1234-123456789abc sentinel_sha256=${SENTINEL} update_digest=${DIGEST}`;
    expect(parseP305PhaseMarker(`${line}\n`, 'updated')).toMatchObject({
      phase: 'updated',
      release: '0.0.18-r31',
      sentinel_sha256: SENTINEL,
      update_digest: DIGEST,
    });
    expect(() => parseP305PhaseMarker(`${line}\n`, 'rolled-back')).toThrow(/does not match/);
    expect(() => parseP305PhaseMarker(`${line}\n${line}\n`, 'updated')).toThrow(/exactly one/);
  });

  it('keeps import, switch, both reboot boundaries, rollback and teardown in one runner', () => {
    const source = readFileSync(RUNNER_SOURCE, 'utf8');
    const ordered = [
      'const controllerRegistry = await requireControllerRegistryReference(',
      'objectUploaded = true',
      "['storage', 'cp'",
      "['compute', 'images', 'create'",
      "phase: 'initial'",
      'buildP305SwitchScript',
      "transition: 'signed-switch'",
      "phase: 'updated'",
      'buildP305RollbackScript',
      "transition: 'direct-rollback'",
      "phase: 'rolled-back'",
      'session.close()',
      "['compute', 'images', 'delete'",
      "['storage', 'rm'",
    ];
    let cursor = -1;
    for (const token of ordered) {
      const next = source.indexOf(token, cursor + 1);
      expect(next, `missing or out-of-order runner token: ${token}`).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(source).toContain('residualResourceIds.length > 0');
    expect(source).toContain("method: 'HEAD'");
    expect(source).toContain("response.headers.get('docker-content-digest')");
    expect(source.indexOf('const controllerRegistry = await requireControllerRegistryReference(')).toBeLessThan(
      source.indexOf('objectUploaded = true'),
    );
    expect(source.indexOf('objectUploaded = true')).toBeLessThan(source.indexOf("['storage', 'cp'"));
    expect(source.indexOf('imageCreated = true')).toBeLessThan(
      source.indexOf("['compute', 'images', 'create'"),
    );
    expect(source).toContain('privateIngressOnly: session.publicIpv4Assigned === false');
    expect(source).toContain('const hostPrepareDiagnostics = parseP305HostPrepareDiagnostics(details.stderr)');
    expect(source).toContain('...(hostPrepareDiagnostics ? { hostPrepareDiagnostics } : {})');
  });
});
