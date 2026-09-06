import { describe, expect, it } from "vitest";
import type {
  WorkspaceHostRecoverySpec,
  WorkspaceHostRestoreProof,
} from "./workspace-host-recovery";
import {
  WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
  assertWorkspaceHostRuntimeRollbackSafe,
  planWorkspaceHostRecovery,
  validateWorkspaceHostRestoreProof,
} from "./workspace-host-recovery";

const NOW = "2026-08-23T05:00:00.000Z";

function recoverySpec(): WorkspaceHostRecoverySpec {
  return {
    contractVersion: WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
    recoveryId: "recovery:workspace-1:2026-q3",
    workspaceId: "workspace-1",
    requestedAt: NOW,
    sourceHost: { hostId: "host-source", target: "gcp", resources: [] },
    desired: {
      hostId: "host-recovered",
      target: "gcp",
      scope: { kind: "project", id: "project-1" },
      region: "us-central1",
      zone: "us-central1-a",
      size: "n2-standard-2",
      image: {
        id: "projects/images/global/images/papercusp-v2",
        version: "v2",
      },
      data: {
        volumeGiB: 120,
        encrypted: true,
        backupPolicyRef: "backup-policy:workspace-1",
      },
      credentials: {
        cloudCredentialRef: { kind: "cloud", ref: "adc://operator" },
      },
    },
    applicationBackup: {
      system: "@papercusp/backup",
      workspaceId: "workspace-1",
      snapshotId: 42,
      kopiaSnapshotId: "kopia-42",
      status: "ok",
      capturedAt: "2026-08-23T04:30:00.000Z",
      verifiedAt: "2026-08-23T04:45:00.000Z",
      databaseDumpPath: "db-dumps/pg-embedded.sql.gz",
      sources: ["postgres", "repositories", "transcripts", "workspaces"],
    },
    providerSnapshot: {
      snapshot: {
        target: "gcp",
        providerId: "snapshot-host-source-2026-q3",
        hostId: "host-source",
        createdAt: "2026-08-23T04:31:00.000Z",
        encryptionKeyRef:
          "projects/project-1/locations/global/keyRings/workspaces/cryptoKeys/data",
        retainUntil: "2027-08-23T00:00:00.000Z",
      },
      encrypted: true,
      retentionDays: 365,
      minimumRestorePoints: 4,
    },
    schema: {
      migrationId: "workspace-schema-184",
      sourceSchemaVersion: 183,
      targetSchemaVersion: 184,
      compatibleSourceRange: { minimum: 180, maximum: 184 },
      rollback: {
        runtime: {
          image: {
            id: "projects/images/global/images/papercusp-v1",
            version: "v1",
          },
          schemaVersion: 183,
          compatibleDataRange: { minimum: 180, maximum: 184 },
        },
        data: { strategy: "restore-provider-snapshot" },
      },
    },
    proof: { cadenceDays: 92, lastSuccessfulAt: "2026-05-01T00:00:00.000Z" },
  };
}

describe("workspace-host recovery contract", () => {
  it("composes application backup, provider snapshot, immutable image, migration rollback, and quarterly proof", () => {
    const plan = planWorkspaceHostRecovery(recoverySpec());
    expect(plan.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: "verify-application-backup", dependsOn: [] },
      { id: "verify-provider-snapshot", dependsOn: [] },
      {
        id: "create-restored-data-disk",
        dependsOn: ["verify-application-backup", "verify-provider-snapshot"],
      },
      { id: "create-recovery-vm", dependsOn: ["create-restored-data-disk"] },
      { id: "restore-application-state", dependsOn: ["create-recovery-vm"] },
      {
        id: "validate-version-compatibility",
        dependsOn: ["restore-application-state"],
      },
      {
        id: "apply-schema-migration",
        dependsOn: ["validate-version-compatibility"],
      },
      { id: "attest-recovered-host", dependsOn: ["apply-schema-migration"] },
      { id: "record-restore-proof", dependsOn: ["attest-recovered-host"] },
    ]);
    expect(plan.workspaceId).toBe("workspace-1");
    expect(plan.targetHostId).toBe("host-recovered");
    expect(plan.rollback).toMatchObject({
      trigger: "migration-or-health-failure",
      runtime: {
        image: {
          id: "projects/images/global/images/papercusp-v1",
          version: "v1",
        },
        schemaVersion: 183,
        compatibleDataRange: { minimum: 180, maximum: 184 },
      },
      data: {
        strategy: "restore-provider-snapshot",
        providerSnapshot: plan.providerSnapshot,
        restoredSchemaVersion: 183,
      },
      order: ["rollback-runtime"],
      retainFailedHost: true,
    });
    expect(plan.proof).toMatchObject({ cadenceDays: 92, due: true });
  });

  it("fails closed on in-place restore, incompatible schema, mutable images, or incomplete backup evidence", () => {
    const sameHost = recoverySpec();
    sameHost.desired.hostId = sameHost.sourceHost.hostId;
    expect(() => planWorkspaceHostRecovery(sameHost)).toThrow(
      "distinct target host",
    );

    const incompatible = recoverySpec();
    incompatible.schema.sourceSchemaVersion = 179;
    expect(() => planWorkspaceHostRecovery(incompatible)).toThrow(
      "outside the target release compatibility range",
    );

    const mutable = recoverySpec();
    mutable.desired.image = {
      id: "projects/images/global/images/family/papercusp",
      version: "v2",
    };
    expect(() => planWorkspaceHostRecovery(mutable)).toThrow("immutable image");

    const incomplete = recoverySpec();
    incomplete.applicationBackup.databaseDumpPath = "files-only.tar";
    expect(() => planWorkspaceHostRecovery(incomplete)).toThrow(
      "embedded-Postgres dump",
    );

    const wrongWorkspace = recoverySpec();
    wrongWorkspace.applicationBackup.workspaceId = "workspace-2";
    expect(() => planWorkspaceHostRecovery(wrongWorkspace)).toThrow(
      "preserve the recovery workspaceId",
    );
  });

  it("keeps runtime rollback separate from data restore and refuses an incompatible runtime-only rollback", () => {
    const spec = recoverySpec();
    spec.schema.rollback.runtime.compatibleDataRange.maximum = 183;
    const plan = planWorkspaceHostRecovery(spec);

    expect(plan.rollback.order).toEqual(["restore-data", "rollback-runtime"]);
    expect(() =>
      assertWorkspaceHostRuntimeRollbackSafe(
        plan,
        plan.schema.targetSchemaVersion,
        false,
      ),
    ).toThrow("restore the provider snapshot");
    expect(() =>
      assertWorkspaceHostRuntimeRollbackSafe(
        plan,
        plan.schema.targetSchemaVersion,
        true,
      ),
    ).not.toThrow();
  });

  it("accepts only an exact successful restore proof for the planned target and snapshot", () => {
    const plan = planWorkspaceHostRecovery(recoverySpec());
    const proof: WorkspaceHostRestoreProof = {
      contractVersion: WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
      recoveryId: plan.recoveryId,
      workspaceId: plan.workspaceId,
      sourceSnapshotId: plan.providerSnapshot.providerId,
      targetHostId: plan.targetHostId,
      observedAt: NOW,
      applicationBackupVerified: true,
      providerSnapshotVerified: true,
      dataRestoredFromSnapshot: true,
      migrationApplied: true,
      healthAttested: true,
    };
    expect(validateWorkspaceHostRestoreProof(proof, plan)).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validateWorkspaceHostRestoreProof(
        { ...proof, targetHostId: "wrong-host" },
        plan,
      ),
    ).toEqual({
      ok: false,
      errors: ["restore proof targetHostId mismatch"],
    });
    expect(
      validateWorkspaceHostRestoreProof(
        { ...proof, workspaceId: "wrong-workspace" },
        plan,
      ),
    ).toEqual({
      ok: false,
      errors: ["restore proof workspaceId mismatch"],
    });
  });
});
