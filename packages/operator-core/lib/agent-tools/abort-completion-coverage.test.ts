import { describe, expect, it } from 'vitest';

import launchAgent from './capability/launch-agent';
import migrate from './db/migrate';
import consultDecline from './consult/decline';
import consultGetFeedback from './consult/get-feedback';
import consultReply from './consult/reply';
import fleetLaunchOnPlan from './fleet_registry/launch-on-plan';
import gradeIdea from './scout/grade-idea';
import repairQueue from './release/repair-queue';
import scorecardsEmit from './scorecards/emit';
import workItemsCreate from './work_items/create';
import codeRun from './code/run';

/**
 * WI-10005670 recurrence guard — the commit-unknown window.
 *
 * A mutating tool whose handler returns AFTER the dispatch deadline is reported as a bare
 * `timeout` ("handler returned but signal had aborted") although its write committed, and the
 * caller retries a write that already landed. The only per-tool fix is an `abortCompletionReceipt`
 * resolver that names the effect the completed attempt recorded. This pins the population that
 * the invocation ledger MEASURED hitting that window (7d, 2026-10-02: blender:grade-idea 5,
 * consult:reply 7, fleet:launch-on-plan 3) plus the receipts that were already landed, so a
 * refactor that drops the resolver fails here instead of reappearing as production timeouts.
 *
 * ADD a tool here the moment `tool_invocations` shows `error_code='timeout'` with
 * `handler returned but signal had aborted` on a mutating tool; the receipt it needs is a
 * resolver over its own result (see consult/abort-completion.ts, abort-completion-payload.ts).
 */
const LATE_RETURN_MUTATORS = {
  'blender:grade-idea': gradeIdea,
  // EI-24923632103429261: the p95 budget detector measured an over-budget tail.
  'consult:get_feedback': consultGetFeedback,
  'consult:reply': consultReply,
  'consult:decline': consultDecline,
  'fleet:launch-on-plan': fleetLaunchOnPlan,
  'capability:launch-agent': launchAgent,
  // EI-25219048009184886: a late migration success must carry the schema ledger identity.
  'db:migrate': migrate,
  // EI-25175620446966840: the write tool's p95 reached 82% of its dispatch budget.
  'release:repair-queue': repairQueue,
  'scorecards:emit': scorecardsEmit,
  // EI-25216756674045452: code:run can complete nested writes after its dispatch deadline.
  'code:run': codeRun,
  // WI-10005718: the INSERT precedes the response; a late return lost the id + downgrade notice.
  'work_items:create': workItemsCreate,
} as const;

/** The population check, factored so the calibration control below can run the same code. */
function toolsWithoutReceipt(tools: Record<string, { name?: string; abortCompletionReceipt?: unknown }>): string[] {
  return Object.entries(tools)
    .filter(([, tool]) => typeof tool.abortCompletionReceipt !== 'function')
    .map(([name]) => name);
}

describe('late-return mutating tools declare an abortCompletionReceipt (WI-10005670)', () => {
  it('CALIBRATION: the check flags a tool that has no receipt (so a pass is not vacuous)', () => {
    expect(toolsWithoutReceipt({ 'fake:mutator': { name: 'fake:mutator' } })).toEqual(['fake:mutator']);
  });

  it('every pinned tool declares a resolver, registered under the name the ledger measured', () => {
    expect(toolsWithoutReceipt(LATE_RETURN_MUTATORS)).toEqual([]);
    for (const [name, tool] of Object.entries(LATE_RETURN_MUTATORS)) {
      expect(tool.name).toBe(name);
    }
  });
});
