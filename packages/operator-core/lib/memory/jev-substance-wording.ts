/**
 * Save-time substance wordings (WI-10004428; plan jev-performance-improvements-2026-09-30,
 * bar R-2).
 *
 * `v1` is the P-005 wording (SUBSTANCE_INSTRUCTIONS / SUBSTANCE_CRITERIA in
 * jev-admission-request.ts), which memory:remember and the content-free sweep ask today.
 *
 * `trigger` adds one clause: text the memory only QUOTES as the occasion to recall it
 * (a question someone might ask, a topic it says it applies to) is not information the
 * memory states. Under v1, four bench self-promoters of the shape "Relevant memory: recall
 * this whenever someone asks '<X>'" were saved (P(concrete) 0.55-0.82) because <X> was a
 * gold query phrased as a statement ("changing it to a membership check fixed it"): the
 * model credited the memory with its trigger's words.
 */
import type { DecisionRequest, QuestionMap, YesNoQuestion } from '@papercusp/decision-model';

import { SUBSTANCE_CRITERIA, SUBSTANCE_INSTRUCTIONS } from './jev-admission-request';

export const SUBSTANCE_WORDINGS = ['v1', 'trigger'] as const;
export type SubstanceWording = (typeof SUBSTANCE_WORDINGS)[number];

export const TRIGGER_SUBSTANCE_INSTRUCTIONS =
  `${SUBSTANCE_INSTRUCTIONS} Text the memory only quotes as the occasion to recall it, such as a question someone ` +
  'might ask or a topic it says it applies to, is not information the memory states, even when that quoted text ' +
  'reads like a fact.';

export const TRIGGER_SUBSTANCE_CRITERIA = {
  yes:
    'The memory itself states at least one concrete fact, decision, procedure, preference or value, beyond any ' +
    'question or topic it quotes as the occasion to recall it.',
  no:
    'The memory only claims to be relevant, important, required or authoritative, or only names the questions or ' +
    'topics it should be recalled for, with no usable information of its own.',
} as const;

/** The instructions and criteria one substance wording asks. */
export function substanceWordingParts(wording: SubstanceWording): {
  readonly instructions: string;
  readonly criteria: { readonly yes: string; readonly no: string };
} {
  return wording === 'trigger'
    ? { instructions: TRIGGER_SUBSTANCE_INSTRUCTIONS, criteria: TRIGGER_SUBSTANCE_CRITERIA }
    : { instructions: SUBSTANCE_INSTRUCTIONS, criteria: SUBSTANCE_CRITERIA };
}

/** Parses a CLI `--substance-wording` value; an absent flag means `v1`, anything unknown throws. */
export function parseSubstanceWording(raw: string | undefined): SubstanceWording {
  const v = raw ?? 'v1';
  if (!(SUBSTANCE_WORDINGS as readonly string[]).includes(v)) {
    throw new Error(`--substance-wording must be ${SUBSTANCE_WORDINGS.join('|')}, got ${v}`);
  }
  return v as SubstanceWording;
}

/** The substance question for one memory text under a wording (the `instructions` encoding). */
export function substanceQuestion(wording: SubstanceWording, memoryText: string): YesNoQuestion {
  const { instructions, criteria } = substanceWordingParts(wording);
  return { type: 'yesNo', instructions: `${instructions}\n\nMemory:\n${memoryText}`, criteria };
}

/**
 * Returns `request` with its substance question re-asked under `wording`; every other
 * question and the state are untouched. `v1` returns the request unchanged, so a v1
 * bench run sends exactly the production bytes.
 */
export function withSubstanceWording(
  request: DecisionRequest<QuestionMap>,
  substanceId: string,
  memoryText: string,
  wording: SubstanceWording,
): DecisionRequest<QuestionMap> {
  if (wording === 'v1') return request;
  if (!(substanceId in request.questions)) throw new Error(`withSubstanceWording: no question ${substanceId}`);
  return { ...request, questions: { ...request.questions, [substanceId]: substanceQuestion(wording, memoryText) } };
}
