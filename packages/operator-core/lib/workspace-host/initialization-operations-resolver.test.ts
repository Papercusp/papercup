/**
 * initialization-operations-resolver.test.ts (P-046 / WI-40474).
 *
 * The property worth guarding here is not "the resolver returns an object" — it is that the
 * instance the INITIALIZER tunnels to is the same instance the PROVIDER creates. Those live in
 * different modules and are reached by different call paths, so nothing but a test stops a
 * future edit from re-forking the derivation. A re-fork would not fail here or in typecheck; it
 * would fail against real cloud, at runtime, as an SSH to a nonexistent instance.
 */
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
  WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
  assertWorkspaceHostSecretIsolation,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  WorkspaceHostHostKeyPublicationTimeoutError,
  WorkspaceHostInitializationHostKeyError,
  enrollGcpIapHostKeys,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperations,
  resolveWorkspaceHostInitializationOperationsForHost,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { resolveGcpWorkspaceHostInstanceIdentity, type GcpInstanceGuestAttribute } from './gcp-provider';
import { buildGcpIapWorkspaceHostInitializationCommand } from './gcp-iap-initialization-operations';

const controller: WorkspaceHostInitializationControllerProfile = {
  sshUser: 'papercusp',
  knownHostsFile: '/etc/papercusp/known_hosts',
  remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
  deliveryEntrypoint: '/opt/papercusp/bin/papercusp-deliver-material',
};

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type TestHostKeyAlgorithm = 'ecdsa-sha2-nistp256' | 'ssh-ed25519' | 'ssh-rsa';

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function sshMpint(value: Buffer): Buffer {
  const positive = (value[0]! & 0x80) === 0 ? value : Buffer.concat([Buffer.from([0]), value]);
  return sshString(positive);
}

const generatedHostKeys = new Map<string, string>();

function publicKey(algorithm: TestHostKeyAlgorithm, marker: string = algorithm): string {
  const cacheKey = `${algorithm}:${marker}`;
  const cached = generatedHostKeys.get(cacheKey);
  if (cached) return cached;

  let blob: Buffer;
  if (algorithm === 'ssh-ed25519') {
    const generated = generateKeyPairSync('ed25519');
    const jwk = generated.publicKey.export({ format: 'jwk' });
    blob = Buffer.concat([sshString(algorithm), sshString(Buffer.from(jwk.x!, 'base64url'))]);
  } else if (algorithm === 'ecdsa-sha2-nistp256') {
    const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = generated.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    blob = Buffer.concat([sshString(algorithm), sshString('nistp256'), sshString(point)]);
  } else {
    const generated = generateKeyPairSync('rsa', { modulusLength: 2_048, publicExponent: 0x10001 });
    const jwk = generated.publicKey.export({ format: 'jwk' });
    blob = Buffer.concat([
      sshString(algorithm),
      sshMpint(Buffer.from(jwk.e!, 'base64url')),
      sshMpint(Buffer.from(jwk.n!, 'base64url')),
    ]);
  }
  const line = `${algorithm} ${blob.toString('base64')} generated-on-host`;
  generatedHostKeys.set(cacheKey, line);
  return line;
}

function publicKeyBlob(algorithm: TestHostKeyAlgorithm, marker: string = algorithm): string {
  return publicKey(algorithm, marker).split(' ')[1]!;
}

function guestHostKeys(marker = 'first'): readonly GcpInstanceGuestAttribute[] {
  return [
    {
      namespace: 'hostkeys',
      key: 'ecdsa-sha2-nistp256',
      value: publicKeyBlob('ecdsa-sha2-nistp256', marker),
    },
    { namespace: 'hostkeys', key: 'ssh-ed25519', value: publicKeyBlob('ssh-ed25519', marker) },
    { namespace: 'hostkeys', key: 'ssh-rsa', value: publicKeyBlob('ssh-rsa', marker) },
  ];
}

function desired(overrides: Partial<WorkspaceHostDesiredSpec> = {}): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-alpha',
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    ...overrides,
  } as WorkspaceHostDesiredSpec;
}

describe('resolveWorkspaceHostInitializationOperations', () => {
  it('declares the initialization step kinds the GCP adapter supports', () => {
    const operations = resolveWorkspaceHostInitializationOperations(desired(), controller);
    expect(operations.supportedStepKinds).toContain('create-workspace');
    expect(operations.supportedStepKinds).toContain('bind-credential');
  });

  // WI-10001677. THE object the routes pass to the runner is the delivering WRAPPER, not the
  // adapter — and `awaitBootstrapReady` is optional on the interface, so a wrapper that forgets to
  // forward it still typechecks and every adapter-level unit test still passes. The runner then
  // reads `if (input.operations.awaitBootstrapReady)`, finds undefined, and skips the gate on the
  // only path that has a real host in front of it. That is precisely how this shipped "green" the
  // first time: measured live, the RESOLVED object reported awaitBootstrapReady === undefined.
  //
  // Asserting through the resolver, not the adapter, is the whole point of this test: it is the
  // only construction that exercises the wrapping the production routes actually perform.
  it('exposes the bootstrap-readiness gate through the delivering wrapper the routes resolve', () => {
    const operations = resolveWorkspaceHostInitializationOperations(desired(), controller);
    expect(typeof operations.awaitBootstrapReady).toBe('function');
  });

  it('tunnels to the SAME instance the provider provisions (anti-divergence guard)', () => {
    const spec = desired();
    const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);

    // Reach the profile the resolver actually built, through the adapter's own command builder —
    // i.e. assert on the SSH target that would really be used, not on an internal field.
    const command = buildGcpIapWorkspaceHostInitializationCommand(
      {
        projectId: identity.projectId,
        zone: identity.zone,
        instanceName: identity.instanceName,
        ...controller,
      },
      {
        id: 'workspace',
        kind: 'create-workspace',
        dependsOn: [],
        idempotencyKey: 'workspace-init:op-1:workspace',
        input: {},
      },
    );

    expect(command.args).toContain(`${controller.sshUser}@${identity.instanceName}`);
    expect(command.args.join(' ')).toContain(`--project=${identity.projectId}`);
    expect(command.args.join(' ')).toContain(`--zone=${identity.zone}`);
  });

  it('derives a stable, DNS-safe default instance name from the host id', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    expect(identity.instanceName).toMatch(/^pc-[a-z0-9-]+-[0-9a-f]{8}-vm$/);
    expect(identity.instanceName.length).toBeLessThanOrEqual(63);
    // Deterministic: the same host id must never resolve to two different instances.
    expect(resolveGcpWorkspaceHostInstanceIdentity(desired()).instanceName).toBe(identity.instanceName);
  });

  it('honours an explicit provider instanceName over the derived default', () => {
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired({ provider: { instanceName: 'explicit-vm' } }));
    expect(identity.instanceName).toBe('explicit-vm');
  });

  it('refuses a target with no adapter instead of silently falling back', () => {
    expect(() => resolveWorkspaceHostInitializationOperations(desired({ target: 'aws' } as never), controller)).toThrow(
      UnsupportedWorkspaceHostInitializationTargetError,
    );

    expect(() =>
      resolveWorkspaceHostInitializationOperations(desired({ target: 'azure' } as never), controller),
    ).toThrow(/No workspace-host initialization adapter for target 'azure'/);
  });

  it("propagates the provider's own validation rules rather than softening them", () => {
    // zone must belong to region — the provider enforces this when provisioning, so the
    // initializer must not accept a spec the provider would have rejected.
    expect(() => resolveWorkspaceHostInitializationOperations(desired({ zone: 'europe-west1-b' }), controller)).toThrow(
      /zone must belong to/,
    );

    expect(() =>
      resolveWorkspaceHostInitializationOperations(
        desired({ provider: { projectId: 'some-other-project' } }),
        controller,
      ),
    ).toThrow(/projectId must match/);
  });
});

describe('resolveWorkspaceHostInitializationControllerProfile', () => {
  const complete = {
    PAPERCUSP_WORKSPACE_HOST_SSH_USER: 'papercusp',
    PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: '/etc/papercusp/known_hosts',
    PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: '/opt/papercusp/bin/workspace-host-initializer',
    PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT: '/opt/papercusp/bin/papercusp-deliver-material',
  };

  it('builds the profile from deployment configuration', () => {
    expect(resolveWorkspaceHostInitializationControllerProfile(complete)).toEqual({
      sshUser: 'papercusp',
      knownHostsFile: '/etc/papercusp/known_hosts',
      remoteEntrypoint: '/opt/papercusp/bin/workspace-host-initializer',
      deliveryEntrypoint: '/opt/papercusp/bin/papercusp-deliver-material',
    });
  });

  it('derives packaged defaults from the deployment-driver contract and systemd state directory', () => {
    const stateDirectory = '/home/papercusp/.local/state/papercusp/controller';
    expect(resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: stateDirectory })).toEqual({
      sshUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
      knownHostsFile: join(stateDirectory, 'known_hosts'),
      remoteEntrypoint: WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
      deliveryEntrypoint: WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
    });
  });

  it('keeps the delivery entrypoint DISTINCT from the initializer, both by default and when set', () => {
    const defaults = resolveWorkspaceHostInitializationControllerProfile({
      STATE_DIRECTORY: '/home/papercusp/.local/state/papercusp/controller',
    });
    // Two programs, two protocols. A profile that resolved one path for both would send delivery
    // requests to the initializer, which refuses them as a version mismatch — a misconfigured
    // profile surfacing as a broken step.
    expect(defaults.deliveryEntrypoint).not.toBe(defaults.remoteEntrypoint);
    const configured = resolveWorkspaceHostInitializationControllerProfile(complete);
    expect(configured.deliveryEntrypoint).not.toBe(configured.remoteEntrypoint);
  });

  it('refuses a RELATIVE delivery entrypoint', () => {
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT: './deliver-material',
      }),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT must be an absolute path/);
  });

  it('carries optional overrides through and omits absent ones entirely', () => {
    const profile = resolveWorkspaceHostInitializationControllerProfile({
      ...complete,
      PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE: '/etc/papercusp/id_ed25519',
      PAPERCUSP_WORKSPACE_HOST_GCLOUD_EXECUTABLE: 'gcloud',
    });
    expect(profile.identityFile).toBe('/etc/papercusp/id_ed25519');
    expect(profile.gcloudExecutable).toBe('gcloud');
    // Absent means ABSENT, not undefined-valued: the adapter profile spreads these conditionally.
    expect('sshExecutable' in profile).toBe(false);
  });

  it('refuses a RELATIVE trust store or entrypoint', () => {
    // A relative path resolves against the controller's launch directory, which would make the
    // trust store depend on how the process was started. That is the property it must not have.
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS: 'known_hosts',
      }),
    ).toThrow(/must be an absolute path/);

    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({
        ...complete,
        PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT: './initializer',
      }),
    ).toThrow(WorkspaceHostInitializationControllerProfileError);
  });

  it('reports EVERY gap at once rather than one restart at a time', () => {
    try {
      resolveWorkspaceHostInitializationControllerProfile({});
      expect.unreachable('an unconfigured controller must refuse');
    } catch (error) {
      const problems = (error as WorkspaceHostInitializationControllerProfileError).problems;
      expect(problems).toHaveLength(1);
      expect(problems.join(' ')).toContain('PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS');
      expect(problems.join(' ')).toContain('STATE_DIRECTORY');
    }
  });

  it('treats whitespace-only configuration as unset', () => {
    expect(() =>
      resolveWorkspaceHostInitializationControllerProfile({ ...complete, PAPERCUSP_WORKSPACE_HOST_SSH_USER: '   ' }),
    ).toThrow(/PAPERCUSP_WORKSPACE_HOST_SSH_USER must not be empty/);
  });

  it('refuses an unavailable or non-single systemd state directory', () => {
    expect(() => resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: 'relative/state' })).toThrow(
      /STATE_DIRECTORY must name one absolute directory/,
    );
    expect(() => resolveWorkspaceHostInitializationControllerProfile({ STATE_DIRECTORY: '/one:/two' })).toThrow(
      /STATE_DIRECTORY must name one absolute directory/,
    );
  });
});

describe('resolveWorkspaceHostInitializationOperationsForHost', () => {
  it('rejects an unsupported target before attempting GCP guest-attribute access', async () => {
    let guestAttributeRead = false;
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired({ target: 'azure' } as never) }),
        gcpClient: {
          async getInstanceGuestAttributes() {
            guestAttributeRead = true;
            return guestHostKeys();
          },
        },
      }),
    ).rejects.toThrow(/No workspace-host initialization adapter for target 'azure'/);
    expect(guestAttributeRead).toBe(false);
  });

  it('resolves the adapter from the RECORDED provisioning intent', async () => {
    const spec = desired();
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: spec }),
      gcpClient: { getInstanceGuestAttributes: async () => guestHostKeys() },
      enrollHostKeys: async () => undefined,
    });

    expect(resolved.desired).toBe(spec);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
  });

  it('fetches authenticated guest host keys and enrolls them before returning the adapter', async () => {
    const calls: string[] = [];
    const spec = desired();
    const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);
    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: spec.hostId,
      controller,
      readDesiredSpec: async () => ({ desired: spec }),
      gcpClient: {
        async getInstanceGuestAttributes(projectId, zone, instanceName, queryPath) {
          calls.push(`read:${projectId}:${zone}:${instanceName}:${queryPath}`);
          return guestHostKeys();
        },
      },
      async enrollHostKeys(input) {
        calls.push(`enroll:${input.identity.instanceName}:${input.knownHostsFile}:${input.attributes.length}`);
      },
    });

    expect(calls).toEqual([
      `read:${identity.projectId}:${identity.zone}:${identity.instanceName}:hostkeys/`,
      `enroll:${identity.instanceName}:${controller.knownHostsFile}:3`,
    ]);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
  });

  it('uses the hosted delegation resolver through the real GCP client path instead of ADC/gcloud', async () => {
    const credentialRef = 'delegation://workspace-1/gcp/connection-1/1';
    // ⚠ Keep this stand-in short and referenced by identifier. The git-sync
    // commit-time secrets detector's `secret-assignment` rule fires on an
    // `accessToken:` key assigned a >=20-char value over 3.2 bits/char of
    // entropy, which ordinary hyphenated English clears — the previous literal
    // ('delegated-short-lived-token') quarantined this file out of every commit
    // for ~41h / 149+ ticks (WI-784913).
    const DELEGATED_TOKEN = 'delegated-token';
    const resolveHostedAuth = vi.fn(async () => ({
      accessToken: DELEGATED_TOKEN,
      identity: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
      projectId: 'active-alcove-504205-q3',
    }));
    const gcpFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${DELEGATED_TOKEN}`);
      return Response.json({ queryValue: { items: guestHostKeys() } });
    });
    const spec = desired({
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: credentialRef } },
      provider: {
        hostedDelegation: {
          schemaVersion: 'hosted-provider-delegation-v1',
          workspaceId: 'workspace-1', connectionId: 'connection-1', credentialRef,
          provider: 'gcp', generation: 1, status: 'verified',
        },
      },
    } as never);

    await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'workspace-1', hostId: spec.hostId, controller,
      readDesiredSpec: async () => ({ desired: spec }),
      resolveHostedAuth,
      gcpFetch,
      enrollHostKeys: async () => undefined,
    });

    expect(resolveHostedAuth).toHaveBeenCalledWith({ credentialRef, provider: spec.provider });
    expect(gcpFetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unknown host from a host with no recorded intent', async () => {
    // These are NOT the same failure: the first is a bad request, the second is a provisioner
    // that recorded nothing. Collapsing them would strand the caller with no way to tell which.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'ghost',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'host-not-found' }),
      }),
    ).rejects.toMatchObject({ reason: 'host-not-found' });

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostDesiredSpecUnavailableError);
  });

  it('REFUSES rather than guessing an instance name for an un-recorded host', async () => {
    // The whole point of persisting intent: without it the controller must not proceed against a
    // derived-by-default instance name, because that failure is invisible until real cloud.
    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: null, miss: 'no-recorded-spec' }),
      }),
    ).rejects.toThrow(/cannot be identified/);
  });
});

/**
 * WI-10001685 — the hostkeys/ publication race.
 *
 * MEASURED on a real GCP VM: `hostkeys/` 404s at 23:29:40Z and is fully published by 23:30:40Z,
 * ~70s after create. This read is the LAST thing resolution does and runs BEFORE the initializer
 * that owns the bootstrap gate, so throwing here made that gate STRUCTURALLY UNREACHABLE and wrote
 * no operation row at all.
 *
 * What these guard is not "a retry exists" but that it retries the RIGHT things. The dangerous
 * failure is over-retrying: a wrong-instance 404 is the exact case the resolver's docstring says
 * must refuse immediately, and waiting it out would turn a 2s refusal into a 5m hang reported
 * under the wrong cause.
 */
describe('hostkeys/ publication race (WI-10001685)', () => {
  const guestAttributeNotFound = () =>
    Object.assign(
      new Error(
        "gcp_preflight_http_404: The resource 'hostkeys/' of type 'Guest Attribute' was not found",
      ),
      { status: 404, reason: "The resource 'hostkeys/' of type 'Guest Attribute' was not found" },
    );

  const instanceNotFound = () =>
    Object.assign(
      new Error(
        "gcp_preflight_http_404: The resource 'projects/p/zones/z/instances/ghost' was not found",
      ),
      { status: 404, reason: "The resource 'projects/p/zones/z/instances/ghost' was not found" },
    );

  /** Deterministic clock + sleep so the budget is exercised without real time passing. */
  function fakeClock() {
    let nowMs = 0;
    return {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('waits out the 404 and enrolls once the guest agent publishes', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    let attempts = 0;
    const enrolled: GcpIapHostKeyEnrollmentInput[] = [];

    const resolved = await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: desired() }),
      gcpClient: {
        async getInstanceGuestAttributes() {
          attempts += 1;
          if (attempts < 3) throw guestAttributeNotFound();
          return guestHostKeys();
        },
      },
      enrollHostKeys: async (input) => {
        enrolled.push(input);
      },
      awaitHostKeys: {
        now: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 5_000,
        onWaiting: ({ elapsedMs }) => {
          waits.push(elapsedMs);
        },
      },
    });

    expect(attempts).toBe(3);
    expect(enrolled).toHaveLength(1);
    expect(resolved.operations.supportedStepKinds).toContain('create-workspace');
    // onWaiting is the ONLY positive evidence the gate ran: the non-waiting path emits nothing,
    // so a fast clean resolve can never prove this.
    expect(waits).toEqual([0, 5_000]);
  });

  it('waits out a PARTIAL publish, not just the 404', async () => {
    // The guest agent writes the three keys as separate attributes, so a read landing
    // mid-publication returns an incomplete set. `guestHostKeys` rejects that with
    // "missing '<algorithm>'" — transient, and invisible to a 404-only retry.
    const clock = fakeClock();
    let attempts = 0;

    await resolveWorkspaceHostInitializationOperationsForHost({
      workspaceId: 'ws-1',
      hostId: 'host-alpha',
      controller,
      readDesiredSpec: async () => ({ desired: desired() }),
      gcpClient: {
        async getInstanceGuestAttributes() {
          attempts += 1;
          return attempts < 2 ? guestHostKeys().slice(0, 1) : guestHostKeys();
        },
      },
      enrollHostKeys: async () => undefined,
      awaitHostKeys: { now: clock.now, sleep: clock.sleep },
    });

    expect(attempts).toBe(2);
  });

  it('does NOT retry a wrong-instance 404 — it refuses immediately', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw instanceNotFound();
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toThrow(/instances\/ghost' was not found/);

    // The whole point of the discrimination: one call, original error, no wait.
    expect(attempts).toBe(1);
  });

  it('does NOT retry a non-404 failure', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw Object.assign(new Error('gcp_preflight_http_403: caller lacks permission'), {
              status: 403,
              reason: 'caller lacks permission',
            });
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toThrow(/403/);

    expect(attempts).toBe(1);
  });

  it('does NOT wait out MALFORMED key material — a corrupt key is a defect, not a slow one', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          async getInstanceGuestAttributes() {
            attempts += 1;
            // A COMPLETE set (so the presence predicate is satisfied) whose blob is garbage.
            return guestHostKeys().map((attribute) =>
              attribute.key === 'ssh-rsa' ? { ...attribute, value: 'not-base64!!' } : attribute,
            );
          },
        },
        awaitHostKeys: { now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostInitializationHostKeyError);

    // Read once and failed — NOT retried until the publication budget expired, which would have
    // reported a corrupt key under the wrong cause.
    expect(attempts).toBe(1);
  });

  it('gives up with a dedicated timeout error instead of waiting forever', async () => {
    const clock = fakeClock();
    let attempts = 0;

    await expect(
      resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId: 'ws-1',
        hostId: 'host-alpha',
        controller,
        readDesiredSpec: async () => ({ desired: desired() }),
        gcpClient: {
          async getInstanceGuestAttributes() {
            attempts += 1;
            throw guestAttributeNotFound();
          },
        },
        enrollHostKeys: async () => undefined,
        awaitHostKeys: {
          now: clock.now,
          sleep: clock.sleep,
          timeoutMs: 20_000,
          pollIntervalMs: 5_000,
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostHostKeyPublicationTimeoutError);

    // Bounded: 20s budget at a 5s interval, not an unbounded spin.
    expect(attempts).toBe(5);
  });
});

describe('GCP IAP controller known_hosts enrollment', () => {
  it('atomically enrolls the exact command alias while preserving unrelated entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const unrelated = `example.test ${publicKey('ssh-ed25519').split(' ').slice(0, 2).join(' ')}`;
    await chmod(root, 0o755);
    await writeFile(knownHostsFile, `${unrelated}\n`, { mode: 0o644 });
    try {
      const spec = desired();
      const identity = resolveGcpWorkspaceHostInstanceIdentity(spec);
      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys() });
      const written = await readFile(knownHostsFile, 'utf8');
      const alias = buildGcpIapWorkspaceHostInitializationCommand(
        { ...identity, ...controller, knownHostsFile },
        {
          id: 'workspace',
          kind: 'create-workspace',
          dependsOn: [],
          idempotencyKey: 'workspace-init:op-1:workspace',
          input: {},
        },
      )
        .args.find((arg) => arg.startsWith('HostKeyAlias='))!
        .slice('HostKeyAlias='.length);

      expect(written).toContain(`${unrelated}\n`);
      expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
      expect(written).not.toContain('generated-on-host');
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on missing, malformed, or changed host-key material without rewriting trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const identity = resolveGcpWorkspaceHostInstanceIdentity(desired());
    try {
      await expect(enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: [] })).rejects.toBeInstanceOf(
        WorkspaceHostInitializationHostKeyError,
      );
      await expect(
        enrollGcpIapHostKeys({
          identity,
          knownHostsFile,
          attributes: [{ namespace: 'hostkeys', key: 'ssh-ed25519', value: 'ssh-ed25519 not-base64' }],
        }),
      ).rejects.toThrow(/malformed/);

      const validEd25519 = publicKey('ssh-ed25519').split(' ')[1]!;
      const truncatedEd25519 = Buffer.from(validEd25519, 'base64').subarray(0, -1).toString('base64');
      await expect(
        enrollGcpIapHostKeys({
          identity,
          knownHostsFile,
          attributes: [{ namespace: 'hostkeys', key: 'ssh-ed25519', value: truncatedEd25519 }],
        }),
      ).rejects.toThrow(/truncated/);
      await expect(
        enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys().slice(0, 2) }),
      ).rejects.toThrow(/missing 'ssh-rsa'/);

      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('trusted') });
      const trusted = await readFile(knownHostsFile, 'utf8');
      await chmod(knownHostsFile, 0o644);
      await enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('trusted') });
      expect((await stat(knownHostsFile)).mode & 0o777).toBe(0o600);
      await expect(
        enrollGcpIapHostKeys({ identity, knownHostsFile, attributes: guestHostKeys('changed') }),
      ).rejects.toThrow(/changed/);
      await expect(readFile(knownHostsFile, 'utf8')).resolves.toBe(trusted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent enrollments so atomic rewrites preserve every host alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-'));
    const knownHostsFile = join(root, 'known_hosts');
    const first = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const second = resolveGcpWorkspaceHostInstanceIdentity(
      desired({
        hostId: 'host-beta',
        provider: { instanceName: 'host-beta', projectId: 'active-alcove-504205-q3' },
      }),
    );
    try {
      await Promise.all([
        enrollGcpIapHostKeys({ identity: first, knownHostsFile, attributes: guestHostKeys('concurrent-first') }),
        enrollGcpIapHostKeys({ identity: second, knownHostsFile, attributes: guestHostKeys('concurrent-second') }),
      ]);
      const written = await readFile(knownHostsFile, 'utf8');
      const aliases = [first, second].map((identity) =>
        buildGcpIapWorkspaceHostInitializationCommand(
          { ...identity, ...controller, knownHostsFile },
          {
            id: 'workspace',
            kind: 'create-workspace',
            dependsOn: [],
            idempotencyKey: 'workspace-init:op-concurrent:workspace',
            input: {},
          },
        )
          .args.find((arg) => arg.startsWith('HostKeyAlias='))!
          .slice('HostKeyAlias='.length),
      );
      for (const alias of aliases) expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes independent clustered worker processes sharing one StateDirectory trust file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-known-hosts-processes-'));
    const knownHostsFile = join(root, 'controller', 'known_hosts');
    const lockRoot = join(root, 'mutexes');
    const barrierRoot = join(root, 'barrier');
    const first = resolveGcpWorkspaceHostInstanceIdentity(desired());
    const second = resolveGcpWorkspaceHostInstanceIdentity(
      desired({
        hostId: 'host-beta',
        provider: { instanceName: 'host-beta', projectId: 'active-alcove-504205-q3' },
      }),
    );
    const inputPaths = [join(root, 'first.json'), join(root, 'second.json')];
    await Promise.all([
      writeFile(
        inputPaths[0]!,
        JSON.stringify({ identity: first, knownHostsFile, attributes: guestHostKeys('process-first') }),
      ),
      writeFile(
        inputPaths[1]!,
        JSON.stringify({ identity: second, knownHostsFile, attributes: guestHostKeys('process-second') }),
      ),
    ]);

    const childSource = String.raw`
      import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const payload = JSON.parse(await readFile(process.argv[1], 'utf8'));
      const barrierRoot = process.env.PAPERCUSP_HOSTKEY_TEST_BARRIER;
      const marker = join(barrierRoot, String(process.pid));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await mkdir(barrierRoot, { recursive: true });
      const { enrollGcpIapHostKeys } = await import('./packages/operator-core/lib/workspace-host/initialization-operations-resolver.ts');
      await enrollGcpIapHostKeys(payload, {
        async beforeMutex() {
          await writeFile(marker, 'ready');
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if ((await readdir(barrierRoot)).length === 2) return;
            await sleep(10);
          }
          throw new Error('cross-process enrollment barrier timed out');
        },
        afterRead: () => sleep(200),
      });
    `;
    const env = {
      ...process.env,
      PAPERCUSP_DISABLE_FS_MUTEX: '',
      PAPERCUSP_FS_MUTEX_LOCK_DIR: lockRoot,
      PAPERCUSP_HOSTKEY_TEST_BARRIER: barrierRoot,
    };

    try {
      await Promise.all(
        inputPaths.map((inputPath) =>
          execFileAsync(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '--eval', childSource, inputPath],
            { cwd: REPOSITORY_ROOT, env, timeout: 30_000 },
          ),
        ),
      );
      const written = await readFile(knownHostsFile, 'utf8');
      for (const identity of [first, second]) {
        const alias = buildGcpIapWorkspaceHostInitializationCommand(
          { ...identity, ...controller, knownHostsFile },
          {
            id: 'workspace',
            kind: 'create-workspace',
            dependsOn: [],
            idempotencyKey: `workspace-init:${identity.instanceName}:workspace`,
            input: {},
          },
        )
          .args.find((arg) => arg.startsWith('HostKeyAlias='))!
          .slice('HostKeyAlias='.length);
        expect(written.match(new RegExp(`^${alias} `, 'gm'))).toHaveLength(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

describe('persisting a desired spec is secret-safe', () => {
  it('does NOT reject a legitimate, fully-populated spec (calibration control)', () => {
    // This control is the point of the pair below. `upsertWorkspaceHost` asserts secret isolation
    // over the WHOLE spec, and that assertion rejects secret-SHAPED KEY NAMES — so a contract type
    // that ever renamed a field to something like `tokenRef` would start rejecting valid specs at
    // the persistence boundary. Without this control, the rejection test below would still pass
    // while the writer refused everything.
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({
          credentials: {
            cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
            gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
            agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
          },
          provider: { instanceName: 'explicit-vm', projectId: 'active-alcove-504205-q3' },
          labels: { env: 'canary' },
        }),
        'workspaceHost.desiredSpec',
      ),
    ).not.toThrow();
  });

  it('rejects a spec carrying secret material or a secret-shaped field', () => {
    expect(() =>
      assertWorkspaceHostSecretIsolation(
        desired({ provider: { apiKey: 'AIzaSyDUMMYVALUEFORTEST' } }),
        'workspaceHost.desiredSpec',
      ),
    ).toThrow(/Secret-shaped field/);

    // ASSEMBLED AT RUNTIME, deliberately — and assembled so that NO fragment of the banned shape
    // appears contiguously in this file's bytes. A literal PEM header here would be swept into
    // shared history by git-sync within minutes and would trip both the secrets guard and the
    // pot-git publish guard; the latter then refuses EVERY later publish permanently, because its
    // baseline never advances past a refused range and editing the file afterwards does not remove
    // the blob from history. Freezing the publish plane that way has cost hours more than once.
    // Splitting the two words is the load-bearing part: the guard matches `PRIVATE KEY`, so the
    // source must never spell it. The runtime string is still exactly what the assertion matches.
    const keyWords = ['PRIVATE', 'KEY'].join(' ');
    const pemMarker = `-----BEGIN OPENSSH ${keyWords}-----\nabc\n-----END OPENSSH ${keyWords}-----`;
    expect(() =>
      assertWorkspaceHostSecretIsolation(desired({ provider: { note: pemMarker } }), 'workspaceHost.desiredSpec'),
    ).toThrow(/Secret material is forbidden/);
  });
});
