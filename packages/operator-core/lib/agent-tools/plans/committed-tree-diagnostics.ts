/** Shared diagnostics contract for committed readers and standalone preflight
 * clients. Keep this type-only: importing the reader implementation here would
 * pull its sidecar/task/DBOS graph into standalone declaration generation. */

import type { ExecFileTiming } from '../../sync-exec-replay';

/** The route and caller PID at the default reader's process boundary. */
export interface BlobBatchSpawnBoundary {
  route: 'sidecar' | 'local';
  /** PID of the process doing the work; local spawn cost is paid by this process. */
  pid: number;
}

export interface CommittedTreeSpawnBoundaryRecord extends BlobBatchSpawnBoundary {
  requestTraceId: string | null;
  toolName: string;
}

/** Bounded per-request timing for one batched `git ls-tree` call. */
export interface CommittedTreeLsTreeRecord {
  repository: string;
  /** Commit and exact argv identity; path names themselves are never retained. */
  commit: string;
  argumentSha256: string;
  pathCount: number;
  pathBytes: number;
  argumentBytes: number;
  recursive: boolean;
  includeSizes: boolean;
  durationMs: number;
  outcome: 'success' | 'error';
  failurePhase?: 'git' | 'parse';
  errorCode?: string;
  gitExecution?: {
    timeoutMs: number;
    route?: 'local' | 'sidecar';
    code?: string | number | null;
    signal?: string | null;
    killed?: boolean;
    timing?: ExecFileTiming;
  };
}

export interface CommittedTreeCallerContext {
  requestTraceId?: string | null;
  toolName: string;
}

/** Request-owned counters, never global cache statistics or a cache reset. */
export interface CommittedTreeDiagnostics {
  schemaVersion: 'committed-tree-diagnostics-v1';
  reads: number;
  /** Unique (repository, blob) lookups PER read; repeated reads add observations. */
  memoHits: number;
  memoMisses: number;
  batchAttempts: number;
  /** Success means every requested blob passed content-address validation. */
  batchSucceeded: number;
  batchFailed: number;
  blobsRequested: number;
  blobsReturned: number;
  blobsVerified: number;
  /** Actual default-reader branch; a supplied reader is classified as injected. */
  batchRoutes: { sidecar: number; local: number; injected: number };
  /** Present only for a caller-scoped probe; records are capped per request. */
  requestTraceId?: string | null;
  toolName?: string;
  spawnBoundaryRecords?: CommittedTreeSpawnBoundaryRecord[];
  spawnBoundaryRecordsDropped?: number;
  /** Present only for a caller-scoped probe; records never retain the path list itself. */
  lsTreeRecords?: CommittedTreeLsTreeRecord[];
  lsTreeRecordsDropped?: number;
}
