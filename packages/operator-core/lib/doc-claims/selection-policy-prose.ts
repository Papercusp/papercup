/**
 * The responder bound is written in ONE place — `consult/selection-policies.ts` —
 * and this guard keeps every other surface from acquiring a second copy of it.
 *
 * ── Why this guard exists (unified-responder-selection-critique-and-grading
 * -2026-08-30 P-006) ─────────────────────────────────────────────────────────
 * The rubric-vetting cap lived as a hand-typed number at FIVE sites: CLAUDE.md's
 * ship-gate section, the vetting runbook's step 2, the ship-gate refusal message,
 * the goal-disposition refusal message, and a code comment above the vetting
 * check. When D-004 lowered the cap, the enforced value moved and all five kept
 * saying the old one — so the system spent that window instructing agents, in its
 * own refusal errors, to request a wider menu than the selector would grant.
 *
 * That is the derived-truth-ladder failure the repo names: a value that DESCRIBES
 * code, maintained by hand in prose. Rung 1 (DERIVE) is the fix — prose names the
 * POLICY KEY and the messages render from the registry — and this is rung 2 (PIN)
 * holding the fix in place, because nothing about the new text stops a future
 * editor from helpfully "clarifying" it back into a number.
 *
 * ── What it judges ───────────────────────────────────────────────────────────
 * Two subject kinds, because the two populations prove derivation differently:
 *
 *   'prose'  — the CLAUDE.md corpus and the vetting runbook. These must name the
 *              policy KEY (`rubric-vetting`) and must carry no hand-typed bound.
 *              The key is what makes them derived: it identifies the registry
 *              entry rather than quoting its value, and `selectionPolicy()`
 *              throws on an unknown key, so a rename fails loudly at the call
 *              site instead of rotting silently in a document.
 *   'source' — the agent-facing refusal messages. These must call the shared
 *              renderer (`rubricVettingConsultHint`) and must not spell a bound
 *              into their own strings.
 *
 * A subject that is empty, or that no longer mentions the vetting flow at all, is
 * a REFUSAL rather than a pass: this guard's whole value is that it fails when the
 * claim it protects has quietly stopped being made.
 */

/** What a subject must prove, given how it derives the bound. */
export type SubjectKind = 'prose' | 'source';

export interface ProseSubject {
  /** How a violation names this subject — a repo-relative path, normally. */
  label: string;
  kind: SubjectKind;
  text: string;
}

export interface SelectionPolicyViolation {
  subject: string;
  /** 1-indexed line within that subject; 0 when the finding is about the whole file. */
  line: number;
  excerpt: string;
  reason: string;
}

export interface SelectionPolicyProseVerdict {
  ok: boolean;
  violations: SelectionPolicyViolation[];
  /** How many subjects were actually scanned — the non-vacuity denominator. */
  measured: number;
}

/** The registry key every guarded prose surface must name instead of a number. */
export const REQUIRED_POLICY_KEY = 'rubric-vetting';

/** The shared renderer every guarded agent-facing message must call. */
export const REQUIRED_RENDERER = 'rubricVettingConsultHint';

/**
 * The shapes a hand-typed responder bound actually takes in this repo — each one
 * drawn from a site that really drifted, not invented:
 *   "min 1 / max 3"      CLAUDE.md, and both refusal messages
 *   "min:1/max:3"        the runbook's frontmatter description
 *   "max_agents:3"       the runbook's step 2 (an instruction to type the number)
 *   "max 3 responders"   the prose form the refusals used
 * `min_agents` is included for symmetry: the minimum is as much the policy's to
 * own as the maximum, and a doc that pins one will pin the other next.
 */
const BOUND_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = Object.freeze([
  {
    re: /\bmin\s*:?\s*\d+\s*\/\s*max\s*:?\s*\d+/gi,
    reason: 'hand-typed min/max responder bound — name the policy key instead',
  },
  {
    re: /\b(?:max|min)_agents\s*:\s*\d+/g,
    reason: 'instructs a hand-typed responder count — pass `policy` instead',
  },
  {
    re: /\b(?:max|min)(?:imum|)\s+\d+\s+responders?\b/gi,
    reason: 'spells a responder bound in prose — render it from the registry',
  },
  {
    re: /\b\d+\s+responders?\s+(?:max|min)\b/gi,
    reason: 'spells a responder bound in prose — render it from the registry',
  },
]);

/**
 * Does this text still describe the vetting consult at all? Used as the
 * non-vacuity floor: a guarded subject that has stopped mentioning the flow is
 * no longer evidence of anything, and silence is the failure mode a doc guard is
 * least able to notice on its own.
 */
function mentionsVettingFlow(text: string): boolean {
  return /rubric-vetting/.test(text) || (/vett/i.test(text) && /get_feedback/.test(text));
}

/** Line number (1-indexed) of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function excerptAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 200);
}

export function judgeSelectionPolicyProse(subjects: readonly ProseSubject[]): SelectionPolicyProseVerdict {
  const violations: SelectionPolicyViolation[] = [];

  if (subjects.length === 0) {
    return {
      ok: false,
      measured: 0,
      violations: [
        {
          subject: '(none)',
          line: 0,
          excerpt: '',
          reason: 'no subjects were scanned — this guard measured nothing, which is not a pass',
        },
      ],
    };
  }

  for (const subject of subjects) {
    if (!subject.text.trim()) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: 'subject is empty or unreadable — the claim it carries cannot be judged',
      });
      continue;
    }

    for (const { re, reason } of BOUND_PATTERNS) {
      // Fresh lastIndex per subject: these are module-level /g regexes.
      re.lastIndex = 0;
      let match: RegExpExecArray | null = re.exec(subject.text);
      while (match !== null) {
        violations.push({
          subject: subject.label,
          line: lineOf(subject.text, match.index),
          excerpt: excerptAt(subject.text, match.index),
          reason,
        });
        match = re.exec(subject.text);
      }
    }

    if (!mentionsVettingFlow(subject.text)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason:
          'no longer describes the rubric-vetting consult — either the claim moved (re-point this guard) or it was dropped',
      });
      continue;
    }

    if (subject.kind === 'prose' && !subject.text.includes(REQUIRED_POLICY_KEY)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: `describes the vetting consult without naming the '${REQUIRED_POLICY_KEY}' policy key — the bound would be back in prose`,
      });
    }

    if (subject.kind === 'source' && !subject.text.includes(REQUIRED_RENDERER)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: `agent-facing vetting message does not call ${REQUIRED_RENDERER}() — its bound is no longer derived from the registry`,
      });
    }
  }

  return { ok: violations.length === 0, violations, measured: subjects.length };
}

/** Render violations for an assertion message that points at the offending line. */
export function formatViolations(violations: readonly SelectionPolicyViolation[]): string {
  return violations
    .map((v) => `${v.subject}${v.line ? `:${v.line}` : ''} — ${v.reason}${v.excerpt ? `\n    ${v.excerpt}` : ''}`)
    .join('\n');
}
