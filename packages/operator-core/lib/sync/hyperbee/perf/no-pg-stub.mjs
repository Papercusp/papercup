/**
 * no-pg-stub.mjs — what `@papercusp/db-org` resolves to inside a perf peer-child.
 * See no-pg-hooks.mjs for why. Every export throws: a perf peer that reaches a
 * Postgres path is a RIG DEFECT to surface, not a cost to absorb.
 *
 * ## Why this file lists names at all, and why the list is guarded
 *
 * A named ESM import is bound at INSTANTIATE time, before a single line runs. So a
 * missing name here is not a lazy "throws if you touch it" — it is a hard
 * `SyntaxError: The requested module '@papercusp/db-org' does not provide an export
 * named 'X'` that kills the child during module linking, before it can emit even a
 * boot event. The parent sees only `waitFor('ready')` resolving null after its
 * timeout, and the real one-line cause sits unread in the child's stderr.
 *
 * That is exactly how this broke (WI-761481): `resource-governor/execution.ts` added
 * `import { createDedicatedOrgPg } from '@papercusp/db-org'`, the stub did not export
 * it, and `child-driver.test.ts` failed for days as an opaque 30s timeout on the
 * green-checkpoint gate.
 *
 * So the export list is a SECOND COPY of a truth the operator-core sources own, and it
 * WILL drift — it already did. `no-pg-stub-covers-db-org-imports.test.ts` DERIVES the
 * required set by scanning every `from '@papercusp/db-org'` named import under
 * `packages/operator-core/lib/` and fails if any name is missing here. Add names by
 * making that guard pass, never by hand alone.
 */

const REASON =
  'perf peer-child reached @papercusp/db-org, which is deliberately stubbed out ' +
  '(perf/no-pg-hooks.mjs, plan harden-shared-hive-to-256-peers-2026-06-29 P-012). ' +
  'A perf peer must never query Postgres — it supplies applyOverride / ' +
  'loadRevokedOverride / verifyBindingOverride / announceIdentityOverride for exactly ' +
  'that reason. Either the boot path gained a PG call the override set no longer ' +
  'covers, or this child was spawned for something other than a substrate measurement. ' +
  'Fix the path or the overrides; do not soften this stub, and do not read a run that ' +
  'hit it as a measurement.';

function refuse() {
  throw new Error(REASON);
}

/**
 * One throwing binding per exported name. Kept as a plain function (not a Proxy) on
 * purpose: the job here is to satisfy the LINKER so the child boots far enough to
 * report a real error, then throw loudly if the binding is ever actually called.
 */
const stub = (name) => {
  const fn = () => {
    throw new Error(`${REASON} (reached via \`${name}\`)`);
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
};

// ── Names imported from '@papercusp/db-org' anywhere under packages/operator-core/lib.
// Type-only names are included deliberately: tsx erases them, so an extra binding is
// inert, while a MISSING one is a hard link error. Guarded by
// no-pg-stub-covers-db-org-imports.test.ts — do not prune by hand.
export const _resetForTests = stub('_resetForTests');
export const _resetStoreIdentityForTests = stub('_resetStoreIdentityForTests');
export const buildConnectionOptions = stub('buildConnectionOptions');
export const consumeEvents = stub('consumeEvents');
export const createDedicatedOrgPg = stub('createDedicatedOrgPg');
export const createGoal = stub('createGoal');
export const DbCallDeadlineError = stub('DbCallDeadlineError');
export const DEFAULT_DB_CALL_DEADLINE_MS = stub('DEFAULT_DB_CALL_DEADLINE_MS');
export const DEFAULT_TX_ACQUIRE_DEADLINE_MS = stub('DEFAULT_TX_ACQUIRE_DEADLINE_MS');
export const deleteRoutine = stub('deleteRoutine');
export const describeStoreIdentityMismatch = stub('describeStoreIdentityMismatch');
export const dSql = stub('dSql');
export const endStalePool = stub('endStalePool');
export const fireRoutine = stub('fireRoutine');
export const formatLineageForPrompt = stub('formatLineageForPrompt');
export const generated = stub('generated');
export const getFeatureLineage = stub('getFeatureLineage');
export const getHarnessPg = stub('getHarnessPg');
export const getLegacyClient = stub('getLegacyClient');
export const getOrgPg = stub('getOrgPg');
export const getOrgPgLosslessBigint = stub('getOrgPgLosslessBigint');
export const GOAL_SPEND_SNAPSHOT_SOURCE = stub('GOAL_SPEND_SNAPSHOT_SOURCE');
export const GOAL_SPEND_TICK_SOURCE = stub('GOAL_SPEND_TICK_SOURCE');
export const goalSpend = stub('goalSpend');
export const GoalSpend = stub('GoalSpend');
export const harnessQuery = stub('harnessQuery');
export const HOSTED_SERVICE_ROLE = stub('HOSTED_SERVICE_ROLE');
export const isParkedNextFire = stub('isParkedNextFire');
export const listActiveEphemeralRoutines = stub('listActiveEphemeralRoutines');
export const listDueCronRoutines = stub('listDueCronRoutines');
export const listGoals = stub('listGoals');
export const listInProcessSweepRoutines = stub('listInProcessSweepRoutines');
export const listUnconsumedEvents = stub('listUnconsumedEvents');
export const longLivedPoolConnectionOptions = stub('longLivedPoolConnectionOptions');
export const normalizeNextFireAt = stub('normalizeNextFireAt');
export const ObservedStoreIdentity = stub('ObservedStoreIdentity');
export const orgPg = stub('orgPg');
export const parseStoreIdentity = stub('parseStoreIdentity');
export const PG_BIGINT_AS_NUMBER_TYPES = stub('PG_BIGINT_AS_NUMBER_TYPES');
export const pgbouncerEnabled = stub('pgbouncerEnabled');
export const pinOrVerifyStoreIdentity = stub('pinOrVerifyStoreIdentity');
export const poolIdleTimeoutSec = stub('poolIdleTimeoutSec');
export const potsForGoal = stub('potsForGoal');
export const recordEphemeralFire = stub('recordEphemeralFire');
export const retryOnRetryableDbDeadline = stub('retryOnRetryableDbDeadline');
export const RoutineRow = stub('RoutineRow');
export const schemaOf = stub('schemaOf');
export const SerializableRetryOptions = stub('SerializableRetryOptions');
export const setAdminPoolStatementTimeoutProvider = stub('setAdminPoolStatementTimeoutProvider');
export const setRoutineActive = stub('setRoutineActive');
export const setRoutinesPerWorkspaceConflict = stub('setRoutinesPerWorkspaceConflict');
export const slugToSchemaName = stub('slugToSchemaName');
export const STORE_IDENTITY_SQL = stub('STORE_IDENTITY_SQL');
export const storeIdentityViolation = stub('storeIdentityViolation');
export const typedSql = stub('typedSql');
export const upsertRoutine = stub('upsertRoutine');
export const VerifiedTenantServerContext = stub('VerifiedTenantServerContext');
export const withAcquisitionDeadline = stub('withAcquisitionDeadline');
export const withDbCallDeadline = stub('withDbCallDeadline');
export const withHostedServiceContext = stub('withHostedServiceContext');
export const withSerializableRetry = stub('withSerializableRetry');
export const withTenantContext = stub('withTenantContext');
export const withWorkspace = stub('withWorkspace');
export const withWorkspaceLegacy = stub('withWorkspaceLegacy');
export const withWorkspaceQuery = stub('withWorkspaceQuery');

export default new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined; // never look thenable to `await import(...)`
      return refuse;
    },
  },
);
