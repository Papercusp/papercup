/**
 * The independent-grader menu bound must stay DERIVED from
 * `selection-policies.ts` (ACCEPTANCE_GRADING_POLICY), same discipline as
 * `selection-policy-prose.test.ts` next door — sibling policy, shared
 * mechanism.
 *
 * WI-1409611 / EI-21929043331389136: the rubric-vetting guard's own
 * docstring names "a code comment above the vetting check" as one of the
 * FIVE sites that drifted before P-006 — so a code comment describing a
 * DIFFERENT registry entry (`ACCEPTANCE_GRADING_POLICY`) is a demonstrated
 * member of the same future-drift population, even though today none of
 * these three sites is agent-facing and the documented value matches the
 * enforced one. This guard closes that coverage gap by reusing
 * `judgeSelectionPolicyProse`'s mechanism with the sibling key.
 *
 * `consult/selection-policies.ts:29` is deliberately NOT a subject here: it
 * is the registry's own JSDoc, a decision changelog ("was exactly 1, now
 * min 1 / max 2") describing history at the definition site — pinning it to
 * the live value would make a legitimate changelog line un-writable. The two
 * subjects below are pure explanatory comments in CONSUMERS of the registry
 * (three sites across them), which is exactly the population that drifted in
 * the original incident.
 *
 * Those two are still a HAND-MAINTAINED list, which is the very defect
 * EI-21929043331389136 aggregates — so `the derived census` below closes the
 * loop: it judges every tracked text file, so a third consumer added tomorrow
 * cannot escape by simply not being listed here.
 *
 * Same fixture-control discipline as the sibling file (CLAUDE.md's
 * mutation-probe rule, the "module you import" tier): every rule keeps a
 * permanent control proving the detector can still fail, so a later green
 * run stays evidence of something.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';
import {
  judgeSelectionPolicyProse,
  formatViolations,
  censusHandTypedBoundSites,
  formatBoundSites,
  type ProseSubject,
} from './selection-policy-prose';
import { trackedTextFiles, readTrackedText } from './tracked-text-files';

const GRADER_RELPATH = 'packages/operator-core/lib/acceptance-grader.ts';
const SELECT_RELPATH = 'packages/operator-core/lib/consult/acceptance-grader-select.ts';

const POLICY_KEY = 'ACCEPTANCE_GRADING_POLICY';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/**
 * The options every call in this file shares — the sibling-policy override.
 * `stillOnTopic` is deliberately LOOSER than "names the exact constant" (same
 * relationship as the rubric-vetting guard's `mentionsVettingFlow`, whose
 * second branch accepts "vett" + "get_feedback" without the literal
 * `rubric-vetting` substring): it is what makes the vacuity floor and the
 * "names the key" rule two DISTINCT, both-reachable failure modes instead of
 * one condition wearing two violation messages.
 */
const gradingOptions = {
  policyKey: POLICY_KEY,
  stillOnTopic: (text: string) => /acceptance.?grading/i.test(text) || (/\bgrader\b/i.test(text) && /\bmenu\b/i.test(text)),
  flowLabel: 'acceptance-grading menu',
};

const judgeOne = (subject: ProseSubject) => judgeSelectionPolicyProse([subject], gradingOptions);

/** A prose fixture that satisfies every rule, so a control isolates ONE defect. */
const cleanProse = [
  '// The grader menu is bounded by the shared ACCEPTANCE_GRADING_POLICY registry',
  "// entry (see selection-policies.ts) rather than a count typed into this comment.",
].join('\n');

describe('acceptance-grading prose stays derived (WI-1409611)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('catches a hand-typed "min N / max N" bound even when the key is also named', () => {
      const verdict = judgeOne({
        label: 'fixture/acceptance-grader.ts',
        kind: 'prose',
        text: 'the grader menu is min 1 / max 2 under the shared ACCEPTANCE_GRADING_POLICY',
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/hand-typed min\/max responder bound/);
    });

    it('catches prose that stays on-topic (mentions "acceptance-grading") but drops the exact policy key', () => {
      // stillOnTopic matches the loose mention below, so this clears the vacuity floor —
      // isolating the ONE defect this rule exists to catch: no `ACCEPTANCE_GRADING_POLICY` token.
      const verdict = judgeSelectionPolicyProse(
        [
          {
            label: 'fixture/prose',
            kind: 'prose',
            text: 'the acceptance-grading menu size comes from the shared registry entry, not a hand-typed count.',
          },
        ],
        gradingOptions,
      );
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(
        new RegExp(`without naming the '${POLICY_KEY}' policy key`),
      );
    });

    it('refuses a subject that no longer describes the acceptance-grading menu at all', () => {
      const verdict = judgeOne({ label: 'fixture/prose', kind: 'prose', text: 'Unrelated documentation body.' });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/no longer describes the acceptance-grading menu/);
    });

    it('refuses an empty subject and an empty subject list rather than passing vacuously', () => {
      expect(judgeOne({ label: 'fixture/prose', kind: 'prose', text: '   ' }).ok).toBe(false);
      const none = judgeSelectionPolicyProse([], gradingOptions);
      expect(none.ok).toBe(false);
      expect(none.measured).toBe(0);
    });

    it('CALIBRATION — the clean fixture passes, so the controls above indict the defect, not the rule', () => {
      const verdict = judgeSelectionPolicyProse([{ label: 'fixture/clean-prose', kind: 'prose', text: cleanProse }], gradingOptions);
      expect(formatViolations(verdict.violations)).toBe('');
      expect(verdict.ok).toBe(true);
      expect(verdict.measured).toBe(1);
    });
  });

  describe('the live subjects', () => {
    const subjects = (): ProseSubject[] => [
      { label: GRADER_RELPATH, kind: 'prose', text: read(GRADER_RELPATH) },
      { label: SELECT_RELPATH, kind: 'prose', text: read(SELECT_RELPATH) },
    ];

    it('every guarded surface is non-empty (non-vacuity floor)', () => {
      for (const subject of subjects()) {
        expect(subject.text.length, `${subject.label} is empty — the guard would measure nothing`).toBeGreaterThan(500);
      }
    });

    it('no surface spells the ACCEPTANCE_GRADING_POLICY bound by hand; both name the registry key', () => {
      const verdict = judgeSelectionPolicyProse(subjects(), gradingOptions);
      expect(formatViolations(verdict.violations)).toBe('');
      expect(verdict.ok).toBe(true);
      expect(verdict.measured).toBe(2);
    });
  });

  /**
   * The DERIVED half (EI-21929043331389136). Everything above is a pin; this
   * asks the repo which files actually carry a hand-typed bound, so a NEW
   * offender fails without anyone remembering to add it as a subject.
   *
   * Each exclusion below is a site whose bound is legitimately hand-written,
   * with the reason it cannot simply be rewritten. Adding to this list is a
   * deliberate act with an argument attached — which is the whole difference
   * between this and the pinned list it backstops.
   */
  describe('the derived census — every tracked file, not a pinned list', () => {
    const EXCLUDED = new Map<string, string>([
      [
        'packages/operator-core/lib/consult/selection-policies.ts',
        'the registry\'s own decision changelog at the definition site ("was exactly 1, now min 1 / max 2") — pinning it would make recording a bound CHANGE impossible',
      ],
      [
        'packages/operator-core/lib/doc-claims/selection-policy-prose.ts',
        'this guard\'s own pattern catalogue: it must contain the literal strings it detects, or it could not detect them',
      ],
    ]);

    const census = () =>
      censusHandTypedBoundSites({
        files: trackedTextFiles({ root: ROOT }),
        read: (relpath) => readTrackedText(ROOT, relpath),
        stillOnTopic: gradingOptions.stillOnTopic,
      });

    it('scans a real, non-empty population (the vacuity floor a derived guard needs most)', () => {
      const result = census();
      // If this ever collapses toward zero the guard has stopped measuring the
      // repo, and every assertion below would pass for the wrong reason.
      expect(result.scanned).toBeGreaterThan(1000);
    });

    it('FIXTURE CONTROL — the census reports an offender that is not on the exclusion list', () => {
      const result = censusHandTypedBoundSites({
        files: ['fixture/new-consumer.ts'],
        read: () => '// the acceptance-grading menu is min 1 / max 2, see selection-policies.ts',
        stillOnTopic: gradingOptions.stillOnTopic,
      });
      expect(result.sites.map((s) => s.path)).toEqual(['fixture/new-consumer.ts']);
      expect(formatBoundSites(result.sites)).toMatch(/hand-typed min\/max responder bound/);
    });

    it('FIXTURE CONTROL — an off-topic file carrying the same bound is NOT an offender', () => {
      const result = censusHandTypedBoundSites({
        files: ['fixture/unrelated.ts'],
        read: () => '// retries are min 1 / max 2 per attempt',
        stillOnTopic: gradingOptions.stillOnTopic,
      });
      expect(result.sites).toEqual([]);
      expect(result.scanned).toBe(1);
    });

    it('no tracked file spells the acceptance-grading bound by hand, except the reasoned exclusions', () => {
      const unexcused = census().sites.filter((s) => !EXCLUDED.has(s.path));
      expect(formatBoundSites(unexcused)).toBe('');
    });

    it('every exclusion is still a real offender — a stale excuse is deleted, not carried', () => {
      const found = new Set(census().sites.map((s) => s.path));
      for (const [path, reason] of EXCLUDED) {
        expect(
          found.has(path),
          `${path} no longer carries a hand-typed bound — drop this exclusion (${reason})`,
        ).toBe(true);
      }
    });
  });
});
