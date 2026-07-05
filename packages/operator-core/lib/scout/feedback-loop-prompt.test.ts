/**
 * feedback-loop-prompt.test.ts — pins the Queen↔Scout feedback-loop role-prompt
 * guidance (queen-scout-feedback-loop-2026-06-20 P-005 / D-001 / D-002 / D-003).
 *
 * The loop's behaviour lives entirely in PROMPT GUIDANCE (the wiring — Scout's
 * coord-inbox read + the cadence bypass + the deprecate emission — are sibling
 * briefs). This test is the anti-drift guard for that guidance: the Queen side
 * (`blueprints/base/prompts/mug.base.md` — renamed queen→mug, WI-2932) and the Scout side
 * ({@link SCOUT_FEEDBACK_LOOP_GUIDANCE}) must each carry the loop's invariants,
 * and must stay in LOCK-STEP — a refactor that strips the handshake out of either
 * surface, or lets the two drift apart, trips here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harnessPath } from '../harness-paths';
import { SCOUT_FEEDBACK_LOOP_GUIDANCE, SCOUT_DRAFT_LOOP_NOTE } from './feedback-loop-prompt';
import { buildScoutPlanTemplate } from './scout-plan-draft';

/** Collapse whitespace so assertions survive line-wrapping / re-indentation. */
const squish = (s: string) => s.replace(/\s+/g, ' ');

const QUEEN_BASE = harnessPath('blueprints', 'base', 'prompts', 'mug.base.md');
const queen = squish(readFileSync(QUEEN_BASE, 'utf8'));
const scout = squish(SCOUT_FEEDBACK_LOOP_GUIDANCE);

/**
 * The invariants BOTH sides of the handshake must state — the loop is symmetric,
 * so the Queen persona and the Scout guidance both have to carry them or the
 * iteration is under-specified on one side.
 */
const SHARED_INVARIANTS: Array<[label: string, re: RegExp]> = [
  ['references the feedback the iteration acts on', /feedback/i],
  ['the "gap to ready is shrinking?" heuristic', /\bshrinking\b/i],
  ['the "am I re-litigating?" heuristic', /re-litigating/i],
  ['the execution-vs-premise heuristic (execution)', /\bexecution\b/i],
  ['the execution-vs-premise heuristic (premise)', /\bpremise\b/i],
  ['the explicit "do not loop forever" bound (D-002)', /loop forever/i],
  ['the deprecate terminal outcome', /\bdeprecate\b/i],
  ['the atomic deprecate+emit call (B10 contract)', /plans:set-plan-status/],
  ['deprecate maps to status superseded', /superseded/i],
  ['the learnings observation carries what-is-salvageable', /salvageable/i],
  ['rides on coord:send (no new channel, D-001)', /coord:send/],
];

describe('Queen↔Scout feedback-loop prompt guidance (P-005)', () => {
  describe('shared invariants — present on BOTH the Queen and Scout sides', () => {
    for (const [label, re] of SHARED_INVARIANTS) {
      it(`Queen persona: ${label}`, () => expect(queen).toMatch(re));
      it(`Scout guidance: ${label}`, () => expect(scout).toMatch(re));
    }
  });

  describe('Queen-side specifics (queen.base.md)', () => {
    it('has the dedicated feedback-loop bullet, plan-tagged', () => {
      expect(queen).toContain("Iterate on Scout's routed drafts");
      expect(queen).toContain('queen-scout-feedback-loop-2026-06-20');
    });

    it('frames it as the ITERATION signal, DISTINCT from the 1-5 grade (D-003 #5)', () => {
      expect(queen).toMatch(/ITERATION signal/);
      expect(queen).toMatch(/DISTINCT from the grade/i);
    });

    it('READY is Queen-only via plans:promote (D-003 #3)', () => {
      expect(queen).toMatch(/plans:promote/);
      expect(queen).toMatch(/only.*party who can mark a draft ready/i);
    });

    it('feedback is a plan-keyed coord:send with wake required', () => {
      expect(queen).toMatch(/wake: 'required'/);
      expect(queen).toMatch(/plan_slug/);
      expect(queen).toMatch(/scout:<hive>/); // the addressable Scout coord identity (P-003)
    });

    it('carries all four "still making progress?" heuristics', () => {
      expect(queen).toMatch(/address the prior feedback/i);
      expect(queen).toMatch(/gap to "ready" shrinking/i);
      expect(queen).toMatch(/re-litigating the same point/i);
      expect(queen).toMatch(/execution \(keep iterating\) or about the premise \(deprecate\)/i);
    });

    it('idle-gates review behind the plan-review activity — placement always wins (D-003 #2)', () => {
      expect(queen).toMatch(/plan-review/);
      expect(queen).toMatch(/placement\s+always wins/i);
      // and it is listed as an idle backlog in the idle mandate
      expect(queen).toMatch(/Scout draft review\/iteration/i);
    });
  });

  describe('Scout-side specifics (SCOUT_FEEDBACK_LOOP_GUIDANCE)', () => {
    it('tells Scout to announce a routed draft to the Queen (D-003 #1)', () => {
      expect(scout).toMatch(/announce it/i);
      expect(scout).toMatch(/coord:send\S* the Queen to announce/i);
    });

    it('tells Scout to revise the EXISTING draft, addressing the feedback (P-001 revision cycle)', () => {
      expect(scout).toMatch(/targeted revision/i);
      expect(scout).toMatch(/do not re-ideate from scratch/i);
      expect(scout).toMatch(/plan_slug/);
    });

    it('reserves READY to the Queen and gives Scout self-deprecate as its terminal move', () => {
      expect(scout).toMatch(/only the queen marks a draft ready/i);
      expect(scout).toMatch(/self-deprecate/i);
    });

    it('the four heuristics are stated from Scout\'s point of view', () => {
      expect(scout).toMatch(/close the feedback/i);
      expect(scout).toMatch(/shrinking/i);
      expect(scout).toMatch(/re-litigating/i);
      expect(scout).toMatch(/execution.*keep iterating.*premise.*deprecate/i);
    });
  });

  describe('the draft template is self-documenting about the loop', () => {
    const body = buildScoutPlanTemplate({
      slug: 'demo-idea-2026-06-20',
      title: 'Demo idea',
      date: '2026-06-20',
    });

    it('embeds the loop note in the draft ## Now (the Queen reads this on review)', () => {
      expect(body).toContain(SCOUT_DRAFT_LOOP_NOTE);
      expect(body).toContain('status: draft');
      expect(body).toContain('origin: scout');
    });

    it('the loop note names the loop and both terminal outcomes', () => {
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/Queen↔Scout feedback loop/);
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/ready/);
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/deprecates it with a `learnings` observation/);
    });
  });
});
