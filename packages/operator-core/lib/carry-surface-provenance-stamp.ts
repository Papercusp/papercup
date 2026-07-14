/**
 * carry-surface-provenance-stamp — the SYSTEM-side origin stamp for
 * carry-surface writes (deterministic-context-carry-2026-07-14 P-014).
 *
 * The lint (./carry-surface-provenance-lint.ts) is the pure, write-time nudge;
 * THIS module is the mechanical verification layer on top:
 *
 *   1. every [turn:<session>@<ts>] ref in the write is resolved against the
 *      WRITER's own transcript and the referenced turn classified owner-typed /
 *      agent-injected / machine-surface from what was recorded (the durable
 *      ⟦turn-origin:…⟧ envelope — turn-provenance/turn-ref.ts);
 *   2. the write itself is stamped with the CURRENT turn's classification —
 *      "written during an owner-typed turn" vs "written during a loop-fire" is
 *      recorded by the system, not asserted by the agent. A checkpoint claiming
 *      an owner directive while every driving turn was machine-injected is now
 *      visible mechanically (the WI-3532 class).
 *
 * WARN/STAMP-ONLY, fail-soft, bounded: like the lint, this must never block or
 * slow a carry write (often issued near a context limit) — any IO failure or
 * timeout degrades to the pure lint result. Enforcement is P-016's job.
 */

import { withBoundedTimeout } from './bounded-timeout';
import {
  provenanceLintField,
  type ProvenanceLintMatch,
} from './carry-surface-provenance-lint';
import {
  ownerQuestionSlotField,
  type TypedSlotLintMatch,
} from './carry-surface-typed-slots';
import {
  parseTurnRefs,
  resolveCurrentTurnStamp,
  verifyTurnRefs,
  type CurrentTurnStamp,
  type TurnRefVerdict,
} from './turn-provenance/turn-ref';

/** IO budget for the transcript reads — a stamp is advisory; the write is not. */
export const STAMP_IO_BUDGET_MS = 3_000;

export interface CarryProvenanceStamp {
  /** The pure lint result (unchanged shape) — absent when clean. */
  lint?: { flagged: true; note: string; matches: ProvenanceLintMatch[] };
  /** P-015 typed-slot lint: owner-blocking-question prose with no [ask:…]
   *  record ref — absent when clean. */
  slotLint?: { flagged: true; note: string; matches: TypedSlotLintMatch[] };
  /** Verdicts for every [turn:…] ref the write carried — absent when none. */
  refs?: TurnRefVerdict[];
  /** The system's classification of the turn this write happened during. */
  writtenDuring?: CurrentTurnStamp;
}

/**
 * Build the full stamp for one carry-surface write. Returns undefined when
 * there is nothing to say (clean lint, no refs, transcript unreachable) so the
 * common clean case adds no response field — same contract as the lint alone.
 */
export async function stampCarrySurfaceProvenance(
  text: string | null | undefined,
  ownerId: string | null | undefined,
): Promise<CarryProvenanceStamp | undefined> {
  const lint = provenanceLintField(text);
  const slotLint = ownerQuestionSlotField(text);
  const refs = parseTurnRefs(text);

  // No directive shapes, no untyped questions, no refs → nothing to verify or
  // stamp. The writtenDuring stamp only matters alongside directive-ish
  // content; keeping the clean case field-free is deliberate (response-size
  // discipline).
  if (!lint && !slotLint && refs.length === 0) return undefined;

  let verified: TurnRefVerdict[] = [];
  let writtenDuring: CurrentTurnStamp | null = null;
  if (ownerId) {
    const { value } = await withBoundedTimeout(
      Promise.all([verifyTurnRefs(ownerId, refs), resolveCurrentTurnStamp(ownerId)]),
      {
        fallback: [[], null] as [TurnRefVerdict[], CurrentTurnStamp | null],
        timeoutMs: STAMP_IO_BUDGET_MS,
        label: 'carry-provenance-stamp',
      },
    );
    [verified, writtenDuring] = value;
  }

  const stamp: CarryProvenanceStamp = {};
  if (lint) stamp.lint = lint;
  if (slotLint) stamp.slotLint = slotLint;
  if (verified.length) stamp.refs = verified;
  if (writtenDuring) stamp.writtenDuring = writtenDuring;
  return Object.keys(stamp).length ? stamp : undefined;
}

/** Ready-to-spread response fields: `provenanceLint` keeps its pre-P-014 shape
 *  (consumer/response compat), `turnProvenance` carries the new mechanical
 *  stamp. Both absent on the common clean case. */
export interface CarryProvenanceFields {
  provenanceLint?: NonNullable<CarryProvenanceStamp['lint']>;
  turnProvenance?: {
    refs?: TurnRefVerdict[];
    writtenDuring?: CurrentTurnStamp;
  };
}

export async function carryProvenanceFields(
  text: string | null | undefined,
  ownerId: string | null | undefined,
): Promise<CarryProvenanceFields> {
  const stamp = await stampCarrySurfaceProvenance(text, ownerId);
  if (!stamp) return {};
  const out: CarryProvenanceFields = {};
  if (stamp.lint) out.provenanceLint = stamp.lint;
  if (stamp.refs || stamp.writtenDuring) {
    out.turnProvenance = {
      ...(stamp.refs ? { refs: stamp.refs } : {}),
      ...(stamp.writtenDuring ? { writtenDuring: stamp.writtenDuring } : {}),
    };
  }
  return out;
}
