/**
 * Hyperbee sync substrate — public exports.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * This is the entry point the rest of the operator imports from.
 * Sub-modules are implementation details and can change without
 * breaking consumers.
 */

export {
  getHarnessStore,
  closeHarnessStore,
  type HarnessStoreOpts,
} from './corestore';

export {
  createAutobaseHarness,
  type OpEnvelope,
  type AutobaseHarnessHandle,
  type CreateAutobaseOpts,
} from './autobase-setup';

export {
  CURRENT_SCHEMA_VERSION,
  acceptOpVersion,
  getKnownMaxSchemaVersion,
  schemaVersionEvents,
  type SchemaVersionAlert,
} from './schema-version';

export {
  markSqlMigrationsComplete,
  markRuntimeEnsureComplete,
  isReadyForProjection,
  awaitEnsurePaths,
  BootGateTimeoutError,
} from './boot-gate';

export {
  registerProjection,
  getProjection,
  applyHyperbeeOpToPg,
  lwwPick,
  type TableProjection,
} from './projection';
