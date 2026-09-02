/**
 * citation-deployment-probe-scope.test.ts — EI-22181490624100467.
 *
 * `probeCitationDeployment` puts a capped-but-real fan-out of FORKED GIT READS
 * (each possibly probing systemd + an HTTP health endpoint) behind
 * `evaluatePlanAcceptanceGate`. That gate is called:
 *
 *   - per plan by the `planAcceptanceGateVerdict` SYNC RESOLVER — every UI read
 *   - per plan by the acceptance-grading SWEEP routine — periodically
 *   - once by `plans:set-plan-status` — the rare SHIP write
 *
 * Only the last may opt in. This guard exists because the failure it prevents is
 * INVISIBLE in ordinary testing: opting in from a hot path breaks no assertion and
 * changes no output — it just quietly moves forked git reads onto a render path,
 * which is this repo's A1-class perf anti-pattern and would be found in production,
 * as load, not as a red test.
 *
 * Scanning source text is deliberate: the property is "which call sites pass this
 * argument", which is a fact about the CALLERS, not about any one function's return.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = join(__dirname);
const FLAG = 'probeCitationDeployment';

const SHIP_WRITE = 'agent-tools/plans/set-plan-status.ts';
const HOT_CALLERS = [
  'sync-resolver/plan-acceptance-gate-verdict.ts',
  'harness/routines/acceptance-grading-sweep-action.ts',
  'unshipped-plans-audit.ts',
];

const read = (rel: string) => readFileSync(join(LIB, rel), 'utf8');

describe('citation deployment probe stays off the hot paths', () => {
  it('the ship write opts in (positive control)', () => {
    // Without this control every absence assertion below would also pass if the
    // flag had simply been renamed or deleted everywhere.
    expect(read(SHIP_WRITE)).toContain(FLAG);
  });

  it.each(HOT_CALLERS)('%s never opts in', (rel) => {
    expect(read(rel)).not.toContain(FLAG);
  });

  it('no caller outside the ship write enables it', () => {
    // The gate module itself declares and reads the option; that is not a call site.
    const optedIn = [SHIP_WRITE, ...HOT_CALLERS].filter((rel) => read(rel).includes(FLAG));
    expect(optedIn).toEqual([SHIP_WRITE]);
  });
});
