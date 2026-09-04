import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_HOST_HEALTH_STATUSES } from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

/**
 * WI-2143924: the TS `WorkspaceHostHealthStatus` union and the Postgres CHECK constraint on
 * `harness_shared.workspace_hosts.health_status` are two copies of one truth, and nothing
 * made them agree. Widening the union alone typechecks perfectly and then fails at RUNTIME
 * on the first INSERT — a `violates check constraint` from a layer the compiler never sees.
 * That is the same shape as the defect this guard was written for: the nominal subject was
 * right and the layer underneath was measuring something else.
 *
 * The subject here is the GENERATED schema mirror, which `pull-schema.mjs` regenerates from
 * the live database — so this compares the type against what Postgres actually enforces, not
 * against a migration file that a later migration may have superseded.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const GENERATED_SCHEMA = join(REPO_ROOT, 'libs', 'papercusp', 'libs', 'db', 'src', 'schema', 'generated.ts');
const CONSTRAINT_NAME = 'workspace_hosts_health_status_check';

function healthStatusesAcceptedByPostgres(): readonly string[] {
  const source = readFileSync(GENERATED_SCHEMA, 'utf8');
  const line = source.split('\n').find((candidate) => candidate.includes(CONSTRAINT_NAME));
  // Never let a failed lookup read as agreement: an absent constraint and an empty accepted
  // set are indistinguishable downstream, and "the grep found nothing" is precisely how a
  // parity guard reports a false pass.
  if (!line) {
    throw new Error(
      `${CONSTRAINT_NAME} not found in ${GENERATED_SCHEMA}. Either the constraint was dropped, or it was ` +
        'renamed and this guard is now measuring nothing — resolve it before trusting any health-status verdict.',
    );
  }
  const literals = [...line.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]);
  if (literals.length === 0) {
    throw new Error(`${CONSTRAINT_NAME} was found but no accepted literals could be parsed from: ${line.trim()}`);
  }
  return literals;
}

describe('workspace-host health_status: TS union vs the Postgres CHECK constraint', () => {
  it('accepts exactly the statuses the type declares', () => {
    expect([...healthStatusesAcceptedByPostgres()].sort()).toEqual([...WORKSPACE_HOST_HEALTH_STATUSES].sort());
  });

  it("includes 'unknown' — the status a provider must report for an unmeasured check", () => {
    // Pinned on its own: this is the value migration 1102 added, and the one whose absence
    // forced every provider to coerce an unmeasured signal into a verdict it had not earned.
    expect(healthStatusesAcceptedByPostgres()).toContain('unknown');
    expect(WORKSPACE_HOST_HEALTH_STATUSES).toContain('unknown');
  });
});
