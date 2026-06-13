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
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { TransferTickDeps } from '../../transfer/tick';
import { runTransferDistill } from '../../transfer/run';

/**
 * The flag → governor → tick orchestration this action runs is SHARED with the
 * `transfer:distill` deterministic blueprint step via `runTransferDistill`
 * (deterministic-blueprints-migration-2026-06-13 P-121 / D-004 — provably
 * behavior-neutral: one gated tick, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 */

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
  try {
    const outcome = await runTransferDistill(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, tickDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[transfer-distill] flag papercusp-transfer-harness is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[transfer-distill] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const r = outcome.result!;
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
