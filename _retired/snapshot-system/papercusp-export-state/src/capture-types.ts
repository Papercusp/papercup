import type { CaptureOptions } from './denylist';
import type { SnapshotManifest } from './manifest';

export type DrainMode = 'interactive' | 'autosave' | 'autonomous';

export interface CaptureRequest {
  harnessSlug: string;
  projectDir: string;
  template: { name: string; version: string };
  substrateVersion: string;
  /** Substrate's current schema version (read by caller). */
  schemaVersionDb: number;
  /** Minimum substrate version required to restore. Spec'd by caller. */
  minSubstrateVersion: string;
  name: string;
  description?: string;
  license: string;
  /** Per-harness plugin enablement at capture time. */
  plugins: { name: string; version: string; capabilities: string[]; configJson: string; shapeJson?: string; pluginVersionPinned?: boolean }[];
  /** Filesystem opt-ins (`.git/`, agent transcripts, operator notes). */
  capture?: CaptureOptions;
  drainMode: DrainMode;
  /** Override DB URL; default reads `HARNESS_ADMIN_DATABASE_URL` / `HARNESS_DATABASE_URL`. */
  databaseUrl?: string;
  /** True → re-tier-A scan still proceeds, but verified hits become warnings, not blocks. Off by default. */
  acceptVerifiedSecrets?: boolean;
  /** True → 200 MB soft cap is bypassed (1 GB hard cap still enforced). */
  acceptSoftCap?: boolean;
  onProgress?: (p: CaptureProgress) => void;
  signal?: AbortSignal;
}

export interface CaptureProgress {
  phase:
    | 'precheck'
    | 'stage'
    | 'pg-dump-per-harness'
    | 'pg-dump-shared'
    | 'fs-walk'
    | 'secret-scan-tier-a'
    | 'secret-scan-tier-b'
    | 'manifest'
    | 'tar'
    | 'cleanup'
    | 'done';
  message: string;
  /** 0..1, optional. */
  progress?: number;
}

export interface CaptureResult {
  manifest: SnapshotManifest;
  tarballPath: string;
  bytesCompressed: number;
  durationMs: number;
  /** Anything the caller (UI) should surface as a warning. */
  warnings: string[];
}

export interface VerifiedSecretHit {
  file: string;
  line?: number;
  detector: string;
  redactedSnippet: string;
}

export interface SecretScanResult {
  verifiedHits: VerifiedSecretHit[];
  highRecallHits: VerifiedSecretHit[];
}
