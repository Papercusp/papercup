export const PASSING_TASK_VERDICT_CACHE_VERSION: number;
export const PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION: string;
export const PASSING_TASK_VERDICT_CACHE_MAX_GROUPS: number;

export interface PassingTaskVerdictIdentity {
  taskKey: string;
  fingerprint: string;
  components: {
    command: string;
    environment: string;
    gateConfig: string;
    implementation: string;
    dependencyClosure: string;
  };
}

export interface PassingTaskVerdictCache {
  version: number;
  groups: Record<string, {
    updatedAt: string;
    entries: Record<string, {
      fingerprint: string;
      components: PassingTaskVerdictIdentity["components"];
      passedAt: string;
    }>;
  }>;
}

export function stableJson(value: unknown): string;
export function passingTaskVerdictIdentityEnvironment(
  environment: Record<string, unknown>,
): {
  environment: Record<string, unknown>;
  proofGroupApplied: boolean;
  cacheGroup: string | null;
};
export function formatPassingTaskVerdictSummary(
  decisions: Array<{ status?: string; reason?: string }>,
  options?: { proofGroupApplied?: boolean; cacheGroup?: string | null },
): string;
export function emptyPassingTaskVerdictCache(): PassingTaskVerdictCache;
export function readPassingTaskVerdictCache(path: string): {
  cache: PassingTaskVerdictCache;
  reason: string;
};
export function writePassingTaskVerdictCacheAtomic(
  path: string,
  cache: PassingTaskVerdictCache,
  nonce?: string,
): void;
export function passingTaskVerdictCacheEntry(
  cache: PassingTaskVerdictCache,
  cacheGroup: string | null,
  taskKey: string,
): PassingTaskVerdictCache["groups"][string]["entries"][string] | undefined;
export function hashDependencyFileSet(args: {
  root: string;
  files: string[];
  unavailable?: string[];
  digestCache?: Map<string, unknown>;
}):
  | { ok: true; hash: string; fileCount: number }
  | { ok: false; reason: string };
export function passingTaskVerdictDependencyProvenance(args: {
  root: string;
  taskKey: string;
  script: string;
  workspaceName: string;
  workspaces: Map<string, { dir: string; deps: string[] }>;
  trackedScan: { files: string[]; unscannedPresent: string[] };
  repoWideTaskKeys: Set<string>;
  digestCache?: Map<string, unknown>;
}):
  | { ok: true; hash: string; fileCount: number }
  | { ok: false; reason: string };
export function shouldStorePassingTaskVerdict(args: {
  enabled: boolean;
  cacheStatus?: string;
  initialStatus?: number | null;
  finalStatus?: number | null;
  absorptionRan: boolean;
  identity?: PassingTaskVerdictIdentity | null;
}): boolean;
export function buildPassingTaskVerdictIdentity(args: {
  taskKey: string;
  command: unknown;
  environment: unknown;
  gateConfig: unknown;
  dependencyHash: string;
  implementationVersion?: string;
}): PassingTaskVerdictIdentity;
export function decidePassingTaskVerdict(args: {
  enabled: boolean;
  cacheRead?: { reason: string };
  entry?: PassingTaskVerdictCache["groups"][string]["entries"][string];
  identity?: PassingTaskVerdictIdentity | null;
}): { hit: boolean; reason: string };
export function passingTaskVerdictEntry(
  identity: PassingTaskVerdictIdentity,
  passedAt?: string,
): PassingTaskVerdictCache["groups"][string]["entries"][string];
export function mergePassingTaskVerdictUpdates(
  cache: PassingTaskVerdictCache,
  cacheGroup: string | null,
  updates: PassingTaskVerdictCache["groups"][string]["entries"],
  updatedAt?: string,
): PassingTaskVerdictCache;
