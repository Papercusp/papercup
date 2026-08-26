/**
 * decision-provenance — the shared provenance leg for the two tools that write a
 * plan DECISION body (`plans:add-decision`, `plans:set-decision-body`). WI-42142.
 *
 * WHY A DECISION NEEDS THIS AT ALL: a plan Decision is the widest-blast-radius
 * carry surface in the system. Every other one (a checkpoint, a fact, a loop note)
 * is read mainly by its own author; a Decision is what CLAUDE.md tells every agent
 * to trust OVER a peer's paraphrase, so an owner directive manufactured here is
 * believed by lanes that never saw the conversation. facts:assert, loop:checkpoint,
 * work_items:checkpoint, session:request-compaction and (sync-only) plans:set-now
 * already run the shared stamp; decision bodies were the last surface without it.
 *
 * WHY BOTH TOOLS: `plans:set-decision-body` overwrites the same 5,000-char body
 * `plans:add-decision` appends. A guard on only one is a guard an agent clears by
 * recording a clean decision and then rewriting it.
 *
 * WHAT IS ENFORCED vs ADVISORY — this is the load-bearing distinction, and it was
 * settled by measurement, not preference (see {@link falsifiedOwnerAnchors}):
 *
 *   ENFORCED — a FALSIFIED OWNER ANCHOR. The body claims owner authority on a line
 *   whose `[turn:…]` ref RESOLVED to a turn the system classified as not the owner.
 *   ~5 lines in the entire historical corpus carry a turn ref in a decision body at
 *   all, so this asks its question of almost nothing — and it is exactly the shape
 *   that froze a release gate for days (stable-candidate-related-gate-2026-08-23
 *   #D-085 / #D-086 / #D-089).
 *
 *   ADVISORY — everything else the shared lint finds, including a bare `[owner:…]`
 *   tag with no anchor. Porting loop:arm's `manual-owner-tag` REFUSAL here was the
 *   obvious move and is wrong twice over: measured against every papercusp plan it
 *   would refuse 432 of the 483 decision-body owner-tag lines across 139 plans, and
 *   it would STILL have let D-085 through, because D-085's line carries an anchor
 *   and the sync lint therefore skips it. loop:arm's refusal is justified by a
 *   mechanism a plan decision does not share — a loop goal is REPLAYED as
 *   machine-injected `user` text on every fire, so a bare tag there launders
 *   agent-authored text into owner-looking speech in a future context.
 */

import {
  carryProvenanceFields,
  falsifiedOwnerAnchors,
  type CarryProvenanceFields,
  type FalsifiedOwnerAnchor,
} from '../../carry-surface-provenance-stamp';
import { resolveAgentIdentity } from '../coordination/identity';

export { FALSIFIED_OWNER_ANCHOR_NOTE } from '../../carry-surface-provenance-stamp';

export interface DecisionProvenance {
  /** Ready-to-spread advisory response fields; empty on the clean common case. */
  fields: CarryProvenanceFields;
  /** Non-empty ⇒ the caller must REFUSE the write. */
  anchors: FalsifiedOwnerAnchor[];
}

/**
 * Resolve the provenance of one decision body.
 *
 * CALL IT OUTSIDE THE PLAN LOCK. `carryProvenanceFields` performs transcript IO
 * under a 3s bounded budget, and plans:set-now's own comment records why paying
 * that under a held plan lock is the wrong trade. It is free on the common case:
 * the stamp short-circuits with no IO when the text carries neither a directive
 * shape nor a `[turn:…]` ref.
 *
 * Fail-soft in two independent places, deliberately:
 *   - identity resolution is guarded SEPARATELY from the stamp, because
 *     resolveAgentIdentity throws on an under-populated context and folding the two
 *     would silently skip the pure sync legs too (which need no identity at all);
 *   - a stamp fault yields empty fields and NO anchors, so a detector outage can
 *     never manufacture a refusal — the refusal fires only on positive evidence.
 */
export async function decisionProvenance(
  text: string,
  ctx: unknown,
): Promise<DecisionProvenance> {
  let ownerId: string | null = null;
  try {
    ownerId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null;
  } catch {
    /* unattributable caller — the pure legs still run */
  }
  let fields: CarryProvenanceFields = {};
  try {
    fields = await carryProvenanceFields(text, ownerId);
  } catch {
    /* fail-open — an advisory stamp must never lose a decision */
  }
  return { fields, anchors: falsifiedOwnerAnchors(text, fields.turnProvenance?.refs ?? []) };
}
