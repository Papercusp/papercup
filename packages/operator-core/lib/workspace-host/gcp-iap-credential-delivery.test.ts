import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WorkspaceHostCredentialMaterial,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  parseWorkspaceHostCredentialDeliveryRequest,
  type WorkspaceHostBootstrapReadinessOptions,
  type WorkspaceHostBootstrapReadinessResult,
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostInitializationHostOperationResult,
  type WorkspaceHostInitializationHostOperations,
  type WorkspaceHostInitializationStep,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import {
  GcpIapDeliveringWorkspaceHostInitializationOperations,
  GcpIapWorkspaceHostCredentialDeliveryError,
  buildGcpIapWorkspaceHostCredentialDeliveryCommand,
  deliverGcpIapWorkspaceHostCredentialMaterial,
  parseGcpIapWorkspaceHostCredentialDeliveryReceipt,
  type GcpIapWorkspaceHostCredentialDeliveryProfile,
} from './gcp-iap-credential-delivery';
import type {
  WorkspaceHostCredentialMaterialRequest,
  WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';
import type {
  GcpIapWorkspaceHostInitializationCommand,
  GcpIapWorkspaceHostInitializationCommandRunner,
  GcpIapWorkspaceHostInitializationStep,
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

    let message = '';
    try {
      await deliverGcpIapWorkspaceHostCredentialMaterial(PROFILE, input(), runner);
      expect.unreachable('delivery should have rejected');
    } catch (caught) {
      message = (caught as Error).message;
    }

    expect(message).toMatch(/have been revoked/);
    // The diagnostic is the host's stderr, which the delivery CLI writes as `name: message` and
    // never as the request — so the secret must not appear anywhere in the surfaced failure.
    expect(message).not.toContain('private-token-value');
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

/* ------------------------------------------------------------------------------------------ */

const CLOUD_REF = buildWorkspaceHostCredentialReference('cloud-workload-identity', {
  provider: 'gcp',
  scopeId: 'active-alcove-504205-q3',
  workloadId: 'p046-canary-03',
});

function gitDelivery(generation = 7) {
  return {
    kind: 'short-lived-delegation' as const,
    generation,
    audience: 'github.com/papercupai/private-canary',
    revocationRef: buildWorkspaceHostCredentialRevocationReference(
      'git-short-lived-delegation',
      { forge: 'github', owner: 'papercupai', repository: 'private-canary' },
      generation,
    ),
    expiresAt: '2026-08-31T12:00:00.000Z',
  };
}

function bindCredentialStep(
  channel: 'git' | 'cloud' = 'git',
  generation = 7,
): WorkspaceHostInitializationStep {
  return {
    id: `bind-${channel}`,
    kind: 'bind-credential',
    dependsOn: ['workspace'],
    idempotencyKey: `p046-canary-03:bind-${channel}`,
    input: {
      channel,
      credentialRef: { kind: channel, ref: channel === 'git' ? GIT_REF : CLOUD_REF },
      delivery:
        channel === 'git'
          ? gitDelivery(generation)
          : {
              kind: 'provider-identity' as const,
              generation,
              audience: 'https://compute.googleapis.com',
              revocationRef: buildWorkspaceHostCredentialRevocationReference(
                'cloud-workload-identity',
                { provider: 'gcp', scopeId: 'active-alcove-504205-q3', workloadId: 'p046-canary-03' },
                generation,
              ),
            },
    },
  };
}

/** The rotation shape: the same fields, at the top level rather than inside `input`. */
function lifecycleBindStep(generation = 8): WorkspaceHostCredentialLifecycleStep {
  return {
    id: 'bind-git',
    kind: 'bind',
    channel: 'git',
    dependsOn: [],
    idempotencyKey: `p046-canary-03:rotate:bind-git`,
    credentialRef: { kind: 'git', ref: GIT_REF },
    delivery: gitDelivery(generation),
  };
}

class StubOperations implements WorkspaceHostInitializationHostOperations {
  readonly supportedStepKinds = ['create-workspace', 'bind-credential'] as const;
  readonly executed: string[] = [];

  /** `log` is shared with the runner, so a test can assert delivery ran BEFORE the step was sent. */
  constructor(private readonly log: string[]) {}

  async execute(step: { id: string }): Promise<WorkspaceHostInitializationHostOperationResult> {
    this.executed.push(step.id);
    this.log.push(`execute:${step.id}`);
    return { observedAt: '2026-08-31T10:00:01.000Z' };
  }
}

class RecordingRunner implements GcpIapWorkspaceHostInitializationCommandRunner {
  readonly commands: GcpIapWorkspaceHostInitializationCommand[] = [];
  constructor(
    private readonly log: string[],
    private readonly result: { exitCode: number; stdout: string; stderr: string },
  ) {}
  async run(command: GcpIapWorkspaceHostInitializationCommand) {
    this.commands.push(command);
    this.log.push('deliver');
    return this.result;
  }
}

function materialSource(seen: WorkspaceHostCredentialMaterialRequest[]): WorkspaceHostCredentialMaterialSource {
  return {
    async resolve(request) {
      seen.push(request);
      return new WorkspaceHostCredentialMaterial(Buffer.from(SECRET, 'utf8'));
    },
  };
}

function delivering(
  log: string[],
  source: WorkspaceHostCredentialMaterialSource | undefined,
  result = { exitCode: 0, stdout: receipt(), stderr: '' },
) {
  const inner = new StubOperations(log);
  const runner = new RecordingRunner(log, result);
  const operations = new GcpIapDeliveringWorkspaceHostInitializationOperations(
    inner,
    PROFILE,
    source,
    runner,
  );
  return { inner, runner, operations };
}

describe('delivery runs BEFORE the binding step it makes possible', () => {
  /**
   * `ProductionWorkspaceHostCredentialMaterializer.bind()` is an OBSERVATION: it checks that the
   * material path exists and refuses when it does not. Delivery is what makes that observation
   * able to succeed, so the ordering here is the whole feature — not an implementation detail.
   */
  it('delivers the material, then sends the bind step', async () => {
    const log: string[] = [];
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const { inner, runner, operations } = delivering(log, materialSource(seen));

    await operations.execute(bindCredentialStep());

    expect(log).toEqual(['deliver', 'execute:bind-git']);
    expect(inner.executed).toEqual(['bind-git']);
    // The family is DERIVED from the reference, never taken from a second field that could disagree.
    expect(seen).toEqual([
      { channel: 'git', credentialRef: GIT_REF, family: 'git-short-lived-delegation', generation: 7 },
    ]);
    // And the bytes went down the pipe of the DELIVERY entrypoint, not the initializer's.
    const [command] = runner.commands;
    expect(command?.args.at(-1)).toContain(PROFILE.deliveryEntrypoint);
    expect(command?.stdin).toContain(Buffer.from(SECRET, 'utf8').toString('base64'));
    expect([command?.command, ...(command?.args ?? [])].join(' ')).not.toContain('private-token-value');
  });

  it('delivers for a ROTATION bind too, whose fields sit at the top level', async () => {
    const log: string[] = [];
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const { operations } = delivering(log, materialSource(seen), {
      exitCode: 0,
      stdout: receipt({ generation: 8 }),
      stderr: '',
    });

    await operations.execute(lifecycleBindStep());

    expect(log).toEqual(['deliver', 'execute:bind-git']);
    expect(seen[0]?.generation).toBe(8);
  });

  it('SKIPS delivery for an ambient family, and still runs the binding step', async () => {
    const log: string[] = [];
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const { runner, operations } = delivering(log, materialSource(seen));

    await operations.execute(bindCredentialStep('cloud'));

    // `cloud-workload-identity` is answered by the metadata server. Writing a file for it would
    // make bind() pass against a path delivery created itself (D-215 point 4).
    expect(log).toEqual(['execute:bind-cloud']);
    expect(runner.commands).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('resolves no material at all for a step that is not a binding', async () => {
    const log: string[] = [];
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const { operations } = delivering(log, materialSource(seen));

    await operations.execute({
      id: 'workspace',
      kind: 'create-workspace',
      dependsOn: [],
      idempotencyKey: 'p046-canary-03:workspace',
      input: { workspaceId: 'workspace-1', hostId: 'p046-canary-03' },
    });

    expect(log).toEqual(['execute:workspace']);
    expect(seen).toEqual([]);
  });

  it('advertises the inner adapter’s step kinds unchanged — delivery is not a step', () => {
    const { inner, operations } = delivering([], materialSource([]));
    expect(operations.supportedStepKinds).toBe(inner.supportedStepKinds);
  });

  // WI-10001677. The two halves are asserted together on purpose: forwarding alone would let a
  // wrapper expose a gate its inner cannot perform (the runner would then await a promise no probe
  // backs), and absence alone would let it silently drop a gate the inner does implement — which
  // is the defect that shipped. Presence must MIRROR the inner, so both directions are guarded.
  it('forwards the bootstrap-readiness gate to an inner adapter that implements it', async () => {
    const log: string[] = [];
    // Typed to the REAL signature, not `unknown`: a loosely-typed stub would let this test keep
    // passing against a forwarder whose types had drifted from the interface.
    const inner = new StubOperations(log) as StubOperations & {
      awaitBootstrapReady?: (
        options?: WorkspaceHostBootstrapReadinessOptions,
      ) => Promise<WorkspaceHostBootstrapReadinessResult>;
    };
    const seen: (WorkspaceHostBootstrapReadinessOptions | undefined)[] = [];
    inner.awaitBootstrapReady = async (options?: WorkspaceHostBootstrapReadinessOptions) => {
      seen.push(options);
      return { waitedMs: 7, probes: 2, readyImmediately: false };
    };

    const operations = new GcpIapDeliveringWorkspaceHostInitializationOperations(
      inner,
      PROFILE,
      materialSource([]),
      new RecordingRunner(log, { exitCode: 0, stdout: '', stderr: '' }),
    );

    expect(typeof operations.awaitBootstrapReady).toBe('function');
    const result = await operations.awaitBootstrapReady!({ timeoutMs: 1234 });
    // The inner's result is returned unchanged, and its options reach it — a forwarder that
    // swallowed either would still satisfy a bare `typeof === 'function'` check.
    expect(result).toEqual({ waitedMs: 7, probes: 2, readyImmediately: false });
    expect(seen).toEqual([{ timeoutMs: 1234 }]);
  });

  it('leaves the gate undefined when the inner adapter does not implement it — no gate, not a broken one', () => {
    const { operations } = delivering([], materialSource([]));
    expect(operations.awaitBootstrapReady).toBeUndefined();
  });
});

describe('a controller with no material source refuses by NAME', () => {
  /**
   * The host's own message for this gap is `delivered material for family 'X' is not present on
   * the host`, which blames the host for a controller configuration gap — the message that made
   * this defect look like a broken VM through six holders of this item (D-215's Measured section).
   */
  it('refuses on the controller, before the tunnel opens, and never sends the bind step', async () => {
    const log: string[] = [];
    const { inner, runner, operations } = delivering(log, undefined);

    await expect(operations.execute(bindCredentialStep())).rejects.toMatchObject({
      name: 'WorkspaceHostCredentialMaterialUnavailableError',
      channel: 'git',
      family: 'git-short-lived-delegation',
      generation: 7,
    });
    expect(inner.executed).toEqual([]);
    expect(runner.commands).toEqual([]);
  });

  it('still binds an ambient family with no source configured (calibration control)', async () => {
    const log: string[] = [];
    const { inner, operations } = delivering(log, undefined);

    await operations.execute(bindCredentialStep('cloud'));

    // Without this control, the refusal above would also pass if the wrapper simply refused
    // everything — which would break the cloud channel that works today.
    expect(inner.executed).toEqual(['bind-cloud']);
  });
});

describe('a receipt must answer about the binding that was asked for', () => {
  it('refuses a receipt naming a different generation, and does not send the bind step', async () => {
    const log: string[] = [];
    const { inner, operations } = delivering(log, materialSource([]), {
      exitCode: 0,
      stdout: receipt({ generation: 3 }),
      stderr: '',
    });

    await expect(operations.execute(bindCredentialStep())).rejects.toThrow(
      /acknowledged family 'git-short-lived-delegation' generation 3, but the binding asked for .* generation 7/,
    );
    expect(inner.executed).toEqual([]);
  });

  it('refuses a receipt naming a different family', async () => {
    const log: string[] = [];
    const { operations } = delivering(log, materialSource([]), {
      exitCode: 0,
      stdout: receipt({ family: 'agent-encrypted-reference' }),
      stderr: '',
    });

    await expect(operations.execute(bindCredentialStep())).rejects.toThrow(
      /acknowledged family 'agent-encrypted-reference'/,
    );
  });
});

describe('a malformed binding step is refused rather than silently skipped', () => {
  it('refuses a bind step whose generation is not a positive integer', async () => {
    const log: string[] = [];
    const { operations } = delivering(log, materialSource([]));
    const step = bindCredentialStep();
    const broken = {
      ...step,
      input: { ...step.input, delivery: { ...gitDelivery(), generation: 0 } },
    } as GcpIapWorkspaceHostInitializationStep;

    // Skipping it would deliver nothing and then let bind fail on the host — the exact
    // misattributed failure this wrapper exists to remove.
    await expect(operations.execute(broken as WorkspaceHostInitializationStep)).rejects.toThrow(
      /delivery.generation must be a positive safe integer/,
    );
  });
});
