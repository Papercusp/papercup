/**
 * QUEEN-Q01 — grade-routed-on-triage.
 *
 * Question: when the Queen triages routed Scout drafts (an EI tagged
 * `improvement-source:Scout` + a Scout draft plan, both UNGRADED), does she
 * call `scout:grade-idea` for them — keyed by the artifact ref she already
 * holds (D-007), grade 1–5 + a one-line critique — as part of the triage turn
 * (D-004 @ scout-idea-grading-2026-06-12)?
 *
 * The deferred-optional scenario B-06 flagged for B-08 close-out: every
 * deterministic layer (prompt sources, allowlist, C-2 SQL sovereignty, C-3
 * role derivation) is gate-tested; THIS is the behavioral leg — does the
 * prompt actually produce the tool call on a triage-shaped turn?
 *
 * Load-bearing asserts (ERROR): `scout:grade-idea` fired ≥1; every call
 * carries the C-3/D-007 shape — exactly one of ideaId/routedRef, an integer
 * grade 1..5, feedback ≤2000 — and NEVER a caller-supplied `gradedBy`
 * (attribution is derived server-side; inventing the arg is the D-004
 * violation the tool layer exists to prevent).
 */

import type { Scenario, ToolDispatchOverride, Violation } from '@papercusp/testing-shell/llm';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { QUEEN_RUBRIC } from '../../rubrics/queen';

function canonical(name: string): string {
  return name.replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic triage data: the queue read returns two routed Scout drafts
 *  (ungraded), and `scout:grade-idea` answers with the real C-3 success
 *  payload so the loop continues believably. */
export const ROUTED_DRAFTS_TRIAGE: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (canon === 'work_items:list') {
      return {
        content: [
          {
            text: JSON.stringify({
              items: [
                {
                  id: 'EI-352',
                  kind: 'change',
                  state: 'todo',
                  title:
                    "In the Hive, every 'needs-human' deferral occupies the same flat queue regardless of decision weight",
                  tags: ['improvement-source:Scout'],
                  routedRef: 'wi:EI-352',
                  scoutGrade: null,
                },
                {
                  id: 'WI-204',
                  kind: 'task',
                  state: 'todo',
                  title: 'Tighten the deploy-cli rollback log lines',
                  tags: [],
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'improvements:digest') {
      return {
        content: [
          {
            text: JSON.stringify({
              open: [
                {
                  id: 'EI-352',
                  kind: 'change',
                  title:
                    "In the Hive, every 'needs-human' deferral occupies the same flat queue regardless of decision weight",
                  tags: ['improvement-source:Scout'],
                  routedRef: 'wi:EI-352',
                  scoutGrade: null,
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'plans:get') {
      return {
        content: [
          {
            text: JSON.stringify({
              slug: 'scout-declared-artifacts-drift-2026-06-12',
              frontmatter: {
                title: 'Declared artifacts (insight file citations, on-disk migrations) silently drift from reality',
                status: 'draft',
                origin: 'scout',
              },
              now: { state: 'DRAFT — Scout-routed; awaiting Queen/owner triage.', next: 'Triage: adopt, defer, or drop.' },
              items: [],
            }),
          },
        ],
      };
    }
    if (canon === 'scout:grade-idea') {
      const a = (args ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            text: JSON.stringify({
              applied: true,
              gradedBy: 'Queen',
              ideaId: a.ideaId ?? 'scout-idea-analogical-1-1',
              idea: {
                ideaId: a.ideaId ?? 'scout-idea-analogical-1-1',
                lens: 'analogical',
                rail: 'improvement',
                routedRef: a.routedRef ?? null,
                humanGrade: a.grade ?? null,
                humanFeedback: a.feedback ?? null,
                gradedBy: 'Queen',
                gradedAt: '2026-06-12T06:00:00.000Z',
              },
            }),
          },
        ],
      };
    }
    return PASS_THROUGH;
  },
};

/** Every scout:grade-idea call must carry the C-3/D-007 shape. */
const GRADE_CALL_SHAPE = {
  kind: 'custom' as const,
  name: 'grade-call-shape',
  eval: (run: { turns: Array<{ toolCalls: Array<{ name: string; input: unknown }> }> }): Violation[] => {
    const violations: Violation[] = [];
    run.turns.forEach((turn, turnIdx) => {
      for (const call of turn.toolCalls) {
        if (canonical(call.name) !== 'scout:grade-idea') continue;
        const a = (call.input ?? {}) as Record<string, unknown>;
        const fail = (claim: string, suggestion: string) =>
          violations.push({
            assertKind: 'custom:grade-call-shape',
            severity: 'error',
            evidenceTurnIdx: turnIdx,
            claim,
            suggestion,
          });
        const hasIdea = typeof a.ideaId === 'string' && a.ideaId.length > 0;
        const hasRef = typeof a.routedRef === 'string' && (a.routedRef as string).length > 0;
        if (hasIdea === hasRef) {
          fail(
            `scout:grade-idea must carry EXACTLY ONE of ideaId/routedRef (got ${JSON.stringify(Object.keys(a))}).`,
            "D-007: key by the artifact ref you hold ('wi:<id>' | 'plan:<slug>' | 'gym:<id>'), or ideaId when you have it.",
          );
        }
        if (hasRef && !/^(wi:|plan:|gym:)/.test(a.routedRef as string)) {
          fail(
            `routedRef '${String(a.routedRef)}' is not a change-feed ref (wi:/plan:/gym:).`,
            'Pass the routed artifact ref exactly as held.',
          );
        }
        if (typeof a.grade !== 'number' || !Number.isInteger(a.grade) || a.grade < 1 || a.grade > 5) {
          fail(`grade must be an integer 1..5 (got ${JSON.stringify(a.grade)}).`, 'D-001: 5 = clear win, 3 = neutral, 1 = clear loss.');
        }
        if (a.feedback !== undefined && (typeof a.feedback !== 'string' || a.feedback.length > 2000)) {
          fail('feedback, when given, must be a string ≤2000 chars.', 'One-line critique is the intended payload (C-4).');
        }
        if ('gradedBy' in a) {
          fail(
            'gradedBy was caller-supplied — it is DERIVED from the caller role, never an arg.',
            'D-004: drop the gradedBy key; the tool layer attributes the grade.',
          );
        }
      }
    });
    return violations;
  },
};

export const QUEEN_Q01_GRADE_ROUTED_ON_TRIAGE: Scenario = {
  id: 'queen-Q01-grade-routed-on-triage',
  version: 1,
  target: 'queen',
  transport: 'in-process',
  description:
    'The Hive operator relays the Queen her wake brief: she woke to triage the backlog. Two routed Scout drafts are in the queue — EI-352 (an improvement tagged improvement-source:Scout, routedRef wi:EI-352, not yet graded) and the Scout draft plan scout-declared-artifacts-drift-2026-06-12 (routedRef plan:scout-declared-artifacts-drift-2026-06-12, not yet graded). Success: while triaging she grades each ungraded routed draft 1–5 with a one-line critique via scout:grade-idea keyed by the refs she holds, and the drafts still get normal triage decisions on their merits (grades are a pure learning signal, never a reject).',
  persona: {
    id: 'hive-wake-brief',
    description:
      'The Hive operator relaying the wake brief, terse and factual; answers follow-ups with queue facts only and never tells the Queen which tools to call.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'tool_fired', toolName: 'scout:grade-idea' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: ROUTED_DRAFTS_TRIAGE,
  asserts: [
    { kind: 'tool_called', name: 'scout:grade-idea', minTimes: 1 },
    GRADE_CALL_SHAPE,
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: QUEEN_RUBRIC,
};

export default QUEEN_Q01_GRADE_ROUTED_ON_TRIAGE;
