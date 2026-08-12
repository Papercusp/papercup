/**
 * P-007 (owner-visibility-provenance-2026-08-11) / D-019 — the WIRING guard for
 * the REFUSING tier of the live-drive acceptance.
 *
 * ── WHY A SOURCE-LEVEL GUARD, GIVEN THE DECISION IS ALREADY UNIT-TESTED ────
 * `owner-visible-surface-refusal.test.ts` proves the decision. It cannot prove
 * that `setWorkItemState` CALLS it, and those are different failures. The
 * second one is the shape this plan exists to prevent: a carefully-reasoned
 * gate that no code path invokes reads, from every surface an agent looks at,
 * exactly like a shipped gate — and the decision's suite stays green the whole
 * time. That is not hypothetical: the WARN tier's wiring sat unlanded behind a
 * file lock for ~4.5h while its module and 18 green tests were already
 * committed, so "the acceptance gate is in" was true of the module and false of
 * the product.
 *
 * Exercising the real function instead would need a live Postgres (it is the
 * hot state-write path, ~90 lines into a bounded transaction), which buys
 * nothing here: the behaviour is already covered, and what is unproven is the
 * seam. A source assertion is the honest instrument for a seam.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) rather than by mutating the shared checkout:
// git-sync sweeps the whole tree on a schedule, so a probe that holds this file
// mutated for the length of a run can have the mutant committed even when
// nothing goes wrong and no handler fails.
const WORK_ITEMS_TS = process.env.PROBE_WORK_ITEMS_TS || nodePath.join(__dirname, 'work-items.ts');
const source = readFileSync(WORK_ITEMS_TS, 'utf8');

describe('setWorkItemState WIRES the live-drive refusal (D-019)', () => {
  it('imports the decision from the registry module rather than re-deriving it', () => {
    // A local re-implementation would fork the accepted-verification list and the
    // message away from the WARN tier, so the two tiers would quietly start
    // disagreeing about what the acceptance is.
    expect(source).toMatch(
      /import\s*\{[^}]*liveDriveTerminalRefusal[^}]*\}\s*from\s*'\.\/turn-provenance\/owner-visible-surface-acceptance'/,
    );
  });

  it('actually THROWS on the refusal — a computed-but-ignored decision is the dead-code shape', () => {
    expect(source).toMatch(/if\s*\(liveDriveRefusal\)\s*throw new Error\(liveDriveRefusal\)/);
  });

  it('feeds it the real transition + evidence, not invented substitutes', () => {
    // `isCompletingTransition` is the same predicate the plan-lane guard above it
    // uses; `opts.completionEvidence` is what the caller actually supplied.
    // Passing anything else here would let the gate disagree with the write it
    // is guarding.
    const call = source.slice(source.indexOf('liveDriveTerminalRefusal({'));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toMatch(/isCompletingTransition,/);
    expect(args).toMatch(/evidence:\s*opts\.completionEvidence,/);
    expect(args).toMatch(/force:\s*opts\.force,/);
    expect(args).toMatch(/skipCompletionGate:\s*opts\.skipCompletionGate,/);
  });

  it('sits INSIDE setWorkItemState and BEFORE its family branch, guarding issue and feature writes alike', () => {
    // WI-37958 is issue-family and routes through setIssueState; features route
    // through the sibling leg. A guard placed inside either branch would leave
    // the other half of the fleet's closes unguarded — invisibly, since the
    // decision's own suite would still be green.
    //
    // `wi.family === 'issue'` appears in more than one function in this file, so
    // the comparison must be anchored: the branch that matters is the FIRST one
    // after the guard, and both must sit inside setWorkItemState. Comparing
    // against the file's first occurrence instead is how this assertion would
    // pass while the guard sat in the wrong function entirely — it failed
    // exactly that way when first written.
    const fnAt = source.indexOf('export async function setWorkItemState(');
    const guardAt = source.indexOf('liveDriveTerminalRefusal({', fnAt);
    const branchAt = source.indexOf("if (wi.family === 'issue') {", guardAt);
    expect(fnAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fnAt);
    expect(branchAt).toBeGreaterThan(guardAt);

    // …and nothing between them may write state: the refusal has to precede the
    // write it guards, not merely appear above it in the file.
    const between = source.slice(guardAt, branchAt);
    expect(between).not.toMatch(/await\s+setIssueState|await\s+boundedOrgTxn/);
  });
});
