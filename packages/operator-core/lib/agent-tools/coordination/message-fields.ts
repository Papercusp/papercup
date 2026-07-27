/**
 * message-fields.ts — the authored message fields, as ONE schema.
 *
 * unified-agent-state-plane-2026-07-27 P-032 / D-064, unfrozen by **D-070**
 * [owner 2026-07-27]: *"I WANT TO ADD ALL THE MESSAGE FIELDS WE DECIDED ON.
 * REVERT THIS DECISION. WE NEED TO EXPERIMENT"*.
 *
 * ⚠ THE SPLIT IS THE DELIVERABLE, NOT THE CONTAINER (D-064). The array is the
 * cheap half; the envelope/section boundary is the half that is a CORRECTNESS
 * claim rather than a modelling preference, and it is enforced here rather than
 * documented:
 *
 *   ENVELOPE (one per message)          why it cannot vary per section
 *   ────────────────────────────────    ───────────────────────────────────────
 *   expects, blocking                   a scheduler acts on a message as a UNIT;
 *                                       "simultaneously blocking and not" is not
 *                                       a state anything can act on
 *   why                                 a goal REF (D-011), not prose — one
 *                                       message serves one goal
 *   evidence                            auto-derived trace of what the sender
 *                                       READ; a property of the SESSION, not of
 *                                       a paragraph (D-002/D-011)
 *
 *   PER-SECTION — all four AUTHORED, and they genuinely vary between the parts
 *   of one message: premises, forYouBecause, youMayNotKnow, couldNotDetermine.
 *
 * Putting an envelope field on a section (or vice versa) is REFUSED, not
 * coerced. A silent coercion here would produce exactly the message a scheduler
 * cannot act on, which is the failure D-064 exists to prevent.
 *
 * MEASUREMENT, not a gate (D-069 §3, which SURVIVES D-070 and now carries more
 * weight because it is the only remaining check on this layer): judge these
 * fields by their VALUES, never their fill rate. P-029 is the precedent — a
 * field that was 100% populated with a third of it a mechanism string. A
 * per-section schema will look healthy (every field set, zero nulls) while
 * carrying nothing, and the null count cannot detect it.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// premises — what I or someone else ASSERTED (D-041's rename of `restsOn`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-026's admissible ref kinds, and the governing rule:
 *
 *   > **Any ref may be cited. The ref KIND determines whether it can go stale.**
 *
 * A non-invalidatable ref (an insight, an external doc) is still worth
 * declaring — it tells the receiver what the sender was reasoning from — it
 * simply cannot trigger automatic staleness. DEGRADE GRACEFULLY, NEVER EXCLUDE:
 * an unrecognised ref is classified `opaque`, not rejected.
 */
export type PremiseRefKind =
  | 'fact' // fact:owner:<id>:<key>@v<N> — conclusion / assumption / convention
  | 'plan-decision' // <plan-slug>#D-NNN — a claim, not the container plan
  | 'work-item-completion' // WI-NNNN#completion — the CLAIM, not the item
  | 'peer-message' // msg:<msg_id>
  | 'owner-directive' // owner-turn:<ref>
  | 'doc' // /internal/docs/... — declarable, not invalidatable
  | 'opaque'; // unrecognised — cite it anyway, never stale

/** Which kinds can go stale. `doc`/`opaque` are declarable but never invalidatable. */
const INVALIDATABLE_KINDS: ReadonlySet<PremiseRefKind> = new Set<PremiseRefKind>([
  'fact',
  'plan-decision',
  'work-item-completion',
  'peer-message',
  'owner-directive',
]);

export interface ClassifiedPremise {
  /** The ref exactly as the sender cited it — never rewritten. */
  ref: string;
  kind: PremiseRefKind;
  /** D-026's governing rule, precomputed so no reader re-derives it. */
  invalidatable: boolean;
}

/**
 * Classify one premise ref by SHAPE. Total function — every string classifies,
 * because D-026 forbids excluding a citation for being unrecognised.
 *
 * Order matters: `owner-turn:` and `msg:` are checked before the generic
 * `<slug>#D-NNN` so a prefixed ref never falls through to the plan-decision arm.
 */
export function classifyPremiseRef(ref: string): ClassifiedPremise {
  const trimmed = ref.trim();
  let kind: PremiseRefKind = 'opaque';
  if (/^fact:/.test(trimmed)) kind = 'fact';
  else if (/^owner-turn:/.test(trimmed)) kind = 'owner-directive';
  else if (/^msg:/.test(trimmed)) kind = 'peer-message';
  else if (/^(WI|EI)-\d+#completion$/i.test(trimmed)) kind = 'work-item-completion';
  else if (/#D-\d{3,}$/.test(trimmed)) kind = 'plan-decision';
  else if (trimmed.startsWith('/internal/docs/')) kind = 'doc';
  return { ref: trimmed, kind, invalidatable: INVALIDATABLE_KINDS.has(kind) };
}

const premisesArg = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe(
    'PER-SECTION. What this section RESTS ON — claims someone ASSERTED (D-041). Cite refs: ' +
      '`fact:owner:<id>:<key>@v<N>` · `<plan-slug>#D-NNN` · `WI-NNNN#completion` (the completion ' +
      'CLAIM, not the item) · `msg:<msg_id>` · `owner-turn:<ref>` · `/internal/docs/...`. Any ref ' +
      'may be cited; the ref KIND decides whether it can go stale (a doc is declarable, never ' +
      'invalidatable). Distinct from `evidence`, which cites CELLS you READ and is auto-derived.',
  );

// ─────────────────────────────────────────────────────────────────────────────
// forYouBecause — the sender's model of why THIS recipient is being told (D-021)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-043: the vocabulary is the coupling vocabulary D-017 already computes for
 * presence, PLUS `'other'`.
 *
 * `'other'` is not a convenience. D-021 promised the field was "overridable when
 * the true reason is non-structural" and left that escape with no target — so a
 * sender with a genuinely non-structural reason had to pick the nearest-fitting
 * coupling, which is WORSE than prose: a mis-declared relation then falsely
 * agrees or falsely diverges with the computed graph, corrupting the exact
 * signal the field is justified on.
 */
export const FOR_YOU_BECAUSE_RELATIONS = [
  'holds-a-lock-on',
  'owns',
  'is-blocked-on',
  'awaits',
  'same-fleet',
  'other',
] as const;

export type ForYouBecauseRelation = (typeof FOR_YOU_BECAUSE_RELATIONS)[number];

export interface ForYouBecause {
  relation: ForYouBecauseRelation;
  /** What the relation is ABOUT (a file, a work-item, a fleet slug, …). */
  ref?: string;
  /** The prose half. REQUIRED when relation is 'other' (D-043 ruling 1). */
  note?: string;
}

/**
 * D-043 ruling 2, the load-bearing half: **`'other'` is excluded from the
 * asserted-vs-computed divergence check BY CONSTRUCTION** — not scored as
 * agreement, not scored as divergence, simply not compared. An `'other'` that
 * participated in the diff would reintroduce the false-agreement failure it
 * exists to prevent.
 *
 * Exported so the P-013 divergence metric cannot forget to apply it: the rule
 * lives here, next to the enum, rather than in whichever consumer remembers.
 */
export function participatesInCouplingDivergence(f: ForYouBecause): boolean {
  return f.relation !== 'other';
}

const forYouBecauseArg = z
  .object({
    relation: z.enum(FOR_YOU_BECAUSE_RELATIONS),
    ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .optional()
  .describe(
    "PER-SECTION. Why THIS recipient is being told, STRUCTURED so it can be diffed against the " +
      'computed coupling graph (a prose string cannot be). relation: holds-a-lock-on | owns | ' +
      "is-blocked-on | awaits | same-fleet | other. `note` is REQUIRED with 'other' (the " +
      "non-structural escape hatch), and 'other' is excluded from the divergence check.",
  );

// ─────────────────────────────────────────────────────────────────────────────
// youMayNotKnow / couldNotDetermine — D-024's split of the old `asymmetry`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * D-024 split these because their halves differ on EVERY axis that matters:
 * origin (part-computed vs authored-only), enforcement, whether being wrong is
 * even the axis, and what the receiver does with it. One field whose entries
 * have different provenance and different meanings is a field that gets filled
 * inconsistently and read wrong.
 *
 * ⚠ Withdrawn once by an agent (D-034) on an unratified cost projection and
 * REINSTATED by the owner (D-040); frozen again by D-069 §1 and REINSTATED
 * again by the owner (D-070). Do not withdraw it a third time without the owner.
 */
export interface YouMayNotKnowEntry {
  ref: string;
  /**
   * 'computed' = the evidence-minus-your-watermark diff (free, exact, covers
   * tracked state). 'authored' = the sender's model of the receiver — valuable
   * PRECISELY because it can be wrong (D-021).
   */
  provenance: 'computed' | 'authored';
}

/** Authored only — no system can know you TRIED and failed to establish something. */
export interface CouldNotDetermineEntry {
  what: string;
  note?: string;
}

const youMayNotKnowArg = z
  .array(
    z.object({
      ref: z.string().min(1),
      provenance: z.enum(['computed', 'authored']),
    }),
  )
  .max(20)
  .optional()
  .describe(
    'PER-SECTION. Information I have that you may lack, as { ref, provenance }. ' +
      "'computed' entries are the evidence-minus-your-watermark diff; 'authored' entries are my " +
      'model of you and are valuable precisely because they can be WRONG. Not the same field as ' +
      '`couldNotDetermine` (D-024) — this one is a gap in YOUR knowledge, that one is a failed attempt of MINE.',
  );

const couldNotDetermineArg = z
  .array(
    z.object({
      what: z.string().min(1),
      note: z.string().min(1).optional(),
    }),
  )
  .max(20)
  .optional()
  .describe(
    'PER-SECTION, AUTHORED ONLY. What I TRIED to establish and FAILED to — so you read the ' +
      'question as OPEN rather than answered. No system can derive this; if you do not write it, ' +
      'the receiver cannot distinguish "unknown" from "not asked".',
  );

// ─────────────────────────────────────────────────────────────────────────────
// why / evidence — ENVELOPE-scoped
// ─────────────────────────────────────────────────────────────────────────────

/** D-011: a goal REF, never prose — so the receiver can query the goal's LIVE state. */
export interface MessageWhy {
  goalRef: string;
  note?: string;
}

const whyArg = z
  .object({
    goalRef: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .optional()
  .describe(
    'ENVELOPE (one per message — one message serves one goal). WHY you are sending this, as a ' +
      'goal REF not prose (D-011), so the receiver can query the goal\'s LIVE state instead of ' +
      'trusting your snapshot of it. `note` carries any prose.',
  );

/**
 * ENVELOPE. What the sender READ — cells, versioned (D-041).
 *
 * ⚠ AUTO-DERIVED, NEVER AUTHORED. It is deliberately NOT a caller argument:
 * D-002's never-author economics and D-011 both put this on the session, and
 * D-064 records that asking a sender to author it per-section contradicts both.
 * `deriveEvidence` is the seam a capture path fills; until one is wired it
 * returns undefined, which is honest — an empty trace is not a false one.
 */
export interface EvidenceEntry {
  cell: string;
  version?: string;
  readAt?: string;
}

const blockingArg = z
  .boolean()
  .optional()
  .describe(
    'ENVELOPE. Is the SENDER blocked until this is dealt with? A scheduler acts on a message as a ' +
      'UNIT, which is why this cannot vary per section. Distinct from `expects`: `expects` is what ' +
      'you want BACK, `blocking` is what it costs you to wait for it.',
  );

// ─────────────────────────────────────────────────────────────────────────────
// The section, and the envelope/section boundary ENFORCED
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageSection {
  text: string;
  premises?: string[];
  forYouBecause?: ForYouBecause;
  youMayNotKnow?: YouMayNotKnowEntry[];
  couldNotDetermine?: CouldNotDetermineEntry[];
}

/** The four field names that may NEVER appear on a section (D-064's split). */
export const ENVELOPE_ONLY_FIELDS = ['expects', 'blocking', 'why', 'evidence'] as const;

/** The four that may never appear on the envelope. */
export const SECTION_ONLY_FIELDS = [
  'premises',
  'forYouBecause',
  'youMayNotKnow',
  'couldNotDetermine',
] as const;

export const messageSectionSchema = z
  .object({
    text: z.string().min(1),
    premises: premisesArg,
    forYouBecause: forYouBecauseArg,
    youMayNotKnow: youMayNotKnowArg,
    couldNotDetermine: couldNotDetermineArg,
  })
  .strict()
  .superRefine((section, ctx) => {
    // D-043 ruling 1 — an escape that carries no explanation is a silent opt-out.
    if (section.forYouBecause?.relation === 'other' && !section.forYouBecause.note) {
      ctx.addIssue({
        code: 'custom',
        path: ['forYouBecause', 'note'],
        message:
          "forYouBecause.relation:'other' REQUIRES a `note` (D-043). 'other' is the escape hatch " +
          'for a genuinely non-structural reason, and it is excluded from the asserted-vs-computed ' +
          'divergence check — so without the note it carries no information at all.',
      });
    }
  });

export const messageBodyArg = z
  .union([z.string(), z.array(messageSectionSchema).min(1).max(20)])
  .optional()
  .describe(
    'The message body. A plain STRING is the n=1 case (one section, no authored fields). Pass an ' +
      'ARRAY of sections when the parts of your message have different dispositions — a concession, ' +
      'an experimental result, an explicitly-undetermined claim — each with its own `premises`, ' +
      '`forYouBecause`, `youMayNotKnow`, `couldNotDetermine`. The ENVELOPE fields (expects, ' +
      'blocking, why, evidence) stay on the message and are refused on a section.',
  );

export { premisesArg, forYouBecauseArg, youMayNotKnowArg, couldNotDetermineArg, whyArg, blockingArg };

/**
 * Normalise `body` to sections. A string becomes the one-element array D-064
 * names as the n=1 case, so every downstream reader sees ONE shape.
 */
export function toSections(body: string | MessageSection[] | undefined): MessageSection[] {
  if (body === undefined) return [];
  if (typeof body === 'string') return body.length ? [{ text: body }] : [];
  return body;
}

/**
 * Flatten sections back to the plain text `env.body` every existing reader
 * (coord:inbox, coord:read, the [coord+N] injection, coord:thread, the pui pane)
 * already renders. The STRUCTURE rides the envelope alongside it — this is the
 * text projection, not the storage.
 */
export function sectionsToText(sections: MessageSection[]): string {
  return sections.map((s) => s.text).join('\n\n');
}

export class EnvelopeFieldOnSectionError extends Error {
  readonly code = 'coord_envelope_field_on_section';
  constructor(field: string, index: number) {
    super(
      `body[${index}].${field} is an ENVELOPE field, not a section field (D-064). ` +
        `Move it to the top level of the message. \`expects\`/\`blocking\` cannot vary per section ` +
        `because a scheduler acts on a message as a UNIT; \`why\` is one goal ref per message; ` +
        `\`evidence\` is auto-derived from the session, not authored per paragraph.`,
    );
    this.name = 'EnvelopeFieldOnSectionError';
  }
}

/**
 * Enforce the boundary BEFORE the message is persisted. `.strict()` on the
 * section schema already rejects unknown keys; this converts the specific
 * envelope-field case into a typed refusal that TEACHES the split instead of
 * emitting a generic "unrecognized key".
 */
export function assertEnvelopeSectionSplit(sections: unknown[]): void {
  sections.forEach((section, i) => {
    if (!section || typeof section !== 'object') return;
    for (const field of ENVELOPE_ONLY_FIELDS) {
      if (field in (section as Record<string, unknown>)) {
        throw new EnvelopeFieldOnSectionError(field, i);
      }
    }
  });
}

/** Everything the send path stamps onto the envelope for these fields. */
export interface StampedMessageFields {
  sections?: MessageSection[];
  premisesClassified?: ClassifiedPremise[][];
  why?: MessageWhy;
  blocking?: boolean;
  evidence?: EvidenceEntry[];
}

/**
 * Build the envelope stamp. Classification happens at SEND time (like the
 * `dependsOn` digests in P-008 (b)) so a reader never re-derives D-026's
 * staleness rule and cannot drift from it.
 */
export function stampMessageFields(input: {
  body?: string | MessageSection[];
  why?: MessageWhy;
  blocking?: boolean;
  evidence?: EvidenceEntry[];
}): StampedMessageFields {
  const sections = toSections(input.body);
  const authored = sections.some(
    (s) => s.premises?.length || s.forYouBecause || s.youMayNotKnow?.length || s.couldNotDetermine?.length,
  );
  const stamp: StampedMessageFields = {};
  // Only stamp sections when they CARRY something — a plain-string send stays
  // byte-identical on the wire, so the n=1 case costs nothing.
  if (authored || sections.length > 1) {
    stamp.sections = sections;
    stamp.premisesClassified = sections.map((s) => (s.premises ?? []).map(classifyPremiseRef));
  }
  if (input.why) stamp.why = input.why;
  if (input.blocking !== undefined) stamp.blocking = input.blocking;
  if (input.evidence?.length) stamp.evidence = input.evidence;
  return stamp;
}
