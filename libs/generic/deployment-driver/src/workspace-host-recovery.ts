import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostImageRef,
  WorkspaceHostRef,
  WorkspaceHostSnapshotRef,
} from "./workspace-host-types";

export const WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION =
  "papercusp-workspace-host-recovery-v1";
export const WORKSPACE_HOST_RECOVERY_MAX_PROOF_CADENCE_DAYS = 92;

/** Persisted identity of an application-consistent @papercusp/backup snapshot. */
export interface WorkspaceHostApplicationBackupRef {
  system: "@papercusp/backup";
  workspaceId: string;
  snapshotId: number;
  kopiaSnapshotId: string;
  status: "ok";
  capturedAt: string;
  verifiedAt: string;
  /** Must name the pre-snapshot embedded-Postgres dump captured with the files. */
  databaseDumpPath: string;
  sources: readonly string[];
}

export interface WorkspaceHostProviderSnapshotPolicy {
  snapshot: WorkspaceHostSnapshotRef;
  encrypted: true;
  retentionDays: number;
  minimumRestorePoints: number;
}

export interface WorkspaceHostSchemaRecoveryContract {
  migrationId: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  compatibleSourceRange: { minimum: number; maximum: number };
  /**
   * Runtime rollback and data rollback are deliberately separate. An older runtime may be
   * restarted against the current data only when that schema is inside this explicit range;
   * otherwise the provider snapshot must be restored first.
   */
  rollback: {
    runtime: {
      image: WorkspaceHostImageRef & { version: string };
      schemaVersion: number;
      compatibleDataRange: { minimum: number; maximum: number };
    };
    data: {
      strategy: "restore-provider-snapshot";
    };
  };
}

export interface WorkspaceHostRestoreProofPolicy {
  cadenceDays: number;
  lastSuccessfulAt?: string;
}

export interface WorkspaceHostRecoverySpec {
  contractVersion: typeof WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION;
  recoveryId: string;
  /** Stable customer Workspace/data identity retained across replacement Hosts. */
  workspaceId: string;
  requestedAt: string;
  sourceHost: WorkspaceHostRef;
  desired: WorkspaceHostDesiredSpec;
  applicationBackup: WorkspaceHostApplicationBackupRef;
  providerSnapshot: WorkspaceHostProviderSnapshotPolicy;
  schema: WorkspaceHostSchemaRecoveryContract;
  proof: WorkspaceHostRestoreProofPolicy;
}

export const WORKSPACE_HOST_RECOVERY_PHASES = [
  "verify-application-backup",
  "verify-provider-snapshot",
  "create-restored-data-disk",
  "create-recovery-vm",
  "restore-application-state",
  "validate-version-compatibility",
  "apply-schema-migration",
  "attest-recovered-host",
  "record-restore-proof",
] as const;
export type WorkspaceHostRecoveryPhase =
  (typeof WORKSPACE_HOST_RECOVERY_PHASES)[number];

export interface WorkspaceHostRecoveryStep {
  id: WorkspaceHostRecoveryPhase;
  dependsOn: readonly WorkspaceHostRecoveryPhase[];
  destructive: false;
}

export interface WorkspaceHostRecoveryPlan {
  contractVersion: typeof WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION;
  recoveryId: string;
  workspaceId: string;
  sourceHostId: string;
  targetHostId: string;
  targetImage: WorkspaceHostImageRef & { version: string };
  providerSnapshot: WorkspaceHostSnapshotRef;
  applicationBackup: WorkspaceHostApplicationBackupRef;
  steps: readonly WorkspaceHostRecoveryStep[];
  rollback: {
    trigger: "migration-or-health-failure";
    runtime: {
      image: WorkspaceHostImageRef & { version: string };
      schemaVersion: number;
      compatibleDataRange: { minimum: number; maximum: number };
    };
    data: {
      strategy: "restore-provider-snapshot";
      providerSnapshot: WorkspaceHostSnapshotRef;
      restoredSchemaVersion: number;
    };
    /** Data restore MUST precede runtime rollback when the migrated schema is incompatible. */
    order: readonly ("restore-data" | "rollback-runtime")[];
    retainFailedHost: true;
  };
  proof: {
    cadenceDays: number;
    due: boolean;
    nextDueAt?: string;
  };
}

export interface WorkspaceHostRestoreProof {
  contractVersion: typeof WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION;
  recoveryId: string;
  workspaceId: string;
  sourceSnapshotId: string;
  targetHostId: string;
  observedAt: string;
  applicationBackupVerified: true;
  providerSnapshotVerified: true;
  dataRestoredFromSnapshot: true;
  migrationApplied: true;
  healthAttested: true;
}

export interface WorkspaceHostRestoreProofValidation {
  ok: boolean;
  errors: readonly string[];
}

/**
 * Refuse a runtime-only rollback when the older runtime cannot read the schema currently on disk.
 * Supplying `dataRestored:true` means the separately modelled provider-snapshot restore has already
 * returned the disk to `sourceSchemaVersion`; that version is validated against the runtime range
 * when the plan is built.
 */
export function assertWorkspaceHostRuntimeRollbackSafe(
  plan: WorkspaceHostRecoveryPlan,
  currentSchemaVersion: number,
  dataRestored: boolean,
): void {
  const current = version(currentSchemaVersion, "currentSchemaVersion");
  const range = plan.rollback.runtime.compatibleDataRange;
  if (current >= range.minimum && current <= range.maximum) return;
  if (dataRestored && plan.schema.sourceSchemaVersion >= range.minimum && plan.schema.sourceSchemaVersion <= range.maximum) {
    return;
  }
  throw new Error(
    "runtime rollback refused: current data schema is incompatible; restore the provider snapshot before starting the older runtime",
  );
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function required(value: string, path: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${path} must be a non-empty string`);
  return normalized;
}

function timestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${path} must be an ISO timestamp`);
  return parsed;
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value;
}

function version(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function immutableImage(
  image: WorkspaceHostImageRef,
  path: string,
): WorkspaceHostImageRef & { version: string } {
  const id = required(image.id, `${path}.id`);
  const imageVersion = required(image.version ?? "", `${path}.version`);
  if (/\/images\/family\//i.test(id) || /(?:^|[/_-])latest$/i.test(id)) {
    throw new Error(
      `${path}.id must identify an immutable image, not a family/latest alias`,
    );
  }
  return { id, version: imageVersion };
}

function recoverySteps(): readonly WorkspaceHostRecoveryStep[] {
  return [
    { id: "verify-application-backup", dependsOn: [], destructive: false },
    { id: "verify-provider-snapshot", dependsOn: [], destructive: false },
    {
      id: "create-restored-data-disk",
      dependsOn: ["verify-application-backup", "verify-provider-snapshot"],
      destructive: false,
    },
    {
      id: "create-recovery-vm",
      dependsOn: ["create-restored-data-disk"],
      destructive: false,
    },
    {
      id: "restore-application-state",
      dependsOn: ["create-recovery-vm"],
      destructive: false,
    },
    {
      id: "validate-version-compatibility",
      dependsOn: ["restore-application-state"],
      destructive: false,
    },
    {
      id: "apply-schema-migration",
      dependsOn: ["validate-version-compatibility"],
      destructive: false,
    },
    {
      id: "attest-recovered-host",
      dependsOn: ["apply-schema-migration"],
      destructive: false,
    },
    {
      id: "record-restore-proof",
      dependsOn: ["attest-recovered-host"],
      destructive: false,
    },
  ];
}

/**
 * Join existing backup, provider snapshot, immutable-image, bootstrap migration,
 * and durable-workflow identities into one fail-closed recovery plan.
 */
export function planWorkspaceHostRecovery(
  spec: WorkspaceHostRecoverySpec,
): WorkspaceHostRecoveryPlan {
  if (spec.contractVersion !== WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION) {
    throw new Error(
      `contractVersion must be '${WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION}'`,
    );
  }
  const recoveryId = required(spec.recoveryId, "recoveryId");
  const requestedAt = timestamp(spec.requestedAt, "requestedAt");
  const sourceHostId = required(spec.sourceHost.hostId, "sourceHost.hostId");
  const targetHostId = required(spec.desired.hostId, "desired.hostId");
  if (sourceHostId === targetHostId) {
    throw new Error(
      "recovery must create a distinct target host and leave the source host intact",
    );
  }
  if (spec.sourceHost.target !== spec.desired.target) {
    throw new Error("sourceHost.target must match desired.target");
  }
  if (!spec.desired.data.encrypted)
    throw new Error("desired recovery data must be encrypted");

  const backup = spec.applicationBackup;
  if (backup.system !== "@papercusp/backup" || backup.status !== "ok") {
    throw new Error(
      "applicationBackup must be an ok @papercusp/backup snapshot",
    );
  }
  required(backup.workspaceId, "applicationBackup.workspaceId");
  positiveInteger(backup.snapshotId, "applicationBackup.snapshotId");
  required(backup.kopiaSnapshotId, "applicationBackup.kopiaSnapshotId");
  timestamp(backup.capturedAt, "applicationBackup.capturedAt");
  const verifiedAt = timestamp(
    backup.verifiedAt,
    "applicationBackup.verifiedAt",
  );
  if (verifiedAt > requestedAt)
    throw new Error("applicationBackup.verifiedAt cannot be after requestedAt");
  if (!backup.databaseDumpPath.endsWith("/pg-embedded.sql.gz")) {
    throw new Error(
      "applicationBackup.databaseDumpPath must name the captured embedded-Postgres dump",
    );
  }
  if (backup.sources.length === 0)
    throw new Error("applicationBackup.sources must not be empty");

  const policy = spec.providerSnapshot;
  if (policy.encrypted !== true)
    throw new Error("providerSnapshot must be encrypted");
  positiveInteger(policy.retentionDays, "providerSnapshot.retentionDays");
  positiveInteger(
    policy.minimumRestorePoints,
    "providerSnapshot.minimumRestorePoints",
  );
  const snapshot = policy.snapshot;
  required(snapshot.providerId, "providerSnapshot.snapshot.providerId");
  if (
    snapshot.target !== spec.sourceHost.target ||
    snapshot.hostId !== sourceHostId
  ) {
    throw new Error(
      "provider snapshot must belong to the exact source host and provider",
    );
  }
  if (snapshot.createdAt)
    timestamp(snapshot.createdAt, "providerSnapshot.snapshot.createdAt");
  if (
    snapshot.retainUntil &&
    timestamp(snapshot.retainUntil, "providerSnapshot.snapshot.retainUntil") <=
      requestedAt
  ) {
    throw new Error(
      "provider snapshot retention must extend beyond requestedAt",
    );
  }

  const targetImage = immutableImage(spec.desired.image, "desired.image");
  const rollbackImage = immutableImage(
    spec.schema.rollbackImage,
    "schema.rollbackImage",
  );
  const sourceSchema = version(
    spec.schema.sourceSchemaVersion,
    "schema.sourceSchemaVersion",
  );
  const targetSchema = version(
    spec.schema.targetSchemaVersion,
    "schema.targetSchemaVersion",
  );
  const minimum = version(
    spec.schema.compatibleSourceRange.minimum,
    "schema.compatibleSourceRange.minimum",
  );
  const maximum = version(
    spec.schema.compatibleSourceRange.maximum,
    "schema.compatibleSourceRange.maximum",
  );
  if (minimum > maximum || sourceSchema < minimum || sourceSchema > maximum) {
    throw new Error(
      "source schema version is outside the target release compatibility range",
    );
  }
  if (targetSchema < sourceSchema)
    throw new Error(
      "target schema version must not precede the source schema version",
    );
  required(spec.schema.migrationId, "schema.migrationId");

  const cadenceDays = positiveInteger(
    spec.proof.cadenceDays,
    "proof.cadenceDays",
  );
  if (cadenceDays > WORKSPACE_HOST_RECOVERY_MAX_PROOF_CADENCE_DAYS) {
    throw new Error(
      `proof.cadenceDays must be at most ${WORKSPACE_HOST_RECOVERY_MAX_PROOF_CADENCE_DAYS}`,
    );
  }
  const lastSuccessfulAt = spec.proof.lastSuccessfulAt
    ? timestamp(spec.proof.lastSuccessfulAt, "proof.lastSuccessfulAt")
    : undefined;
  const nextDueMs =
    lastSuccessfulAt === undefined
      ? undefined
      : lastSuccessfulAt + cadenceDays * DAY_MS;

  return {
    contractVersion: WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
    recoveryId,
    sourceHostId,
    targetHostId,
    targetImage,
    providerSnapshot: snapshot,
    applicationBackup: backup,
    steps: recoverySteps(),
    rollback: {
      trigger: "migration-or-health-failure",
      image: rollbackImage,
      providerSnapshot: snapshot,
      retainFailedHost: true,
    },
    proof: {
      cadenceDays,
      due: nextDueMs === undefined || requestedAt >= nextDueMs,
      ...(nextDueMs === undefined
        ? {}
        : { nextDueAt: new Date(nextDueMs).toISOString() }),
    },
  };
}

/** Validate the exact evidence that closes a scheduled restore exercise. */
export function validateWorkspaceHostRestoreProof(
  proof: unknown,
  plan: WorkspaceHostRecoveryPlan,
): WorkspaceHostRestoreProofValidation {
  const errors: string[] = [];
  if (!proof || typeof proof !== "object")
    return { ok: false, errors: ["restore proof has an invalid shape"] };
  const candidate = proof as Partial<WorkspaceHostRestoreProof>;
  if (candidate.contractVersion !== WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION) {
    errors.push("restore proof contractVersion mismatch");
  }
  if (candidate.recoveryId !== plan.recoveryId)
    errors.push("restore proof recoveryId mismatch");
  if (candidate.sourceSnapshotId !== plan.providerSnapshot.providerId) {
    errors.push("restore proof sourceSnapshotId mismatch");
  }
  if (candidate.targetHostId !== plan.targetHostId)
    errors.push("restore proof targetHostId mismatch");
  if (
    !candidate.observedAt ||
    !Number.isFinite(Date.parse(candidate.observedAt))
  ) {
    errors.push("restore proof observedAt must be an ISO timestamp");
  }
  for (const field of [
    "applicationBackupVerified",
    "providerSnapshotVerified",
    "migrationApplied",
    "healthAttested",
  ] as const) {
    if (candidate[field] !== true)
      errors.push(`restore proof ${field} must be true`);
  }
  return { ok: errors.length === 0, errors };
}
