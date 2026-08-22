/**
 * no-pg-stub.mjs — what `@papercusp/db-org` resolves to inside a perf peer-child.
 * See no-pg-hooks.mjs for why. Every export throws: a perf peer that reaches a
 * Postgres path is a RIG DEFECT to surface, not a cost to absorb.
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

export const getOrgPg = refuse;
export const orgPg = refuse;
export default new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined; // never look thenable to `await import(...)`
      return refuse;
    },
  },
);
