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

export type SnapshotTriggerReason =
  | 'manual'
  | 'interval'
  | 'pre_destructive'
  | 'post_run'
  | 'plugin_install'
  | 'secret_change'
  | 'startup';

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

export interface BackupSettings {
  workspaceId: string;
  enabled: boolean;
  cadenceMode: CadenceMode;
  cadenceMinutes: number;
  retentionPreset: RetentionPreset;
  retentionCustom: RetentionPolicy | null;
  eventTriggers: SnapshotTriggerReason[];
  excludedPaths: string[];
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
