export type CadenceMode = 'event' | 'interval' | 'both';

export type RetentionPreset = 'aggressive' | 'default' | 'conservative' | 'custom';

export interface RetentionPolicy {
  keepLatest: number;
  keepHourly: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export const RETENTION_PRESETS: Record<Exclude<RetentionPreset, 'custom'>, RetentionPolicy> = {
  aggressive:   { keepLatest: 100, keepHourly: 24, keepDaily: 7,   keepWeekly: 4,  keepMonthly: 3  },
  default:      { keepLatest: 200, keepHourly: 48, keepDaily: 30,  keepWeekly: 12, keepMonthly: 12 },
  conservative: { keepLatest: 500, keepHourly: 96, keepDaily: 90,  keepWeekly: 26, keepMonthly: 36 },
};

/**
 * Why a snapshot was taken.
 *
 * `manual` and `interval` are intrinsic to this package — the scheduler
 * produces them, and they're excluded from the event-trigger surface
 * (see `scheduler.ts`). Every other reason is an EVENT trigger owned by
 * the embedding application's lifecycle, so the type is left open
 * (`string & {}`) rather than enumerating harness-specific reasons here
 * (P-024). The operator's current event vocabulary: `pre_destructive`,
 * `post_run`, `plugin_install`, `secret_change`, `startup`.
 */
export type SnapshotTriggerReason = 'manual' | 'interval' | (string & {});

export interface SnapshotInfo {
  id: number;
  kopiaSnapshotId: string | null;
  workspaceId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'failed' | 'aborted';
  triggerReason: SnapshotTriggerReason;
  triggerContext: Record<string, unknown> | null;
  bytesAdded: number | null;
  bytesTotal: number | null;
  sources: string[];
  error: string | null;
}

export type DestinationType = 'local' | 'local+s3' | 'local+b2' | 'local+rclone';

export interface BackupSettings {
  workspaceId: string;
  enabled: boolean;
  cadenceMode: CadenceMode;
  cadenceMinutes: number;
  retentionPreset: RetentionPreset;
  retentionCustom: RetentionPolicy | null;
  eventTriggers: SnapshotTriggerReason[];
  excludedPaths: string[];
  destinationType: DestinationType;
  /** Truthy iff a destination config is stored (UI doesn't get the secrets). */
  destinationConfigured: boolean;
}

export interface RepoStats {
  totalSnapshots: number;
  bytesOnDisk: number;
  bytesRaw: number;
  dedupRatio: number;
  lastSnapshotAt: string | null;
  lastFailureAt: string | null;
}

export interface SnapshotResult {
  snapshotId: number;
  kopiaSnapshotId: string;
  bytesAdded: number;
  durationMs: number;
}

export interface RestoreResult {
  targetPath: string;
  bytesRestored: number;
  fileCount: number;
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Generic, zero-dependency durability seam (dbos-durable-flows-adoption
 * D-010 / P-011). A host can inject an implementation that wraps each named
 * sub-operation as a durable, checkpointed step — e.g. the operator maps
 * `runStep → DBOS.runStep` so a crash mid-op RESUMES from the last completed
 * step instead of re-running the whole flow. Without a host wired the default
 * `passthroughStepRunner` simply runs `fn()`, so the package's behavior is
 * IDENTICAL when nothing is injected.
 *
 * The seam is deliberately generic — it names nothing about backups or DBOS —
 * so any other borrowable lib wanting optional durability can adopt the same
 * one-method contract. This is what lets `@papercusp/backup` keep its "zero
 * @papercusp/@restart runtime deps" borrowable contract while still gaining
 * crash-resume when hosted: DBOS lives entirely host-side, injected here.
 *
 * IMPORTANT — necessary but not sufficient: a StepRunner only buys crash-RESUME
 * when each `fn` is idempotent (replaying a completed step must be a no-op).
 * `snapshot()` (content-addressed kopia create) is ~idempotent and gains
 * durability from the seam alone; the destructive restore/promote/rollback ops
 * are non-idempotent FS renames and need idempotent decomposition first (P-012)
 * before routing them through here pays off.
 */
export interface StepRunner {
  /**
   * Run `fn` as a single durable step labelled `name`. The default
   * implementation just awaits `fn()`; a host implementation checkpoints the
   * result so a resume returns the recorded value without re-running `fn`.
   */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Default seam: identical behavior to calling `fn()` directly (no host wired). */
export const passthroughStepRunner: StepRunner = {
  runStep: (_name, fn) => fn(),
};
