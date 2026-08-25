import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_CREDENTIAL_FAMILIES,
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  WorkspaceHostCredentialReferenceError,
  WorkspaceHostCredentialResolver,
  UnknownWorkspaceHostCredentialFamilyError,
  assertNoResolvedAuthorizationMaterial,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  describeWorkspaceHostCredentialBinding,
  executeWorkspaceHostCredentialLifecycle,
  parseWorkspaceHostCredentialReference,
  parseWorkspaceHostCredentialRevocationReference,
  type WorkspaceHostCredentialBindingDescriptor,
  type WorkspaceHostCredentialFamily,
  type WorkspaceHostCredentialMaterializer,
} from './workspace-host-credential-namespace';
import {
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  type WorkspaceHostCredentialDeliverySet,
} from './workspace-host-initialization';
import type { WorkspaceHostCredentialRefs } from './workspace-host-types';

const REQUESTED_AT = '2026-08-25T22:00:00.000Z';
const EXPIRES_AT = '2026-08-25T23:00:00.000Z';

function cloudRef(generation = 1) {
  const fields = { provider: 'gcp', scopeId: 'active-alcove-504205-q3', workloadId: 'byoc-canary-01' };
  return {
    ref: buildWorkspaceHostCredentialReference('cloud-workload-identity', fields),
    revocationRef: buildWorkspaceHostCredentialRevocationReference(
      'cloud-workload-identity',
      fields,
      generation,
    ),
  };
}

function gitRef(generation = 1) {
  const fields = { forge: 'github', owner: 'papercupai', repository: 'papercusp-byoc-canary' };
  return {
    ref: buildWorkspaceHostCredentialReference('git-short-lived-delegation', fields),
    revocationRef: buildWorkspaceHostCredentialRevocationReference(
      'git-short-lived-delegation',
      fields,
      generation,
    ),
  };
}

function agentRef(generation = 1) {
  const fields = { hostId: 'byoc-canary-01', agentSet: 'claude-codex-omp' };
  return {
    ref: buildWorkspaceHostCredentialReference('agent-forwarded-reference', fields),
    revocationRef: buildWorkspaceHostCredentialRevocationReference(
      'agent-forwarded-reference',
      fields,
      generation,
    ),
  };
}

function refsAndDelivery(generation = 1): {
  refs: WorkspaceHostCredentialRefs;
  delivery: WorkspaceHostCredentialDeliverySet;
} {
  const cloud = cloudRef(generation);
  const git = gitRef(generation);
  const agent = agentRef(generation);
  return {
    refs: {
      cloudCredentialRef: { kind: 'cloud', ref: cloud.ref },
      gitCredentialRef: { kind: 'git', ref: git.ref },
      agentCredentialRef: { kind: 'agent', ref: agent.ref },
    },
    delivery: {
      cloud: {
        kind: 'provider-identity',
        generation,
        audience: 'pc-byoc-canary-01-vm',
        revocationRef: cloud.revocationRef,
      },
      git: {
        kind: 'short-lived-delegation',
        generation,
        audience: 'pc-byoc-canary-01-vm',
        revocationRef: git.revocationRef,
        expiresAt: EXPIRES_AT,
      },
      agent: {
        kind: 'forwarded-agent',
        generation,
        audience: 'pc-byoc-canary-01-vm',
        revocationRef: agent.revocationRef,
      },
    },
  };
}

/**
 * Records every call so the rotation test can assert ORDER, not just that each verb ran. A
 * rotate plan whose revoke landed before the new binding verified would still "pass" a test that
 * only counted calls.
 */
class RecordingMaterializer implements WorkspaceHostCredentialMaterializer {
  readonly calls: string[] = [];

  constructor(
    readonly family: WorkspaceHostCredentialFamily,
    private readonly detail: Record<string, unknown> = {},
  ) {}

  private record(op: string, binding: WorkspaceHostCredentialBindingDescriptor) {
    this.calls.push(`${op}:${binding.channel}:g${binding.generation}`);
    return Promise.resolve({ ...this.detail, generation: binding.generation });
  }

  bind(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record('bind', b);
  }
  verifyBound(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record('verify-bound', b);
  }
  revoke(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record('revoke', b);
  }
  verifyRevoked(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record('verify-revoked', b);
  }
}

function allFamilyMaterializers(detail: Record<string, unknown> = {}) {
  return WORKSPACE_HOST_CREDENTIAL_FAMILIES.map(
    (family) => new RecordingMaterializer(family, detail),
  );
}

describe('workspace-host credential namespace', () => {
  it('refuses gcloud://active-user as host authorization material, naming the ruling', () => {
    expect(() => parseWorkspaceHostCredentialReference('gcloud://active-user', 'cloud')).toThrow(
      /controller connection selector/i,
    );
    expect(() => parseWorkspaceHostCredentialReference('gcloud://active-user', 'cloud')).toThrow(
      /D-103/,
    );
  });

  it.each(['gcloud', 'gcp', 'aws', 'az', 'azure'])(
    'refuses the %s:// controller selector scheme in any channel',
    (scheme) => {
      expect(() => parseWorkspaceHostCredentialReference(`${scheme}://default`)).toThrow(
        WorkspaceHostCredentialReferenceError,
      );
    },
  );

  it('refuses an unrecognised scheme by allowlist, not just the named selectors', () => {
    expect(() => parseWorkspaceHostCredentialReference('vault://secret/data/git')).toThrow(
      /not in the ratified host namespace/,
    );
  });

  it('gives every family a distinct ref scheme so two channels cannot spell the same reference', () => {
    const schemes = Object.values(WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS).map((s) => s.refScheme);
    expect(new Set(schemes).size).toBe(schemes.length);
  });

  it('produces three distinct refs and three distinct revocation refs for one request', () => {
    const { refs, delivery } = refsAndDelivery();
    const allRefs = [
      refs.cloudCredentialRef.ref,
      refs.gitCredentialRef?.ref,
      refs.agentCredentialRef?.ref,
    ];
    const allRevocations = [
      delivery.cloud.revocationRef,
      delivery.git?.revocationRef,
      delivery.agent?.revocationRef,
    ];
    expect(new Set(allRefs).size).toBe(3);
    expect(new Set(allRevocations).size).toBe(3);
  });

  it('round-trips a built reference back through the parser with named fields', () => {
    const ref = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
      forge: 'github',
      owner: 'papercupai',
      repository: 'papercusp-byoc-canary',
    });
    expect(ref).toBe('pc-git-delegation://github/papercupai/papercusp-byoc-canary');
    const parsed = parseWorkspaceHostCredentialReference(ref, 'git');
    expect(parsed.family).toBe('git-short-lived-delegation');
    expect(parsed.fields).toEqual({
      forge: 'github',
      owner: 'papercupai',
      repository: 'papercusp-byoc-canary',
    });
  });

  it('rejects a reference whose segment count does not match its family', () => {
    expect(() => parseWorkspaceHostCredentialReference('pc-git-delegation://github/only-two')).toThrow(
      /exactly 3 segments/,
    );
  });

  it('rejects a well-formed reference sitting in the wrong channel slot', () => {
    const git = gitRef().ref;
    expect(() => parseWorkspaceHostCredentialReference(git, 'cloud')).toThrow(
      /belongs to the 'git' channel/,
    );
  });

  it.each([
    ['a newline', 'pc-agent-forward://host\nid/set'],
    ['a query string', 'pc-agent-forward://hostid/set?token=abc'],
    ['a fragment', 'pc-agent-forward://hostid/set#frag'],
    ['userinfo', 'pc-agent-forward://user@hostid/set'],
    ['whitespace', 'pc-agent-forward://host id/set'],
  ])('rejects a reference containing %s', (_label, reference) => {
    expect(() => parseWorkspaceHostCredentialReference(reference)).toThrow(
      WorkspaceHostCredentialReferenceError,
    );
  });

  it('rejects a reference over the 1024-character contract limit', () => {
    const long = `pc-agent-forward://hostid/${'a'.repeat(1100)}`;
    expect(() => parseWorkspaceHostCredentialReference(long)).toThrow(/at most 1024/);
  });

  it('requires the revocation reference to name the same generation as the delivery', () => {
    const { ref, revocationRef } = cloudRef(1);
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        channel: 'cloud',
        credentialRef: { kind: 'cloud', ref },
        delivery: {
          kind: 'provider-identity',
          generation: 2,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef,
        },
        requestedAt: REQUESTED_AT,
      }),
    ).toThrow(/names generation 1 but the delivery is generation 2/);
  });

  it('requires the revocation reference to identify the same subject as the ref', () => {
    const { ref } = cloudRef(1);
    const otherRevocation = buildWorkspaceHostCredentialRevocationReference(
      'cloud-workload-identity',
      { provider: 'gcp', scopeId: 'some-other-project', workloadId: 'byoc-canary-01' },
      1,
    );
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        channel: 'cloud',
        credentialRef: { kind: 'cloud', ref },
        delivery: {
          kind: 'provider-identity',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef: otherRevocation,
        },
        requestedAt: REQUESTED_AT,
      }),
    ).toThrow(/does not identify the same subject/);
  });

  it('refuses a delivery kind the family does not allow', () => {
    const { ref, revocationRef } = agentRef(1);
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        channel: 'agent',
        credentialRef: { kind: 'agent', ref },
        // pc-agent-forward is the FORWARDED family; an encrypted delivery must use pc-agent-sealed.
        delivery: {
          kind: 'encrypted-reference',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef,
        },
        requestedAt: REQUESTED_AT,
      }),
    ).toThrow(/may not be delivered as 'encrypted-reference'/);
  });

  it('requires a future expiry for a short-lived delegation, judged against requestedAt', () => {
    const { ref, revocationRef } = gitRef(1);
    const base = {
      channel: 'git' as const,
      credentialRef: { kind: 'git', ref },
      requestedAt: REQUESTED_AT,
    };
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        ...base,
        delivery: {
          kind: 'short-lived-delegation',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef,
        },
      }),
    ).toThrow(/requires credentialDelivery.expiresAt/);
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        ...base,
        delivery: {
          kind: 'short-lived-delegation',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef,
          expiresAt: '2026-08-25T21:00:00.000Z',
        },
      }),
    ).toThrow(/expiresAt must be after requestedAt/);
  });

  it('is accepted end-to-end by the existing initialization planner', () => {
    const { refs, delivery } = refsAndDelivery();
    const plan = planWorkspaceHostInitialization({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-init-001',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      source: {
        kind: 'git',
        repositoryUrl: 'https://github.com/papercupai/papercusp-byoc-canary.git',
        visibility: 'private',
        destination: 'repos/papercusp-byoc-canary',
        revision: 'main',
      },
      credentialRefs: refs,
      credentialDelivery: delivery,
      publicMetadata: { canaryRunId: 'byoc-canary-001' },
    });
    // The private-git binding is hoisted before the clone; that ordering is what lets a private
    // clone authenticate at all, so it is asserted rather than assumed.
    expect(plan.steps.map((step) => step.id)).toEqual([
      'workspace',
      'bind-git',
      'source',
      'bind-cloud',
      'bind-agent',
      'verify',
    ]);
  });
});

describe('workspace-host credential resolver', () => {
  it('binds each of the three channels through its own family materializer', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const { refs, delivery } = refsAndDelivery();

    const cloud = await resolver.run('bind', {
      channel: 'cloud',
      credentialRef: refs.cloudCredentialRef,
      delivery: delivery.cloud,
      requestedAt: REQUESTED_AT,
    });
    const git = await resolver.run('bind', {
      channel: 'git',
      credentialRef: refs.gitCredentialRef!,
      delivery: delivery.git!,
      requestedAt: REQUESTED_AT,
    });
    const agent = await resolver.run('bind', {
      channel: 'agent',
      credentialRef: refs.agentCredentialRef!,
      delivery: delivery.agent!,
      requestedAt: REQUESTED_AT,
    });

    expect([cloud.family, git.family, agent.family]).toEqual([
      'cloud-workload-identity',
      'git-short-lived-delegation',
      'agent-forwarded-reference',
    ]);
    // Digests discriminate without republishing the reference.
    expect(new Set([cloud.referenceDigest, git.referenceDigest, agent.referenceDigest]).size).toBe(3);
    expect(cloud.referenceDigest).not.toContain('active-alcove');
  });

  it('refuses to proceed when no materializer is registered for the family', async () => {
    const resolver = new WorkspaceHostCredentialResolver([
      new RecordingMaterializer('git-short-lived-delegation'),
    ]);
    const { refs, delivery } = refsAndDelivery();
    await expect(
      resolver.run('bind', {
        channel: 'cloud',
        credentialRef: refs.cloudCredentialRef,
        delivery: delivery.cloud,
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toBeInstanceOf(UnknownWorkspaceHostCredentialFamilyError);
  });

  it('rejects materializer evidence that leaks resolved authorization material', async () => {
    const leaky = new RecordingMaterializer('cloud-workload-identity', {
      accessToken: 'ya29.leaked',
    });
    const resolver = new WorkspaceHostCredentialResolver([leaky]);
    const { refs, delivery } = refsAndDelivery();
    await expect(
      resolver.run('bind', {
        channel: 'cloud',
        credentialRef: refs.cloudCredentialRef,
        delivery: delivery.cloud,
        requestedAt: REQUESTED_AT,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('rejects evidence naming the material itself, which the secret-key regex does not catch', () => {
    // `assertWorkspaceHostSecretIsolation` alone accepts this key; the credential-specific guard
    // is what makes it a failure.
    expect(() =>
      assertNoResolvedAuthorizationMaterial({ material: 'anything' }, 'test'),
    ).toThrow(/Resolved authorization material is forbidden/);
    expect(() => assertNoResolvedAuthorizationMaterial({ bearer: 'x' }, 'test')).toThrow();
  });

  it('rotates every channel: binds the new generation, then revokes the previous one, in order', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const current = refsAndDelivery(1);
    const next = refsAndDelivery(2);

    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-rotate-001',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      action: 'rotate',
      currentCredentialRefs: current.refs,
      currentDelivery: current.delivery,
      nextCredentialRefs: next.refs,
      nextDelivery: next.delivery,
    });

    const receipts = await executeWorkspaceHostCredentialLifecycle(plan, resolver);
    expect(receipts.length).toBe(plan.steps.length);

    const cloudCalls = materializers.find((m) => m.family === 'cloud-workload-identity')!.calls;
    const bindIndex = cloudCalls.indexOf('bind:cloud:g2');
    const revokeIndex = cloudCalls.indexOf('revoke:cloud:g1');
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeGreaterThanOrEqual(0);
    // The new binding must be established before the old one is torn down.
    expect(bindIndex).toBeLessThan(revokeIndex);

    // Every channel took part in the rotation.
    const channels = new Set(receipts.map((r) => r.evidence.channel));
    expect([...channels].sort()).toEqual(['agent', 'cloud', 'git']);
  });

  it('revokes named channels and can verify the revocation', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const current = refsAndDelivery(1);

    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-revoke-001',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      action: 'revoke',
      currentCredentialRefs: current.refs,
      currentDelivery: current.delivery,
      channels: ['git'],
    });

    const receipts = await executeWorkspaceHostCredentialLifecycle(plan, resolver);
    expect(receipts.every((r) => r.evidence.channel === 'git')).toBe(true);
    const gitCalls = materializers.find((m) => m.family === 'git-short-lived-delegation')!.calls;
    expect(gitCalls).toContain('revoke:git:g1');
  });

  it('reconnects every channel after a restart', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const current = refsAndDelivery(1);

    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-reconnect-001',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      action: 'reconnect',
      currentCredentialRefs: current.refs,
      currentDelivery: current.delivery,
    });

    const receipts = await executeWorkspaceHostCredentialLifecycle(plan, resolver);
    expect(receipts.length).toBeGreaterThan(0);
    expect(new Set(receipts.map((r) => r.evidence.channel)).size).toBe(3);
  });

  it('rebinds all three channels from a backup manifest that carries no references', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const next = refsAndDelivery(2);

    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-restore-001',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      action: 'restore-rebind',
      backup: {
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        workspaceId: 'papercusp-workspace',
        capturedAt: REQUESTED_AT,
        authorizationMaterial: 'excluded',
        credentialReferences: 'excluded',
        rebindRequired: ['cloud', 'git', 'agent'],
      },
      nextCredentialRefs: next.refs,
      nextDelivery: next.delivery,
    });

    const receipts = await executeWorkspaceHostCredentialLifecycle(plan, resolver);
    expect(new Set(receipts.map((r) => r.evidence.channel)).size).toBe(3);
    expect(receipts.every((r) => r.evidence.generation === 2)).toBe(true);
  });

  it('refuses to run a lifecycle step whose dependency has not completed', async () => {
    const resolver = new WorkspaceHostCredentialResolver(allFamilyMaterializers());
    const current = refsAndDelivery(1);
    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: 'byoc-canary-reconnect-002',
      workspaceId: 'papercusp-workspace',
      hostId: 'byoc-canary-01',
      requestedAt: REQUESTED_AT,
      action: 'reconnect',
      currentCredentialRefs: current.refs,
      currentDelivery: current.delivery,
    });
    const scrambled = { ...plan, steps: [...plan.steps].reverse() };
    if (scrambled.steps.some((step) => step.dependsOn.length > 0)) {
      await expect(executeWorkspaceHostCredentialLifecycle(scrambled, resolver)).rejects.toThrow(
        /has not completed/,
      );
    }
  });
});

/**
 * The sealed agent family was the one family with no direct coverage: the suite reached it only
 * through table-driven assertions over every family, which cannot see whether its own scheme
 * round-trips or which revocation surface it lands on. Both are load-bearing rulings.
 */
describe('agent-encrypted-reference (the sealed agent family)', () => {
  const SEALED_FIELDS = { hostId: 'byoc-canary-01', agentSet: 'claude-codex-omp' };

  it('round-trips its own pc-agent-sealed reference', () => {
    const ref = buildWorkspaceHostCredentialReference('agent-encrypted-reference', SEALED_FIELDS);
    expect(ref).toBe('pc-agent-sealed://byoc-canary-01/claude-codex-omp');
    const parsed = parseWorkspaceHostCredentialReference(ref, 'agent');
    expect(parsed.family).toBe('agent-encrypted-reference');
    expect(parsed.segments).toEqual(['byoc-canary-01', 'claude-codex-omp']);
  });

  it('SHARES the agent revocation scheme with the forwarded family, by design', () => {
    // A request carries at most one agent channel, so the two families never coexist and one
    // revocation surface for "the agent binding on this host" is the honest model. Asserting it
    // here means a later split into two schemes has to be a deliberate change, not a drift.
    const sealed = buildWorkspaceHostCredentialRevocationReference(
      'agent-encrypted-reference',
      SEALED_FIELDS,
      3,
    );
    const forwarded = buildWorkspaceHostCredentialRevocationReference(
      'agent-forwarded-reference',
      SEALED_FIELDS,
      3,
    );
    expect(sealed).toBe(forwarded);
    expect(sealed.startsWith('pc-agent-revocation://')).toBe(true);
    expect(parseWorkspaceHostCredentialRevocationReference(sealed, 'agent-encrypted-reference')
      .generation).toBe(3);
  });

  it('accepts an encrypted-reference delivery and refuses a forwarded-agent one', () => {
    const ref = buildWorkspaceHostCredentialReference('agent-encrypted-reference', SEALED_FIELDS);
    const revocationRef = buildWorkspaceHostCredentialRevocationReference(
      'agent-encrypted-reference',
      SEALED_FIELDS,
      1,
    );
    const base = {
      channel: 'agent' as const,
      credentialRef: { kind: 'agent', ref },
      requestedAt: REQUESTED_AT,
    };
    const descriptor = describeWorkspaceHostCredentialBinding({
      ...base,
      delivery: {
        kind: 'encrypted-reference',
        generation: 1,
        audience: 'pc-byoc-canary-01-vm',
        revocationRef,
      },
    });
    expect(descriptor.family).toBe('agent-encrypted-reference');

    expect(() =>
      describeWorkspaceHostCredentialBinding({
        ...base,
        delivery: {
          kind: 'forwarded-agent',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef,
        },
      }),
    ).toThrow(/may not be delivered as 'forwarded-agent'/);
  });

  it('needs no expiry, unlike the short-lived git delegation', () => {
    const ref = buildWorkspaceHostCredentialReference('agent-encrypted-reference', SEALED_FIELDS);
    expect(() =>
      describeWorkspaceHostCredentialBinding({
        channel: 'agent',
        credentialRef: { kind: 'agent', ref },
        delivery: {
          kind: 'encrypted-reference',
          generation: 1,
          audience: 'pc-byoc-canary-01-vm',
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            'agent-encrypted-reference',
            SEALED_FIELDS,
            1,
          ),
        },
        requestedAt: REQUESTED_AT,
      }),
    ).not.toThrow();
  });

  it('binds through the resolver under its own family', async () => {
    const materializers = allFamilyMaterializers();
    const resolver = new WorkspaceHostCredentialResolver(materializers);
    const evidence = await resolver.run('bind', {
      channel: 'agent',
      credentialRef: {
        kind: 'agent',
        ref: buildWorkspaceHostCredentialReference('agent-encrypted-reference', SEALED_FIELDS),
      },
      delivery: {
        kind: 'encrypted-reference',
        generation: 2,
        audience: 'pc-byoc-canary-01-vm',
        revocationRef: buildWorkspaceHostCredentialRevocationReference(
          'agent-encrypted-reference',
          SEALED_FIELDS,
          2,
        ),
      },
      requestedAt: REQUESTED_AT,
    });
    expect(evidence.family).toBe('agent-encrypted-reference');
    expect(evidence.deliveryKind).toBe('encrypted-reference');
    expect(evidence.generation).toBe(2);
    const sealedMaterializer = materializers.find(
      (m) => m.family === 'agent-encrypted-reference',
    );
    expect(sealedMaterializer?.calls).toEqual(['bind:agent:g2']);
  });
});
