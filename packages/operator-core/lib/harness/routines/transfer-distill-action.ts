/**
 * Transfer-harness system action (self-learning-frontier-2026-06-12 P-022 /
 * FB-08) — `system:transfer-distill`, the nightly cadence that distills
 * candidate lessons from the day's transcripts, admits them FREE at memory
 * tier 'probationary' (D-006), and runs student-transfer tests that promote
 * ('validated') / demote / retire them via the pure gate.
 *
 * Thin glue over the injectable tick (`lib/transfer/tick.ts`). The gates:
 *
 *   - the `papercusp-transfer-harness` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate (frontier loops ship built,
 *     tested, DARK until the plan's P-001 closes). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/transfer/governor.ts`. This loop SPENDS (distillation +
 *     replay batteries), so arming at P-001 takes BOTH the flag flip AND an
 *     owner-set LIFETIME budget on loop `frontier:transfer-harness`.
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/transfer/seed-transfer-routine.ts).
 *
 * Tick tuning rides payload_template (windowHours, maxTranscriptsPerTick,
 * maxLessonsPerTranscript, maxTestsPerTick, minDelta, maxFailsBeforeRetire,
 * memoryScope — transferOptionsFromPayload). Runs as ONE durable step and
 * never throws; the tick is idempotent-ish (signature dedup on admission,
 * staleness-ordered test queue), so a replay re-tests the stalest rows
 * rather than duplicating work. The testing leg self-skips with an honest
 * count until lib/replay's battery is wired (frontier:replay-landed).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { transferGovernorGate } from '../../transfer/governor';
import { transferOptionsFromPayload } from '../../transfer/gate';
import { runTransferTick, type TransferTickDeps } from '../../transfer/tick';

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: TransferTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setTransferTickDeps(deps: TransferTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type TransferGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: TransferGovernorGate | null = null;
export function setTransferGovernorGate(gate: TransferGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('transfer-distill', async (ctx: SystemActionCtx) => {
  if (!(await getFlag(FLAGS.TRANSFER_HARNESS, `routine:${ctx.installSlug}`))) {
    console.log(
      '[transfer-distill] flag papercusp-transfer-harness is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? transferGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[transfer-distill] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const opts = transferOptionsFromPayload(ctx.payloadTemplate);
  // Lazy: the live deps pull the PG pool + memory-backend graph — neither may
  // load (or throw) before the flag + governor checks in a hermetic process.
  const deps =
    _deps ??
    (await import('../../transfer/live-deps')).defaultTransferTickDeps(
      (await import('@papercusp/db-org')).getOrgPg().sql,
      ctx.workspaceId,
    );
  try {
    const r = await runTransferTick(ctx.workspaceId, deps, opts);
    console.log(
      `[transfer-distill] ${r.transcriptsScanned} transcript(s) → ${r.lessonsDistilled} lesson(s) distilled, ` +
        `${r.lessonsAdmitted} admitted probationary; tested ${r.tested} ` +
        `(${r.passed} promoted, ${r.failed} failed, ${r.retired} retired)` +
        (r.testingSkippedNoReplay ? ' [testing leg skipped — replay substrate pending]' : '') +
        (r.errors ? `, ${r.errors} error(s)` : '') +
        `, $${r.costUsd.toFixed(4)} spent`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[transfer-distill] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
