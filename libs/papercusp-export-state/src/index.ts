export {
  SHARED_TABLE_FILTERS,
  findSharedTableFilter,
  includedSharedTables,
  excludedSharedTables,
  assertValidSlug,
  type SharedTableFilter,
} from './shared-table-filters';
export {
  SNAPSHOT_SCHEMA_VERSION,
  validateSnapshotManifest,
  newSnapshotId,
  newForkSlugSuffix,
  type SnapshotManifest,
  type SnapshotKind,
  type SnapshotPlugin,
  type SnapshotProvenance,
} from './manifest';
export {
  DEFAULT_DENY,
  OPT_IN_INCLUDE,
  effectiveDenylist,
  matchDeny,
  type DenyMatcher,
  type CaptureOptions,
} from './denylist';
export {
  probeBinary,
  probeAll,
  ensureRequiredForCapture,
  type BinaryCheck,
} from './binaries';
export { snapshotsDir, snapshotPath, stagingDir } from './paths';
export {
  resolveDatabaseUrl,
  pgDumpPerHarness,
  pgDumpSharedSchema,
  copyFilteredSharedTables,
  dbCapture,
} from './pg-dump';
export {
  stageProjectFiles,
  stageHarnessSubset,
  SnapshotTooLargeError,
  type StageEntry,
  type StagedFs,
} from './staging';
export {
  scanForSecrets,
  trufflehogVerified,
  gitleaksHighRecall,
  VerifiedSecretsBlocked,
} from './secret-scan';
export { sha256OfFile, buildFileEntries } from './canonical-hash';
export { tarGzipStaging } from './tarball';
export { capture } from './capture';
export type {
  CaptureRequest,
  CaptureResult,
  CaptureProgress,
  DrainMode,
  SecretScanResult,
  VerifiedSecretHit,
} from './capture-types';

// Restore surface (§15.6).
export {
  readManifestFromTarball,
  readManifestFromPath,
  checkCompat,
  compareSemver,
  formatCompatReport,
  type CompatReport,
} from './compat';
export {
  verifyTarballSidecar,
  extractTarball,
  verifyPerFileHashes,
} from './extract';
export {
  schemaExists,
  takeRestoreLock,
  releaseRestoreLock,
  rewritePgDump,
  applyPerHarnessDump,
  TargetSchemaExists,
} from './alter-schema';
export { applyHarnessSharedRestore } from './shared-row-restore';
export { rewriteSlugInDir, rewriteText, type SlugRewriteResult } from './slug-rewrite';
export {
  buildConsentSummary,
  readInstalledPluginCaps,
  persistPluginConfigs,
  type ConsentSummary,
} from './plugin-reenable';
export { restore, postRestoreChecklist } from './restore';
export type {
  RestoreRequest,
  RestoreResult,
  RestoreProgress,
  SlugRewriteAmbiguous,
} from './restore-types';
