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

/** EI-12890: shown when a [turn:…] ref resolved to a real turn but the quote
 *  attached to it does not appear in that turn's actual recorded text. */
export const QUOTE_MISMATCH_NOTE =
  'provenance_lint: a [turn:<session>@<ts>] ref resolved to a REAL recorded turn, but the quoted claim next to ' +
  'it does NOT appear in that turn\'s actual text — a resolvable ref is necessary but not sufficient; the words ' +
  'must match too. This is the exact fabrication shape from EI-12890 (a compaction summary fused two unrelated ' +
  'turns into one stronger directive and re-stamped it at the wrong turn). Re-read the cited turn verbatim ' +
  "(sessions:search { mode:'verbatim' } or dev:claude_session) before treating the claim as authorized.";

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
  /** P-005 (cold-carry-system-hardening-2026-07-19): count of hand-written
   *  [owner:…] tags auto-verified because THIS write happened during an
   *  owner-typed interactive turn — the platform just witnessed the owner
   *  speaking, so the tag is evidence-backed rather than asserted. The
   *  `writtenDuring.ref` is the ready-to-copy [turn:…] anchor for them. */
  ownerTagsAutoVerified?: number;
}

/**
 * EI-12890 guard-defeat fix: a resolvable [turn:…] ref exempts its line from
 * the sync lint (TURN_REF_LINE_RE, carry-surface-provenance-lint.ts) on the
 * assumption it is "mechanically verifiable" — but a ref resolving to a REAL
 * turn whose text does not contain the quote attached to it is exactly the
 * fabricated-citation shape that defeated the guard live (a compaction summary
 * fused two unrelated turns into one stronger directive and re-stamped it at
 * the wrong turn's timestamp). Fold any such mismatch into `lint` so it
 * surfaces in the SAME flagged/matches shape a consumer already checks,
 * instead of requiring a separate turnProvenance.refs[].quoteMatch read that
 * nothing currently makes anyone perform. Pure — no IO — so it's unit-testable
 * without a transcript fixture; `verified` is `[]` whenever ownerId was absent
 * or the transcript legs were skipped/timed out.
 */
export function mergeQuoteMismatchesIntoLint(
  lint: { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined,
  verified: TurnRefVerdict[],
): { flagged: true; note: string; matches: ProvenanceLintMatch[] } | undefined {
  const quoteMismatches: ProvenanceLintMatch[] = verified
    .filter((v) => v.found && v.quote && v.quoteMatch === false)
    .map((v) => ({
      line: `${v.ref}: claimed "${v.quote}" — NOT found in the referenced turn's actual text (snippet: ${v.snippet ?? ''})`.slice(0, 400),
      kind: 'quote-mismatch' as const,
    }));
  if (!lint && !quoteMismatches.length) return undefined;
  return {
    flagged: true,
    note: quoteMismatches.length ? QUOTE_MISMATCH_NOTE : lint!.note,
    matches: [...(lint?.matches ?? []), ...quoteMismatches],
  };
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

  // P-005 (cold-carry-system-hardening-2026-07-19): a hand-written [owner:…] tag is
  // unproven in general (P-014) — but when THIS write happens during an owner-typed
  // interactive turn, the platform has just witnessed the owner speaking: auto-verify
  // those tags instead of flagging them (writtenDuring.ref is their ready-to-copy
  // anchor). Nudging an agent for tagging a directive the owner gave seconds ago
  // teaches it to ignore the lint — the observed 2026-07-19 failure. Writes during
  // machine-injected turns keep the full nudge; owner-attribution phrases and bare
  // gate imperatives are never auto-cleared this way.
  let ownerTagsAutoVerified = 0;
  let effectiveLint = lint;
  if (writtenDuring?.verdict === 'owner-typed' && lint) {
    const kept = lint.matches.filter((m) => m.kind !== 'manual-owner-tag');
    ownerTagsAutoVerified = lint.matches.length - kept.length;
    effectiveLint = kept.length > 0 ? { ...lint, matches: kept } : undefined;
  }

  const stamp: CarryProvenanceStamp = {};
  const mergedLint = mergeQuoteMismatchesIntoLint(effectiveLint, verified);
  if (mergedLint) stamp.lint = mergedLint;
  if (slotLint) stamp.slotLint = slotLint;
  if (verified.length) stamp.refs = verified;
  if (writtenDuring) stamp.writtenDuring = writtenDuring;
  if (ownerTagsAutoVerified > 0) stamp.ownerTagsAutoVerified = ownerTagsAutoVerified;
  return Object.keys(stamp).length ? stamp : undefined;
}

/** Ready-to-spread response fields: `provenanceLint` keeps its pre-P-014 shape
 *  (consumer/response compat), `turnProvenance` carries the new mechanical
 *  stamp. Both absent on the common clean case. */
export interface CarryProvenanceFields {
  provenanceLint?: NonNullable<CarryProvenanceStamp['lint']>;
  /** P-015: owner-blocking-question prose that should be a coord:ask-owner
   *  record cited as [ask:<conversation_id>]. */
  typedSlotLint?: NonNullable<CarryProvenanceStamp['slotLint']>;
  turnProvenance?: {
    refs?: TurnRefVerdict[];
    writtenDuring?: CurrentTurnStamp;
    /** P-005: [owner:…] tags auto-verified by the owner-typed current turn. */
    ownerTagsAutoVerified?: number;
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
  if (stamp.slotLint) out.typedSlotLint = stamp.slotLint;
  if (stamp.refs || stamp.writtenDuring) {
    out.turnProvenance = {
      ...(stamp.refs ? { refs: stamp.refs } : {}),
      ...(stamp.writtenDuring ? { writtenDuring: stamp.writtenDuring } : {}),
    };
  }
  return out;
}
