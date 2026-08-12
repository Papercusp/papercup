/**
 * The provenance re-derivation lane must actually RUN (WI-38135).
 *
 * WHY THIS TEST EXISTS, AND WHY IT LOOKS LIKE A GREP RATHER THAN A UNIT TEST.
 * `backfillTurnProvenanceOnce` was correct, exported, covered by its own unit
 * tests — and had ZERO production call sites for its entire life. Every test
 * that exercises the function directly passed the whole time, because they
 * supply the caller the codebase never did. The defect was not in the function;
 * it was in the absence of anyone invoking it, and that is invisible to any
 * test that calls it itself.
 *
 * Measured cost of that gap when it was found: 370,478 session_turns rows (96%
 * of the table) never classified, plus 2,435 stranded at an older catalogue
 * version. `turn_origin_verdict='owner-typed'` is the RESIDUAL of a versioned
 * deny-list — "no rule matched", not positive evidence the owner spoke — so
 * unswept rows keep asserting the owner said something he did not, with a
 * stored column's authority behind it (EI-20135573616431912).
 *
 * So the property under test is deliberately structural: SOMETHING in
 * production must call the entry point, and it must be reachable from the
 * scheduler. Deleting the tick makes this fail; renaming the function without
 * updating the tick makes this fail.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPERATOR_CORE_LIB = join(HERE, '..');

/** The schedulable entry point. Not the batch primitive it wraps — that one is
 *  legitimately called only from here and from tests. */
const ENTRY_POINT = 'runTurnProvenanceBackfillOnce';

/** Where the tick is expected to live. Kept explicit rather than scanning the
 *  whole tree: a wildcard scan would go green again if the call site drifted
 *  into a file that never runs, which is the exact failure being guarded.
 *
 *  PROBE_SCHEDULER_FILE makes this guard falsifiable WITHOUT mutating the
 *  shared checkout: `scripts/mutation-probe.sh` copies the file out, breaks the
 *  copy, and points the test at it. Mutating it in place instead would let the
 *  git-sync sweep commit the mutant mid-run — a documented hazard here, and one
 *  a trap cannot close because the probe legitimately holds the file broken for
 *  as long as the suite runs. */
const SCHEDULER_FILE = process.env.PROBE_SCHEDULER_FILE
  ?? join(OPERATOR_CORE_LIB, 'dbos', 'periodic-workflows.ts');

describe('turn-provenance backfill is actually scheduled', () => {
  it('the scheduler imports and invokes the backfill entry point', () => {
    const src = readFileSync(SCHEDULER_FILE, 'utf8');

    expect(
      src.includes(ENTRY_POINT),
      `${ENTRY_POINT} is not referenced in periodic-workflows.ts — the provenance ` +
        're-derivation lane is dead code again. It must be called from a scheduled tick, ' +
        'not merely exported.',
    ).toBe(true);

    // Referenced is not the same as CALLED — an import left behind after the
    // tick was deleted would still satisfy a bare substring check.
    expect(
      new RegExp(`${ENTRY_POINT}\\s*\\(`).test(src),
      `${ENTRY_POINT} appears in periodic-workflows.ts but is never invoked — ` +
        'a dangling import is not a call site.',
    ).toBe(true);
  });

  it('the invocation is registered on a cron schedule, not just defined', () => {
    const src = readFileSync(SCHEDULER_FILE, 'utf8');

    // A tick function that nothing registers never fires. Pin the registration
    // by name so deleting registerScheduled (while keeping the function) fails.
    expect(
      /DBOS\.registerScheduled\(\s*turnProvenanceBackfillWorkflow/.test(src),
      'turnProvenanceBackfillWorkflow is never passed to DBOS.registerScheduled — ' +
        'an unregistered tick never fires, which is indistinguishable from the ' +
        'original dead-code defect at runtime.',
    ).toBe(true);
  });

  it('the entry point is exported from session-ingest and runs bounded passes', () => {
    const src = readFileSync(join(HERE, 'session-ingest.ts'), 'utf8');

    expect(new RegExp(`export async function ${ENTRY_POINT}`).test(src)).toBe(true);

    // The bound is what keeps one tick from trying to swallow a 370k-row
    // backlog in a single transaction. Losing it turns a healthy sweep into a
    // pool-pinning stall, which reads as "the operator is wedged", not as "the
    // backfill is misconfigured".
    expect(src.includes('PROVENANCE_BACKFILL_PASSES_PER_TICK')).toBe(true);
  });
});
