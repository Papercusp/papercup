/**
 * papercusp-aws-ami-clean-account-canary (WI-10005604): input binding, the SSM command plan,
 * attestation extraction, and the launch → SSM → bootstrap → teardown → census flow driven
 * through injected fake cloud deps. The round trip through executeAwsAmiRelease's validator
 * lives in aws-ami-release.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ATTESTATION_PREFIX,
  BOOT_CONSOLE_POLL_EVERY,
  CANARY_RUN_DIR,
  CANARY_RUN_TAG,
  CANARY_BUDGETS,
  DIAGNOSTICS_MAX_CHARS,
  buildAwsAmiCanaryProof,
  canaryRoleArn,
  extractAttestation,
  instanceTypeFor,
  parseAwsAmiCanaryInput,
  runAwsAmiCleanAccountCanary,
  ssmScriptPlan,
  summarizeBootConsole,
  type AwsAmiCanaryDeps,
} from '../../bin/aws-ami-canary-measure.mjs';

const ACCOUNT = '111122223333';
const SCRIPT = '#!/usr/bin/env bash\nset -euo pipefail\necho bootstrap\n';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function rawInput(overrides: Record<string, unknown> = {}, fixtureOverrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    region: 'us-east-1',
    subnetId: 'subnet-0123456789abcdef0',
    instanceProfileArn: `arn:aws:iam::${ACCOUNT}:instance-profile/PapercuspCleanCanary`,
    imageId: 'ami-0123456789abcdef0',
    releaseVersion: '2026.10.2-1',
    releaseSha256: 'a'.repeat(64),
    buildManifestIdentity: 'sha256:manifest',
    fixture: {
      fixtureId: 'aws-ami-2026.10.2-1-ami-0123456789abcdef0',
      bootstrapScript: SCRIPT,
      bootstrapScriptSha256: sha(SCRIPT),
      manifestIdentity: 'sha256:manifest',
      image: { version: '2026.10.2-1' },
      bootstrapInput: { service: { name: 'papercusp-workspace-host.service' } },
      ...fixtureOverrides,
    },
    ...overrides,
  };
}

interface FakeOptions {
  servicePendingPolls?: number;
  serviceNeverTerminal?: boolean;
  account?: string;
  publicIp?: boolean;
  ssmNeverOnline?: boolean;
  serviceInactive?: boolean;
  attestation?: Record<string, unknown> | null;
  terminateThrows?: boolean;
  bootstrapNeverTerminal?: boolean;
  leftover?: string[];
  censusThrows?: boolean;
  bootstrapFails?: boolean;
  diagnosticsThrows?: boolean;
  /** Raw serial console the instance shows; a string that throws when it is an Error. */
  console?: string | Error;
  /** Whether the AMI's root snapshot is encrypted, as DescribeImages reports it. */
  rootEncrypted?: boolean;
}

/** The console of the P-012 chain14 release AMI (WI-10006518), ANSI colours and all. */
const EMERGENCY_CONSOLE = [
  '[    4.326786] XFS (nvme0n1p4): Mounting V5 Filesystem f89740d6-3de3-4d7b-8b14-bf50a59c559b\r',
  "[    4.430591] XFS (nvme0n1p4): Log inconsistent (didn't find previous header)\r",
  '[    4.431679] XFS (nvme0n1p4): empty log check failed\r',
  '[    4.433780] XFS (nvme0n1p4): log mount failed\r',
  '\x1b[0;1;31mFAILED\x1b[0m] Failed to mount sysroot.mount - /sysroot.\r',
  'You are in emergency mode. After logging in, type "journalctl -xb" to view\r',
].join('\n');

const JOURNAL_CAUSE = 'journal: Error: EACCES: permission denied, open /var/lib/papercusp/state.db';

function fakeDeps(options: FakeOptions = {}) {
  let clock = 0;
  let state = 'none';
  const calls: string[] = [];
  const sent: string[][] = [];
  const tagsSeen: string[] = [];
  const attestation = options.attestation === undefined ? { status: 'healthy', hostId: 'aws-clean-x' } : options.attestation;
  const deps: AwsAmiCanaryDeps = {
    runId: () => 'run0001',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    callerAccount: async () => options.account ?? ACCOUNT,
    describeImage: async () => ({
      state: 'available',
      architecture: 'x86_64',
      rootDeviceName: '/dev/xvda',
      ...(options.rootEncrypted === undefined ? {} : { rootEncrypted: options.rootEncrypted }),
    }),
    describeSubnet: async (subnetId) => ({ subnetId }),
    runInstance: async (input) => {
      calls.push(`run:${input.instanceType}`);
      // WI-10006110: the AMI-restored root volume is initialized at a fixed rate, not lazily.
      tagsSeen.push(`root-init:${input.rootDeviceName}@${input.volumeInitializationRateMiBps}`);
      tagsSeen.push(`root-encrypt:${input.encryptRootVolume === true}`);
      tagsSeen.push(...input.tags.map((tag) => `${tag.Key}=${tag.Value}`));
      state = 'pending';
      return 'i-0abc';
    },
    describeInstance: async () => {
      if (state === 'pending') {
        state = 'running';
        return { state: 'pending' };
      }
      return { state, publicIpv4: options.publicIp ? '3.3.3.3' : null };
    },
    ssmPingStatus: async () => (options.ssmNeverOnline ? 'ConnectionLost' : 'Online'),
    consoleOutput: async () => {
      calls.push('console');
      if (options.console instanceof Error) throw options.console;
      return options.console ?? '[  OK  ] Reached target multi-user.target\n';
    },
    sendCommand: async ({ commands }) => {
      if (commands.join('\n').includes('--- bootstrap ERROR lines ---')) {
        calls.push('diagnostics');
        if (options.diagnosticsThrows) throw new Error('SendCommand throttled');
      }
      sent.push([...commands]);
      return `cmd-${sent.length}`;
    },
    getInvocation: async ({ commandId }) => {
      const joined = sent[Number(commandId.slice(4)) - 1].join('\n');
      if (joined.includes('--- bootstrap ERROR lines ---')) {
        return { status: 'Success', stdout: `${JOURNAL_CAUSE}\n--- bootstrap ERROR lines ---\n9:ERROR: workspace service failed to start\n` };
      }
      if (options.bootstrapNeverTerminal && joined.includes('bootstrap.sh > ')) {
        return { status: 'InProgress', stdout: 'bootstrap is still running\n' };
      }
      if (options.bootstrapFails && joined.includes('bootstrap.sh > ')) {
        return { status: 'Failed', stdout: 'ADDON LOADED OK\nPAPERCUSP_CANARY_BOOTSTRAP_EXIT=1\n', responseCode: 1 };
      }
      if (joined.includes(`grep '^${ATTESTATION_PREFIX}'`)) {
        return {
          status: 'Success',
          stdout: attestation ? `${ATTESTATION_PREFIX}${Buffer.from(JSON.stringify(attestation)).toString('base64')}\n` : '',
        };
      }
      if (joined.includes('systemctl is-active')) {
        if (options.serviceNeverTerminal || (options.servicePendingPolls ?? 0) > 0) {
          if (options.servicePendingPolls) options.servicePendingPolls -= 1;
          return { status: 'Pending', statusDetails: 'Pending', responseCode: -1, executionStartedAt: null };
        }
        return options.serviceInactive ? { status: 'Failed', stdout: 'inactive\n' } : { status: 'Success', stdout: 'active\n' };
      }
      return { status: 'Success', stdout: '' };
    },
    terminate: async () => {
      calls.push('terminate');
      if (options.terminateThrows) throw new Error('TerminateInstances denied');
      state = 'terminated';
    },
    censusByRunTag: async (runId) => {
      calls.push(`census:${runId}`);
      if (options.censusThrows) throw new Error('DescribeVolumes throttled');
      return options.leftover ?? [];
    },
  };
  return { deps, calls, sent, tagsSeen };
}

describe('parseAwsAmiCanaryInput', () => {
  it('binds a well-formed payload and keeps the script exact', () => {
    const input = parseAwsAmiCanaryInput(rawInput());
    expect(input.fixture.bootstrapScript).toBe(SCRIPT);
    expect(input.fixture.serviceName).toBe('papercusp-workspace-host.service');
  });

  it.each([
    ['a script that does not hash to its digest', rawInput({}, { bootstrapScript: `${SCRIPT}# tampered\n` }), 'does not match'],
    ['an instance profile in another account', rawInput({ instanceProfileArn: 'arn:aws:iam::999999999999:instance-profile/X' }), 'clean account'],
    ['a fixture for a different manifest', rawInput({}, { manifestIdentity: 'sha256:other' }), 'manifestIdentity'],
    ['a fixture for a different release', rawInput({}, { image: { version: '1.0.0' } }), 'releaseVersion'],
    ['a shell-unsafe service name', rawInput({}, { bootstrapInput: { service: { name: 'x; rm -rf /' } } }), 'service.name'],
    ['a non-AMI image id', rawInput({ imageId: 'projects/p/global/images/x' }), 'imageId'],
    ['a missing fixture', rawInput({ fixture: undefined }), 'fixture is required'],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseAwsAmiCanaryInput(raw)).toThrow(message);
  });
});

describe('canary identity and sizing', () => {
  it('assumes OrganizationAccountAccessRole in the clean account by default, partition-aware', () => {
    expect(canaryRoleArn(ACCOUNT, 'us-east-1')).toBe(`arn:aws:iam::${ACCOUNT}:role/OrganizationAccountAccessRole`);
    expect(canaryRoleArn(ACCOUNT, 'us-gov-west-1', { PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME: 'Canary' })).toBe(
      `arn:aws-us-gov:iam::${ACCOUNT}:role/Canary`,
    );
  });

  it('refuses a role override outside the clean account', () => {
    expect(() =>
      canaryRoleArn(ACCOUNT, 'us-east-1', { PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN: 'arn:aws:iam::413781344298:role/Admin' }),
    ).toThrow('clean account');
  });

  it('sizes by AMI architecture and refuses an unknown one', () => {
    expect(instanceTypeFor('x86_64')).toBe('t3.medium');
    expect(instanceTypeFor('arm64')).toBe('t4g.medium');
    expect(() => instanceTypeFor('i386')).toThrow('architecture');
  });
});

describe('ssmScriptPlan', () => {
  it('ships the script as bounded base64 chunks that reassemble exactly and re-verify the digest on the host', () => {
    const big = `#!/usr/bin/env bash\n${'echo payload-line\n'.repeat(5000)}`;
    const fixture = { fixtureId: 'f', bootstrapScript: big, bootstrapScriptSha256: sha(big), serviceName: 'svc.service' };
    const plan = ssmScriptPlan(fixture, 10_000);
    expect(plan.uploads.length).toBeGreaterThan(1);
    const chunks = plan.uploads.map((commands) => /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(commands.at(-1)!)![1]);
    expect(chunks.every((chunk) => chunk.length <= 10_000)).toBe(true);
    expect(Buffer.from(chunks.join(''), 'base64').toString('utf8')).toBe(big);
    expect(plan.run.join('\n')).toContain(`${sha(big)}  /run/papercusp-ami-canary/bootstrap.sh' | sha256sum -c -`);
    expect(plan.serviceCheck).toEqual(['systemctl is-active svc.service']);
  });

  it('readDiagnostics extracts the status + journal section, not the addon inventory, and falls back to the log tail', () => {
    const fixture = { fixtureId: 'f', bootstrapScript: SCRIPT, bootstrapScriptSha256: sha(SCRIPT), serviceName: 'svc.service' };
    const plan = ssmScriptPlan(fixture);
    const dir = mkdtempSync(join(tmpdir(), 'aws-ami-canary-diag-'));
    try {
      const run = () =>
        spawnSync('bash', ['-c', plan.readDiagnostics.join('\n').replaceAll(CANARY_RUN_DIR, dir)], { encoding: 'utf8' });
      writeFileSync(
        join(dir, 'out.log'),
        [
          '[workspace-host-bootstrap] phase:configure-service',
          '[workspace-host-bootstrap] --- systemctl status svc.service ---',
          'Active: failed (Result: exit-code)',
          '[workspace-host-bootstrap] --- journalctl -u svc.service (service output) ---',
          JOURNAL_CAUSE,
          '[workspace-host-bootstrap] --- native addon inventory under /opt/papercusp/releases/x ---',
          'inventory-noise rocksdb-native.node',
          '[workspace-host-bootstrap] --- start samples: first, then last (every 10s during systemctl restart) ---',
          '=== start sample t+0s',
          'diskstats 259 0 nvme0n1 1200 0 96000 30000',
          '...',
          '=== start sample t+120s',
          '   2506 Dsl  folio_wait_bit_common      110 00:00:06 369168 node serve.mjs',
          '[workspace-host-bootstrap] --- recent logs under /var/lib/papercusp ---',
          '## /var/lib/papercusp/embedded-pg/postmaster.log',
          'LOG:  database system is ready to accept connections',
          '[workspace-host-bootstrap] --- SELinux denials this boot ---',
          'audit: avc:  denied { open } selinux-noise',
          '[workspace-host-bootstrap] ERROR: workspace service failed to start',
          '',
        ].join('\n'),
      );
      const out = run();
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('Active: failed (Result: exit-code)');
      expect(out.stdout).toContain(JOURNAL_CAUSE);
      expect(out.stdout).not.toContain('inventory-noise');
      // The start sampler's readings and recent state logs are printed after the addon
      // inventory, so they need their own extraction (WI-10006110).
      expect(out.stdout).toContain('=== start sample t+0s');
      expect(out.stdout).toContain('folio_wait_bit_common');
      expect(out.stdout).toContain('database system is ready to accept connections');
      expect(out.stdout).not.toContain('selinux-noise');
      expect(out.stdout).toContain('ERROR: workspace service failed to start');

      // A sampler section larger than its budget keeps its LAST readings.
      const manySamples = Array.from({ length: 400 }, (_, i) => `=== start sample t+${i * 10}s diskstats nvme0n1 ${i}`);
      writeFileSync(
        join(dir, 'out.log'),
        [
          '[workspace-host-bootstrap] --- systemctl status svc.service ---',
          'Active: failed (Result: exit-code)',
          '[workspace-host-bootstrap] --- native addon inventory under /opt/papercusp/releases/x ---',
          '[workspace-host-bootstrap] --- start samples: first, then last (every 10s during systemctl restart) ---',
          ...manySamples,
          '[workspace-host-bootstrap] --- recent logs under /var/lib/papercusp ---',
          '',
        ].join('\n'),
      );
      const bounded = run();
      expect(bounded.status).toBe(0);
      expect(bounded.stdout).toContain(manySamples.at(-1));
      expect(bounded.stdout).not.toContain(`${manySamples[0]}\n`);
      expect(bounded.stdout.length).toBeLessThanOrEqual(DIAGNOSTICS_MAX_CHARS + 2_000);

      // No diagnostics section (the bootstrap died earlier): the raw tail is returned instead.
      writeFileSync(join(dir, 'out.log'), 'phase:install-runtime\nmanifest fetch failed\n');
      const fallback = run();
      expect(fallback.status).toBe(0);
      expect(fallback.stdout).toContain('manifest fetch failed');
      expect(fallback.stdout.length).toBeLessThanOrEqual(DIAGNOSTICS_MAX_CHARS + 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractAttestation', () => {
  it('takes the LAST marker line and refuses a boot that never self-attested', () => {
    const encode = (value: unknown) => `${ATTESTATION_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64')}`;
    expect(extractAttestation(`${encode({ status: 'old' })}\nnoise\n${encode({ status: 'healthy' })}\n`)).toEqual({ status: 'healthy' });
    expect(() => extractAttestation('no marker here\n')).toThrow('did not self-attest');
  });
});

describe('summarizeBootConsole', () => {
  it('keeps the failure lines in console order, without ANSI colour or carriage returns', () => {
    const summary = summarizeBootConsole(EMERGENCY_CONSOLE);
    expect(summary.fatal).toBe(true);
    expect(summary.failureLines).toEqual([
      "[    4.430591] XFS (nvme0n1p4): Log inconsistent (didn't find previous header)",
      '[    4.431679] XFS (nvme0n1p4): empty log check failed',
      '[    4.433780] XFS (nvme0n1p4): log mount failed',
      'FAILED] Failed to mount sysroot.mount - /sysroot.',
      'You are in emergency mode. After logging in, type "journalctl -xb" to view',
    ]);
  });

  it('never calls a recovered filesystem warning or a healthy boot fatal', () => {
    expect(summarizeBootConsole('XFS (nvme0n1p4): Metadata corruption detected, repaired\n[  OK  ] Reached target multi-user.target')).toMatchObject({
      fatal: false,
    });
    expect(summarizeBootConsole('[  OK  ] Mounted sysroot.mount - /sysroot.\n')).toEqual({
      fatal: false,
      tail: '[  OK  ] Mounted sysroot.mount - /sysroot.\n',
      failureLines: [],
    });
    expect(summarizeBootConsole(null)).toEqual({ fatal: false, tail: '', failureLines: [] });
  });
});

describe('runAwsAmiCleanAccountCanary', () => {
  const input = parseAwsAmiCanaryInput(rawInput());

  it('proves SSM, bootstrap and service, then terminates and censuses zero residue', async () => {
    const { deps, calls, tagsSeen } = fakeDeps();
    const observed = await runAwsAmiCleanAccountCanary(input, deps);
    const proof = buildAwsAmiCanaryProof(input, observed, '2026-10-02T20:00:00.000Z');
    expect(proof).toMatchObject({
      accountId: ACCOUNT,
      imageId: input.imageId,
      fixtureId: input.fixture.fixtureId,
      ssmOnline: true,
      bootstrapAttestationHealthy: true,
      serviceHealthy: true,
      publicIpv4Assigned: false,
      terminated: true,
      residualResourceIds: [],
    });
    expect(proof.evidenceRef).toMatch(/^aws-ami-canary:i-0abc:[0-9a-f]{32}$/);
    expect(calls).toEqual(['run:t3.medium', 'terminate', 'census:run0001']);
    expect(tagsSeen).toContain(`${CANARY_RUN_TAG}=run0001`);
    expect(tagsSeen).toContain('root-init:/dev/xvda@300');
  });

  it('never launches when the assumed identity is not the clean account', async () => {
    const { deps, calls } = fakeDeps({ account: '413781344298' });
    await expect(runAwsAmiCleanAccountCanary(input, deps)).rejects.toThrow('not the clean account');
    expect(calls).toEqual([]);
  });

  it('accepts service-command delivery after the old execution-only wait but within AWS total timeout', async () => {
    const oldWaitMs = CANARY_BUDGETS.shortCommandMs + 2 * CANARY_BUDGETS.pollMs;
    const pendingPolls = Math.ceil(oldWaitMs / CANARY_BUDGETS.pollMs) + 2;
    const { deps, calls } = fakeDeps({ servicePendingPolls: pendingPolls });
    const observed = await runAwsAmiCleanAccountCanary(input, deps);
    expect(observed.serviceHealthy).toBe(true);
    expect(observed.terminated).toBe(true);
    expect(calls.slice(-2)).toEqual(['terminate', 'census:run0001']);
  });

  it('keeps the exact command identity and delivery state when total wait expires, then tears down', async () => {
    const { deps, calls, sent } = fakeDeps({ serviceNeverTerminal: true });
    const error = await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e) as Error & { details: Record<string, unknown> };
    expect(error.message).toContain('SSM service check did not happen within 800s');
    expect(error.details).toMatchObject({
      commandId: `cmd-${sent.length}`, phase: 'service check',
      deliveryBudgetMs: CANARY_BUDGETS.ssmDeliveryMs, executionBudgetMs: CANARY_BUDGETS.shortCommandMs,
      last: { status: 'Pending', responseCode: -1, executionStartedAt: null },
      terminated: true, residualResourceIds: [],
    });
    expect(calls.slice(-2)).toEqual(['terminate', 'census:run0001']);
  });

  it.each([
    ['SSM never comes Online', { ssmNeverOnline: true }, 'SSM agent Online'],
    ['a public IPv4 is assigned', { publicIp: true }, 'public IPv4'],
    ['the boot never self-attests', { attestation: null }, 'did not self-attest'],
  ])('tears down and censuses when %s', async (_label, options: FakeOptions, message) => {
    const { deps, calls } = fakeDeps(options);
    const error = await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e as Error & { details?: Record<string, unknown> });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect(calls.slice(-2)).toEqual(['terminate', 'census:run0001']);
    expect((error as { details?: Record<string, unknown> }).details).toMatchObject({ terminated: true, residualResourceIds: [] });
  });

  it('reports an un-terminated instance and leftovers as residue instead of a clean run', async () => {
    const stuck = await runAwsAmiCleanAccountCanary(input, fakeDeps({ terminateThrows: true, leftover: ['vol-0leak'] }).deps);
    expect(stuck.terminated).toBe(false);
    expect(stuck.residualResourceIds).toEqual(['i-0abc', 'vol-0leak']);
    expect(stuck.teardownErrors.join(' ')).toContain('TerminateInstances denied');
  });

  it('never reads an unmeasured census as zero residue', async () => {
    const observed = await runAwsAmiCleanAccountCanary(input, fakeDeps({ censusThrows: true }).deps);
    expect(observed.residualResourceIds).toEqual(['census-unmeasured:run0001']);
  });

  it('reads the service diagnostics off the instance BEFORE teardown when bootstrap fails, and carries them last', async () => {
    const { deps, calls } = fakeDeps({ bootstrapFails: true });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & { details: Record<string, unknown> };
    expect(error.message).toContain('SSM bootstrap ended Failed');
    expect(calls.slice(-3)).toEqual(['diagnostics', 'terminate', 'census:run0001']);
    expect(error.details.bootstrapDiagnostics).toContain(JOURNAL_CAUSE);
    // Callers keep the TAIL of the serialized payload, so the cause must be the last key.
    expect(Object.keys(error.details).at(-1)).toBe('bootstrapDiagnostics');
  });

  it('never lets an unreadable diagnostic mask the bootstrap failure, and reads none on success', async () => {
    const { deps, calls } = fakeDeps({ bootstrapFails: true, diagnosticsThrows: true });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & { details: Record<string, unknown> };
    expect(error.message).toContain('SSM bootstrap ended Failed');
    expect(String(error.details.bootstrapDiagnostics)).toMatch(/^diagnostics unreadable: SendCommand throttled/);
    expect(calls.slice(-2)).toEqual(['terminate', 'census:run0001']);

    const healthy = fakeDeps();
    await runAwsAmiCleanAccountCanary(input, healthy.deps);
    expect(healthy.calls).not.toContain('diagnostics');
  });

  it('reads partial diagnostics before teardown when the bootstrap invocation never becomes terminal', async () => {
    const { deps, calls } = fakeDeps({ bootstrapNeverTerminal: true });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & {
      details: Record<string, unknown>;
    };
    expect(error.message).toContain('SSM bootstrap did not happen within');
    expect(calls.slice(-3)).toEqual(['diagnostics', 'terminate', 'census:run0001']);
    expect(error.details.bootstrapDiagnostics).toContain(JOURNAL_CAUSE);
    expect(Object.keys(error.details).at(-1)).toBe('bootstrapDiagnostics');
  });

  it('ends the SSM wait within a minute when the boot console shows a failed root mount, and names the cause (WI-10006518)', async () => {
    const { deps, calls } = fakeDeps({ ssmNeverOnline: true, console: EMERGENCY_CONSOLE });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & {
      details: Record<string, unknown> & { bootConsole: { failureLines: string[] } };
    };
    expect(error.message).toContain('canary instance i-0abc failed to boot');
    expect(error.message).toContain("XFS (nvme0n1p4): Log inconsistent (didn't find previous header)");
    expect(error.message).toContain('Failed to mount sysroot.mount');
    // One console read per BOOT_CONSOLE_POLL_EVERY pings, not the 900 s SSM budget.
    expect(deps.now()).toBeLessThanOrEqual(BOOT_CONSOLE_POLL_EVERY * 10_000);
    expect(calls).toEqual(['run:t3.medium', 'console', 'terminate', 'census:run0001']);
    expect(error.details).toMatchObject({ terminated: true, residualResourceIds: [] });
    expect(Object.keys(error.details).at(-1)).toBe('bootConsole');
    expect(error.details.bootConsole.failureLines.join('\n')).not.toMatch(/\x1b|\r/);
  });

  it.each([
    ['an unencrypted clean-room AMI gets an encrypted root, the read path every customer launch takes', false, 'root-encrypt:true'],
    ['an already-encrypted release AMI launches exactly as a customer launches it', true, 'root-encrypt:false'],
    ['an AMI whose root encryption is unknown is launched unchanged', undefined, 'root-encrypt:false'],
  ])('WI-10006518: %s', async (_label, rootEncrypted, expected) => {
    const { deps, tagsSeen } = fakeDeps({ rootEncrypted });
    await runAwsAmiCleanAccountCanary(input, deps);
    expect(tagsSeen).toContain(expected);
  });

  it('carries the console tail on a plain SSM timeout without inventing a boot failure', async () => {
    const { deps, calls } = fakeDeps({ ssmNeverOnline: true });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & {
      details: { bootConsole: { fatal: boolean; tail: string; failureLines: string[] } };
    };
    expect(error.message).toMatch(/^SSM agent Online did not happen within 900s$/);
    expect(error.details.bootConsole).toMatchObject({ fatal: false, failureLines: [] });
    expect(error.details.bootConsole.tail).toContain('multi-user.target');
    expect(calls.slice(-2)).toEqual(['terminate', 'census:run0001']);
  });

  it('never lets an unreadable console mask the failure it accompanies', async () => {
    const { deps } = fakeDeps({ ssmNeverOnline: true, console: new Error('GetConsoleOutput throttled') });
    const error = (await runAwsAmiCleanAccountCanary(input, deps).catch((e: unknown) => e)) as Error & {
      details: { bootConsole: { note?: string } };
    };
    expect(error.message).toContain('SSM agent Online did not happen');
    expect(error.details.bootConsole.note).toMatch(/^console unreadable: GetConsoleOutput throttled/);
  });

  it('reports an unhealthy attestation and an inactive service as observed, not as success', async () => {
    const observed = await runAwsAmiCleanAccountCanary(
      input,
      fakeDeps({ attestation: { status: 'degraded' }, serviceInactive: true }).deps,
    );
    const proof = buildAwsAmiCanaryProof(input, observed, '2026-10-02T20:00:00.000Z');
    expect(proof.bootstrapAttestationHealthy).toBe(false);
    expect(proof.serviceHealthy).toBe(false);
  });
});
