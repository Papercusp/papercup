/**
 * EI-21761566265989000 — the consult RESPONDER's verb menu, rendered in exactly one place.
 *
 * Every wake that routes a consult spells this menu out: the initial route (three branches:
 * lexical-fallback, best-available, relevance), the cascade advance, the revival brief, and the
 * follow-up ping. All five copies named consult:reply / consult:decline / consult:close and NONE
 * of them named the READ door, so a routed reviewer had no path from the verbs they were handed
 * to the verb that reads their own thread.
 *
 * That gap is not theoretical and it is not cheap. A reviewer answering a real consult posted,
 * verbatim: "I have NOT read your latest post — there is no `consult:read` tool and my attempts
 * to pull the thread body directly came back empty, so I am not going to pretend to answer an
 * argument I have not seen." They then reviewed a second time against the artifact alone. The
 * requester's replies were sitting in the thread the whole time.
 *
 * Two properties make this failure silent, and the wording below targets both:
 *
 *   1. The natural guess is `consult:read`, which does not resolve — the verb family is
 *      write-only, so nothing an in-consult responder holds points at the reader. The door is
 *      `conversations:get`, discoverable only if you think to search for *conversations*.
 *   2. A wrong-door read returns EMPTY, which is indistinguishable from "the thread has no
 *      replies". A reviewer who draws that inference reviews without the requester's responses
 *      and reports lower-confidence findings than the evidence actually supports.
 *
 * Rendering the menu once is the whole point of this module. A hand-maintained sixth copy is
 * exactly how the omission got into five of them; `responder-verb-menu.test.ts` derives the wake
 * bodies from the real builders and fails if any stops naming the read door.
 */

/** Default evidence qualifier — overridden where a branch admits first-principles reasoning. */
const DEFAULT_EVIDENCE_NOTE = 'answer requires evidence';
/** Default decline qualifier — overridden where a branch has a softer or narrower bar. */
const DEFAULT_DECLINE_NOTE = 'only if you genuinely cannot add value';

export interface ConsultResponderVerbMenuInput {
  /** The consult conversation the responder was routed into. */
  conversationId: string;
  /** Parenthetical after `consult:reply { kind }` (e.g. admitting first-principles reasoning). */
  evidenceNote?: string;
  /** Qualifier after `consult:decline { reason }` (e.g. "if it's not your area"). */
  declineNote?: string;
}

/**
 * The READ door, stated so that the two silent-failure modes above are both closed: it names the
 * verb (because the guessable name does not exist) and it says what a wrong-door read LOOKS like
 * (because an empty result otherwise reads as an empty thread).
 */
export function consultReadDoorLine(conversationId: string): string {
  return (
    `READ THE THREAD FIRST — conversations:get { id: '${conversationId}' } returns every post oldest-first. ` +
    `There is NO consult:read: the verb family is write-only, so the natural guess does not resolve and a ` +
    `wrong-door read comes back EMPTY — which is indistinguishable from a thread with no replies. If you ` +
    `believe there are no replies, confirm it through this door before answering as though there are none.`
  );
}

/** The full responder menu: read door first, then the write verbs. */
export function consultResponderVerbMenu(input: ConsultResponderVerbMenuInput): string {
  const evidenceNote = input.evidenceNote ?? DEFAULT_EVIDENCE_NOTE;
  const declineNote = input.declineNote ?? DEFAULT_DECLINE_NOTE;
  return (
    `${consultReadDoorLine(input.conversationId)}\n` +
    `Reply in conversation ${input.conversationId} with consult:reply { kind } (${evidenceNote}); ` +
    `consult:decline { reason } ${declineNote}; consult:close { outcome } when settled. ` +
    `Untyped conversations:post is refused.`
  );
}
