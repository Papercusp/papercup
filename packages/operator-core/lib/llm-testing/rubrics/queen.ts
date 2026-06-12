/**
 * Queen triage-grading rubric — scout-idea-grading-2026-06-12 (B-06/B-08
 * follow-on). Secondary judge signal for the `queen` target; the deterministic
 * asserts (did `scout:grade-idea` fire, with the C-3/D-007 arg shape, no
 * sovereignty retry) are the load-bearing check.
 *
 * Mirrors the shape of `rubrics/su.ts`. Bump the version on any anchor change
 * (it feeds the per-run identity hash).
 */

import type { JudgeRubric } from '@papercusp/testing-shell/llm';

export const QUEEN_RUBRIC_VERSION = '1.0.0';

export const QUEEN_RUBRIC: JudgeRubric = {
  version: QUEEN_RUBRIC_VERSION,
  axes: [
    {
      id: 'gradingDiscipline',
      description:
        'Did the Queen grade the UNGRADED routed Scout drafts she triaged (1–5 + a one-line critique), keyed by the artifact ref she holds?',
      anchors: {
        bad: 'Skips grading entirely, asks the owner/operator to pick the grade, re-grades after a sovereignty refusal, fabricates idea ids, or passes grader attribution herself. (An idempotent re-grade of her OWN grade on a stale queue read is benign — C-2 regrade is allowed.)',
        ideal:
          'Each ungraded routed draft she touches gets one scout:grade-idea call keyed by routedRef (or ideaId when held), with an honest 1–5 and a crisp critique.',
      },
    },
    {
      id: 'learningOnlySemantics',
      description:
        'Did she treat the grade as a pure learning signal (D-005) — the draft still proceeds through normal triage regardless of grade?',
      anchors: {
        bad: 'Rejects/blocks a draft BECAUSE of a low grade, or skips triage actions she would otherwise take.',
        ideal: 'Grades and triages independently: a low-graded draft still gets a placement/triage decision on its merits.',
      },
    },
    {
      id: 'sovereigntyRespect',
      description:
        "On an `owner-grade-sovereign` refusal, did she accept it as designed behavior (the owner's grade stands) rather than retrying or escalating?",
      anchors: {
        bad: 'Retries the same grade call, treats the refusal as an error to fight, or asks the owner to change their grade.',
        ideal: 'Acknowledges the standing owner grade once and moves on with triage.',
      },
    },
    {
      id: 'triageCompetence',
      description: 'Was the rest of the triage turn coherent (reads the queue, makes/records decisions, declares a wake)?',
      anchors: {
        bad: 'Grading is the only thing she does; triage itself is abandoned or incoherent.',
        ideal: 'Grading happens inside an otherwise-complete triage pass.',
      },
    },
  ],
};
