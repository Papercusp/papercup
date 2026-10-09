import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@papercusp/tooldef';

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
import docsAuthor from './docs/author';
import coordSend from './coordination/tools/send';
import agentReview from './improvements/agent-review';
import storagePrune from './storage/prune';

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
  // EI-25261691219544543: docs:author crosses the default dispatch budget; identify the canonical doc on late return.
  'docs:author': docsAuthor,
  // WI-10005718: the INSERT precedes the response; a late return lost the id + downgrade notice.
  'work_items:create': workItemsCreate,
  // EI-25288245178425318: a delivered coord:send must expose its persisted message id after a late return.
  'coord:send': coordSend,
  // EI-25374615774698673: a late review claim/resubmission must name its completed effect.
  'improvements:agent-review': agentReview,
  // EI-25430676827648397: prune can commit deletes before its slow maintenance tail returns.
  'storage:prune': storagePrune,
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

  it('storage:prune reports the effect or fails closed when an aborted attempt is unclear', () => {
    expect(storagePrune.timeoutSec).toBe(90);
    const receipt = storagePrune.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');
    const context = { callId: 'prune-call-1', toolName: 'storage:prune' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as ToolResult;

    expect(
      receipt!({}, result({
        ok: true,
        categoryId: 'substrate-outbox',
        dryRun: false,
        removed: 12,
        partial: true,
        totalRemaining: 8,
        vacuumed: false,
      }), context),
    ).toMatchObject({
      status: 'recorded',
      effectRef: 'storage-prune:prune-call-1:substrate-outbox',
      diagnostics: { categoryId: 'substrate-outbox', removed: 12, partial: true, totalRemaining: 8 },
    });

    expect(
      receipt!({}, result({ ok: true, categoryId: 'scratch', dryRun: true, removed: 0, vacuumed: false }), context),
    ).toMatchObject({ status: 'not-recorded' });
    expect(
      receipt!({}, result({ ok: true, categoryId: 'route-invocations', dryRun: false, removed: 0, complete: true }), context),
    ).toMatchObject({ status: 'not-recorded' });
    expect(
      receipt!({}, result({ ok: true, categoryId: 'wake-spills', dryRun: false, removed: 0 }), context),
    ).toMatchObject({ status: 'recovery-incomplete' });
    expect(
      receipt!({}, result({ ok: false, categoryId: 'substrate-outbox', dryRun: false, removed: 0 }), context),
    ).toMatchObject({ status: 'recovery-incomplete' });
  });
});
