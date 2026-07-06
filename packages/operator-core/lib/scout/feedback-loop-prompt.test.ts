/**
 * feedback-loop-prompt.test.ts — pins the Mug↔Blender feedback-loop role-prompt
 * guidance (queen-scout-feedback-loop-2026-06-20 P-005 / D-001 / D-002 / D-003).
 *
 * The loop's behaviour lives entirely in PROMPT GUIDANCE (the wiring — Blender's
 * coord-inbox read + the cadence bypass + the deprecate emission — are sibling
 * briefs). This test is the anti-drift guard for that guidance: the Mug side
 * (`blueprints/base/prompts/mug.base.md` — renamed queen→mug, WI-2932) and the Blender side
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

const MUG_BASE = harnessPath('blueprints', 'base', 'prompts', 'mug.base.md');
const mug = squish(readFileSync(MUG_BASE, 'utf8'));
const blender = squish(SCOUT_FEEDBACK_LOOP_GUIDANCE);

/**
 * The invariants BOTH sides of the handshake must state — the loop is symmetric,
 * so the Mug persona and the Blender guidance both have to carry them or the
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

describe('Mug↔Blender feedback-loop prompt guidance (P-005)', () => {
  describe('shared invariants — present on BOTH the Mug and Blender sides', () => {
    for (const [label, re] of SHARED_INVARIANTS) {
      it(`Mug persona: ${label}`, () => expect(mug).toMatch(re));
      it(`Blender guidance: ${label}`, () => expect(blender).toMatch(re));
    }
  });

  describe('Mug-side specifics (mug.base.md)', () => {
    it('has the dedicated feedback-loop bullet, plan-tagged', () => {
      expect(mug).toContain("Iterate on Blender's routed drafts");
      expect(mug).toContain('queen-scout-feedback-loop-2026-06-20');
    });

    it('frames it as the ITERATION signal, DISTINCT from the 1-5 grade (D-003 #5)', () => {
      expect(mug).toMatch(/ITERATION signal/);
      expect(mug).toMatch(/DISTINCT from the grade/i);
    });

    it('READY is Mug-only via plans:promote (D-003 #3)', () => {
      expect(mug).toMatch(/plans:promote/);
      expect(mug).toMatch(/only.*party who can mark a draft ready/i);
    });

    it('feedback is a plan-keyed coord:send with wake required', () => {
      expect(mug).toMatch(/wake: 'required'/);
      expect(mug).toMatch(/plan_slug/);
      expect(mug).toMatch(/blender:<pot>/); // the addressable Blender coord identity (P-003)
    });

    it('carries all four "still making progress?" heuristics', () => {
      expect(mug).toMatch(/address the prior feedback/i);
      expect(mug).toMatch(/gap to "ready" shrinking/i);
      expect(mug).toMatch(/re-litigating the same point/i);
      expect(mug).toMatch(/execution \(keep iterating\) or about the premise \(deprecate\)/i);
    });

    it('idle-gates review behind the plan-review activity — placement always wins (D-003 #2)', () => {
      expect(mug).toMatch(/plan-review/);
      expect(mug).toMatch(/placement\s+always wins/i);
      // and it is listed as an idle backlog in the idle mandate
      expect(mug).toMatch(/Blender draft review\/iteration/i);
    });
  });

  describe('Blender-side specifics (SCOUT_FEEDBACK_LOOP_GUIDANCE)', () => {
    it('tells Blender to announce a routed draft to the Mug (D-003 #1)', () => {
      expect(blender).toMatch(/announce it/i);
      expect(blender).toMatch(/coord:send\S* the Mug to announce/i);
    });

    it('tells Blender to revise the EXISTING draft, addressing the feedback (P-001 revision cycle)', () => {
      expect(blender).toMatch(/targeted revision/i);
      expect(blender).toMatch(/do not re-ideate from scratch/i);
      expect(blender).toMatch(/plan_slug/);
    });

    it('reserves READY to the Mug and gives Blender self-deprecate as its terminal move', () => {
      expect(blender).toMatch(/only the mug marks a draft ready/i);
      expect(blender).toMatch(/self-deprecate/i);
    });

    it('the four heuristics are stated from Blender\'s point of view', () => {
      expect(blender).toMatch(/close the feedback/i);
      expect(blender).toMatch(/shrinking/i);
      expect(blender).toMatch(/re-litigating/i);
      expect(blender).toMatch(/execution.*keep iterating.*premise.*deprecate/i);
    });
  });

  describe('the draft template is self-documenting about the loop', () => {
    const body = buildScoutPlanTemplate({
      slug: 'demo-idea-2026-06-20',
      title: 'Demo idea',
      date: '2026-06-20',
    });

    it('embeds the loop note in the draft ## Now (the Mug reads this on review)', () => {
      expect(body).toContain(SCOUT_DRAFT_LOOP_NOTE);
      expect(body).toContain('status: draft');
      expect(body).toContain('origin: scout');
    });

    it('the loop note names the loop and both terminal outcomes', () => {
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/Mug↔Blender feedback loop/);
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/ready/);
      expect(SCOUT_DRAFT_LOOP_NOTE).toMatch(/deprecates it with a `learnings` observation/);
    });
  });
});
