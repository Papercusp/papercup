import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WorkspaceHostCredentialMaterial,
  buildWorkspaceHostCredentialReference,
  parseWorkspaceHostCredentialDeliveryRequest,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import {
  GcpIapWorkspaceHostCredentialDeliveryError,
  buildGcpIapWorkspaceHostCredentialDeliveryCommand,
  deliverGcpIapWorkspaceHostCredentialMaterial,
  parseGcpIapWorkspaceHostCredentialDeliveryReceipt,
  type GcpIapWorkspaceHostCredentialDeliveryProfile,
} from './gcp-iap-credential-delivery';
import type {
  GcpIapWorkspaceHostInitializationCommand,
  GcpIapWorkspaceHostInitializationCommandRunner,
} from './gcp-iap-initialization-operations';

const GIT_REF = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
  forge: 'github',
  owner: 'papercupai',
  repository: 'private-canary',
});

/** Token-shaped, so every "not in argv" assertion below has something real to miss. */
const SECRET = 'https://git-user:private-token-value@github.com';

const PROFILE: GcpIapWorkspaceHostCredentialDeliveryProfile = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  instanceName: 'p046-canary-03',
  sshUser: 'papercusp',
  knownHostsFile: '/var/lib/papercusp/known_hosts',
  deliveryEntrypoint: '/opt/papercusp/bin/papercusp-deliver-material',
};

function input() {
  return {
    channel: 'git' as const,
    credentialRef: GIT_REF,
    generation: 7,
    material: new WorkspaceHostCredentialMaterial(Buffer.from(SECRET, 'utf8')),
  };
}

class StubRunner implements GcpIapWorkspaceHostInitializationCommandRunner {
  readonly commands: GcpIapWorkspaceHostInitializationCommand[] = [];
  constructor(
    private readonly result: { exitCode: number; stdout: string; stderr: string },
  ) {}
  async run(command: GcpIapWorkspaceHostInitializationCommand) {
    this.commands.push(command);
    return this.result;
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    family: 'git-short-lived-delegation',
    generation: 7,
    present: true,
    observedAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  });
}

describe('GCP IAP credential delivery — material never reaches argv', () => {
  /**
   * `/proc/<pid>/cmdline` is world-readable, so an argument is visible to every local process for
   * the lifetime of the command. This is the assertion that matters most in this file.
   */
  it('keeps the material out of the command line entirely', () => {
    const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(PROFILE, input());
    const rendered = [command.command, ...command.args].join(' ');

    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain('private-token-value');
    expect(rendered).not.toContain(Buffer.from(SECRET, 'utf8').toString('base64'));

    // Calibration: the material really is being sent, so the absences above are a property of the
    // command shape rather than of a builder that dropped it.
    expect(command.stdin).toContain(Buffer.from(SECRET, 'utf8').toString('base64'));
  });

  it('sends a fixed remote argv with no caller input spliced into it', () => {
    const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(PROFILE, input());
    const remote = command.args[command.args.length - 1] as string;

    expect(remote).toContain('papercusp-deliver-material');
    expect(remote).toContain(WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION);
    expect(remote).toContain('--json-stdin');
    expect(remote).not.toContain(GIT_REF);
  });

  it('produces stdin the HOST parser accepts, end to end', () => {
    const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(PROFILE, input());
    // The real host-side parser, not a re-implementation — this is what proves the two ends agree.
    const parsed = parseWorkspaceHostCredentialDeliveryRequest(JSON.parse(command.stdin));

    expect(parsed.family).toBe('git-short-lived-delegation');
    expect(parsed.generation).toBe(7);
    expect(parsed.material.reveal().toString('utf8')).toBe(SECRET);
  });

  /**
   * The hardened options live in the SHARED transport builder. If someone gives delivery its own
   * SSH construction, these drift silently and delivery becomes the weaker path.
   */
  it('inherits the hardened SSH options from the shared transport', () => {
    const command = buildGcpIapWorkspaceHostCredentialDeliveryCommand(PROFILE, input());
    const args = command.args.join(' ');

    expect(args).toContain('IdentitiesOnly=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('ClearAllForwardings=yes');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('HostKeyAlias=gcp-iap-');
  });

  it('refuses a relative delivery entrypoint', () => {
    expect(() =>
      buildGcpIapWorkspaceHostCredentialDeliveryCommand(
        { ...PROFILE, deliveryEntrypoint: 'papercusp-deliver-material' },
        input(),
      ),
    ).toThrow(/absolute/);
  });
});

describe('GCP IAP credential delivery — the receipt', () => {
  it('accepts a well-formed receipt', () => {
    expect(parseGcpIapWorkspaceHostCredentialDeliveryReceipt(receipt())).toEqual({
      protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
      family: 'git-short-lived-delegation',
      generation: 7,
      present: true,
      observedAt: '2026-08-31T10:00:00.000Z',
    });
  });

  /**
   * D-215 point 3 enforced at the CONTROLLER: even if a host grew a bytes-derived field, it must
   * not reach anything durable. Built from named fields, so extras are dropped by construction.
   */
  it('drops any extra field a host tries to add to the receipt', () => {
    const parsed = parseGcpIapWorkspaceHostCredentialDeliveryReceipt(
      receipt({ materialDigest: 'deadbeef', sizeBytes: 46 }),
    );
    expect(Object.keys(parsed).sort()).toEqual([
      'family',
      'generation',
      'observedAt',
      'present',
      'protocolVersion',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('deadbeef');
  });

  it('refuses a foreign protocol version', () => {
    expect(() =>
      parseGcpIapWorkspaceHostCredentialDeliveryReceipt(
        receipt({ protocolVersion: 'papercusp-gcp-iap-initialization-v2' }),
      ),
    ).toThrow(/the controller speaks/);
  });

  it('refuses a receipt that does not report the material present', () => {
    expect(() =>
      parseGcpIapWorkspaceHostCredentialDeliveryReceipt(receipt({ present: false })),
    ).toThrow(/did not report the material as present/);
  });

  it('refuses a malformed response', () => {
    expect(() => parseGcpIapWorkspaceHostCredentialDeliveryReceipt('not json')).toThrow(
      /malformed response/,
    );
  });
});

describe('GCP IAP credential delivery — running it', () => {
  it('returns the receipt on success', async () => {
    const runner = new StubRunner({ exitCode: 0, stdout: receipt(), stderr: '' });
    const result = await deliverGcpIapWorkspaceHostCredentialMaterial(PROFILE, input(), runner);

    expect(result.present).toBe(true);
    expect(runner.commands).toHaveLength(1);
  });

  it('reports a failure with the host diagnostic, and never the material', async () => {
    const runner = new StubRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'WorkspaceHostRevokedCredentialGenerationError: generations through 7 have been revoked',
    });

    const error = await deliverGcpIapWorkspaceHostCredentialMaterial(
      PROFILE,
      input(),
      runner,
    ).catch((caught: unknown) => caught as Error);

    expect(error.message).toMatch(/have been revoked/);
    // The diagnostic is the host's stderr, which the delivery CLI writes as `name: message` and
    // never as the request — so the secret must not appear anywhere in the surfaced failure.
    expect(error.message).not.toContain('private-token-value');
  });

  it('surfaces the exit code on the typed error', async () => {
    const runner = new StubRunner({ exitCode: 255, stdout: '', stderr: 'ssh: connect failed' });
    await expect(
      deliverGcpIapWorkspaceHostCredentialMaterial(PROFILE, input(), runner),
    ).rejects.toMatchObject({
      name: 'GcpIapWorkspaceHostCredentialDeliveryError',
      exitCode: 255,
    });
  });
});
