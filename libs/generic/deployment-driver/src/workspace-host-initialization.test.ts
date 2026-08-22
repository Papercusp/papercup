import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  buildWorkspaceHostBackupCredentialManifest,
  executeWorkspaceHostInitialization,
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  validateWorkspaceHostInitializationCanary,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationRequest,
} from "./workspace-host-initialization";
import type { WorkspaceHostCredentialRefs } from "./workspace-host-types";

const REQUESTED_AT = "2026-08-22T10:00:00Z";

function refs(suffix = "v1"): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: { kind: "cloud", ref: `cloud-resolver:${suffix}` },
    gitCredentialRef: { kind: "git", ref: `git-resolver:${suffix}` },
    agentCredentialRef: { kind: "agent", ref: `agent-resolver:${suffix}` },
  };
}

function delivery(generation = 1): WorkspaceHostCredentialDeliverySet {
  return {
    cloud: {
      kind: "provider-identity",
      generation,
      audience: "host-1",
      revocationRef: `revoke-cloud-${generation}`,
    },
    git: {
      kind: "forwarded-agent",
      generation,
      audience: "host-1",
      revocationRef: `revoke-git-${generation}`,
    },
    agent: {
      kind: "short-lived-delegation",
      generation,
      audience: "host-1",
      revocationRef: `revoke-agent-${generation}`,
      expiresAt: "2026-08-22T11:00:00Z",
    },
  };
}

function request(
  overrides: Partial<WorkspaceHostInitializationRequest> = {},
): WorkspaceHostInitializationRequest {
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: "init-1",
    workspaceId: "workspace-1",
    hostId: "host-1",
    requestedAt: REQUESTED_AT,
    source: { kind: "empty" },
    credentialRefs: refs(),
    credentialDelivery: delivery(),
    ...overrides,
  };
}

describe("planWorkspaceHostInitialization", () => {
  it("creates an empty workspace and binds three distinct runtime channels after bootstrap", () => {
    const first = planWorkspaceHostInitialization(request());
    const replay = planWorkspaceHostInitialization(request());
    expect(first).toEqual(replay);
    expect(first.steps.map((step) => step.id)).toEqual([
      "workspace",
      "bind-cloud",
      "bind-git",
      "bind-agent",
      "verify",
    ]);
    expect(first.steps.at(-1)?.dependsOn).toEqual([
      "bind-cloud",
      "bind-git",
      "bind-agent",
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /PRIVATE KEY|resolvedAuthorization/i,
    );
  });

  it("models private clone through the Git channel without embedding authorization in the URL", () => {
    const plan = planWorkspaceHostInitialization(
      request({
        source: {
          kind: "git",
          repositoryUrl: "https://github.com/papercusp/private-repo.git",
          visibility: "private",
          destination: "repositories/private-repo",
          revision: "main",
        },
      }),
    );
    expect(plan.steps[1]).toMatchObject({
      id: "bind-git",
      kind: "bind-credential",
      dependsOn: ["workspace"],
    });
    expect(plan.steps[2]).toMatchObject({
      id: "source",
      kind: "clone-repository",
      dependsOn: ["bind-git"],
      input: { credentialChannel: "git" },
    });
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl:
              "https://name:authorization@github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
        }),
      ),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl: "https://authorization@github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
        }),
      ),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl: "https://github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
          credentialRefs: { cloudCredentialRef: refs().cloudCredentialRef },
          credentialDelivery: { cloud: delivery().cloud },
        }),
      ),
    ).toThrow(/requires gitCredentialRef/);
  });

  it("requires an explicit allowlist for pairing/import and rejects unrelated-state defaults", () => {
    expect(
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "pair",
            sourceWorkspaceId: "workspace-source",
            pairingReference: { kind: "pairing", ref: "pairing:request-1" },
            include: ["repositories", "transcripts"],
          },
        }),
      ).steps[1],
    ).toMatchObject({ kind: "pair-workspace" });
    expect(
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "import",
            sourceWorkspaceId: "workspace-source",
            sourceSnapshotRef: "snapshot:backup-1",
            include: ["files", "database"],
          },
        }),
      ).steps[1],
    ).toMatchObject({ kind: "import-workspace" });
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "import",
            sourceWorkspaceId: "workspace-source",
            sourceSnapshotRef: "snapshot:backup-1",
            include: [],
          },
        }),
      ),
    ).toThrow(/explicitly select at least one unit/);
  });

  it("rejects shared resolver ids and channel-inappropriate delivery", () => {
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          credentialRefs: {
            cloudCredentialRef: { kind: "cloud", ref: "resolver:same" },
            gitCredentialRef: { kind: "git", ref: "resolver:same" },
          },
          credentialDelivery: {
            cloud: delivery().cloud,
            git: delivery().git,
          },
        }),
      ),
    ).toThrow(/must be distinct/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          credentialDelivery: {
            ...delivery(),
            cloud: { ...delivery().cloud, kind: "forwarded-agent" },
          },
        }),
      ),
    ).toThrow(/not allowed for that channel/);
  });
});

describe("executeWorkspaceHostInitialization", () => {
  it("executes the dependency order and accepts structured redacted receipts", async () => {
    const plan = planWorkspaceHostInitialization(request());
    const seen: string[] = [];
    const receipts = await executeWorkspaceHostInitialization(plan, {
      execute: async (step) => {
        seen.push(step.id);
        return {
          stepId: step.id,
          status: "succeeded",
          observedAt: "2026-08-22T10:05:00Z",
          publicEvidence: { check: step.kind, ok: true },
        };
      },
    });
    expect(seen).toEqual(plan.steps.map((step) => step.id));
    expect(receipts).toHaveLength(plan.steps.length);
  });

  it("fails closed when an adapter tries to persist authorization-shaped evidence", async () => {
    const plan = planWorkspaceHostInitialization(request());
    await expect(
      executeWorkspaceHostInitialization(plan, {
        execute: async (step) => ({
          stepId: step.id,
          status: "succeeded",
          observedAt: "2026-08-22T10:05:00Z",
          publicEvidence: { apiToken: "must-never-persist" },
        }),
      }),
    ).rejects.toThrow(/Secret-shaped field/);
  });
});

describe("workspace-host credential lifecycle", () => {
  it("verifies every rotated binding before revoking its predecessor", () => {
    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: "rotate-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      action: "rotate",
      currentCredentialRefs: refs("old"),
      currentDelivery: delivery(1),
      nextCredentialRefs: refs("new"),
      nextDelivery: delivery(2),
    });
    expect(plan.steps.slice(0, 4).map((step) => step.id)).toEqual([
      "bind-next-cloud",
      "verify-next-cloud",
      "revoke-previous-cloud",
      "verify-revoked-cloud",
    ]);
    expect(plan.steps[2].dependsOn).toEqual(["verify-next-cloud"]);
    expect(plan.steps[2].delivery.revocationRef).toBe("revoke-cloud-1");
    expect(plan.steps).toHaveLength(12);
  });

  it("plans explicit revocation and reconnect for the selected live channels", () => {
    const common = {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      currentCredentialRefs: refs(),
      currentDelivery: delivery(),
    } as const;
    const revoke = planWorkspaceHostCredentialLifecycle({
      ...common,
      operationId: "revoke-1",
      action: "revoke",
      channels: ["git", "agent"],
    });
    expect(revoke.steps.map((step) => step.id)).toEqual([
      "revoke-git",
      "verify-revoked-git",
      "revoke-agent",
      "verify-revoked-agent",
    ]);
    expect(revoke.steps[0]).toMatchObject({
      credentialRef: refs().gitCredentialRef,
      delivery: { revocationRef: "revoke-git-1" },
    });
    const reconnect = planWorkspaceHostCredentialLifecycle({
      ...common,
      operationId: "reconnect-1",
      action: "reconnect",
    });
    expect(reconnect.steps.filter((step) => step.kind === "bind")).toHaveLength(
      3,
    );
  });

  it("keeps references out of backups and requires all channels to rebind after restore", () => {
    const manifest = buildWorkspaceHostBackupCredentialManifest(
      "workspace-1",
      REQUESTED_AT,
      refs(),
    );
    expect(manifest).toMatchObject({
      authorizationMaterial: "excluded",
      credentialReferences: "excluded",
      rebindRequired: WORKSPACE_HOST_CREDENTIAL_CHANNELS,
    });
    expect(JSON.stringify(manifest)).not.toContain("resolver:");

    const restored = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: "restore-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      action: "restore-rebind",
      backup: manifest,
      nextCredentialRefs: refs("restored"),
      nextDelivery: delivery(2),
    });
    expect(restored.steps.filter((step) => step.kind === "bind")).toHaveLength(
      3,
    );
    expect(() =>
      planWorkspaceHostCredentialLifecycle({
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        operationId: "restore-incomplete",
        workspaceId: "workspace-1",
        hostId: "host-1",
        requestedAt: REQUESTED_AT,
        action: "restore-rebind",
        backup: manifest,
        nextCredentialRefs: { cloudCredentialRef: refs().cloudCredentialRef },
        nextDelivery: { cloud: delivery(2).cloud },
      }),
    ).toThrow(/rebind every channel/);
  });
});

describe("validateWorkspaceHostInitializationCanary", () => {
  function evidence(): WorkspaceHostInitializationCanaryEvidence {
    return {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      kind: "live",
      runId: "canary-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      observedAt: "2026-08-22T10:15:00Z",
      repository: { visibility: "private", cloned: true },
      channels: {
        cloud: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
        git: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
        agent: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
      },
      agents: {
        claude: { authenticated: true },
        codex: { authenticated: true },
        omp: { authenticated: true },
      },
      backupRestore: {
        authorizationMaterial: "excluded",
        credentialReferences: "excluded",
        reboundChannels: ["cloud", "git", "agent"],
      },
    };
  }

  it("accepts only a live private-repository, three-channel, three-agent lifecycle proof", () => {
    expect(validateWorkspaceHostInitializationCanary(evidence())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("reports a missing agent and incomplete restore rebinding without raw logs", () => {
    const incomplete = evidence();
    incomplete.agents.omp.authenticated = false as true;
    incomplete.backupRestore.reboundChannels = ["cloud", "git"];
    const result = validateWorkspaceHostInitializationCanary(incomplete);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "omp live authentication did not pass",
        "restore did not rebind all credential channels",
      ]),
    );
  });
});
