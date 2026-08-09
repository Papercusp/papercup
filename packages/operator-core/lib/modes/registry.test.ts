/**
 * The registry's UI display helpers.
 *
 * These exist because two GUI surfaces (the HUD session card, the Sessions
 * roster) each used to spell their own mode label and hover text, so only the
 * three modes someone remembered to write copy for were ever explained —
 * `cold-auto` and `grade` rendered a bare "Standing mode: grade". Deriving from
 * this registry means adding a mode explains it everywhere; these tests are what
 * keeps that true as MODES grows.
 */
import { describe, it, expect } from 'vitest';
import {
  MODES,
  modeChipLabel,
  modeChipTitle,
  modeById,
  modeImpliesAutonomy,
  autonomousModeIds,
} from './registry';

describe('modeChipLabel', () => {
  it('renders a mode id as a chip label, hyphens as spaces', () => {
    expect(modeChipLabel('auto')).toBe('AUTO');
    expect(modeChipLabel('cold-auto')).toBe('COLD AUTO');
  });

  it('passes an unknown id through rather than rendering an empty chip', () => {
    expect(modeChipLabel('sideways')).toBe('SIDEWAYS');
  });
});

describe('modeChipTitle', () => {
  it('explains every registered mode with its title and one-liner', () => {
    for (const def of MODES) {
      const title = modeChipTitle(def.id);
      expect(title, def.id).toContain(def.title);
      expect(title, def.id).toContain(def.oneLiner);
    }
  });

  it('adds provenance when the caller knows it — the half that makes it actionable', () => {
    expect(modeChipTitle('auto', { ownerDirected: true })).toContain('Set by the owner');
    expect(modeChipTitle('auto', { ownerDirected: false })).toContain('set this itself');
  });

  it('omits the provenance line entirely when it is unknown', () => {
    const t = modeChipTitle('auto');
    expect(t).not.toContain('Set by the owner');
    expect(t).not.toContain('set this itself');
  });

  it('degrades to a named fallback for an unregistered mode instead of throwing', () => {
    expect(modeChipTitle('sideways')).toContain('Standing mode: sideways');
  });
});

/**
 * The autonomy predicate (goal-mode-2026-08-07 P-012).
 *
 * This question — "is this session in a posture meant to outlive an owner
 * sitting there?" — was hardcoded at six call sites, and three had already
 * drifted apart, each omitting `cold-auto` with no comment saying why. One of
 * them was the unguarded-halt sweep, so the most autonomy-dependent posture in
 * the system was the one it did not sweep. These tests are what keeps the
 * derived predicate derived.
 */
describe('modeImpliesAutonomy', () => {
  it('counts the autonomy axis AND the overlays that declare they imply it', () => {
    expect(modeImpliesAutonomy('auto')).toBe(true);
    expect(modeImpliesAutonomy('cold-auto')).toBe(true);
    expect(modeImpliesAutonomy('drain')).toBe(true);
    expect(modeImpliesAutonomy('goal')).toBe(true);
  });

  it('does not sweep in overlays that are merely stackable', () => {
    expect(modeImpliesAutonomy('ideate')).toBe(false);
    expect(modeImpliesAutonomy('grade')).toBe(false);
  });

  it('returns false for an unregistered id rather than throwing', () => {
    expect(modeImpliesAutonomy('sideways')).toBe(false);
  });

  it('holds for EVERY autonomy-axis mode, so a new one is counted on arrival', () => {
    for (const def of MODES.filter((m) => m.axis === 'autonomy')) {
      expect(modeImpliesAutonomy(def.id), def.id).toBe(true);
    }
  });

  it('agrees with autonomousModeIds', () => {
    expect([...autonomousModeIds()].sort()).toEqual(
      MODES.filter((m) => modeImpliesAutonomy(m.id))
        .map((m) => m.id)
        .sort(),
    );
  });

  /**
   * CONTROL — a deliberately-wrong implementation kept here permanently.
   *
   * This is the exact list the six call sites used to spell. It must DISAGREE
   * with the registry predicate, which is what proves the predicate is derived
   * rather than a re-spelling of the same list. If someone reverts
   * modeImpliesAutonomy to a hardcoded set, this fails.
   */
  it('disagrees with the legacy hardcoded list it replaced (the drift it fixes)', () => {
    const legacyHardcoded = (id: string) => id === 'auto' || id === 'drain';
    const disagreements = MODES.map((m) => m.id).filter(
      (id) => legacyHardcoded(id) !== modeImpliesAutonomy(id),
    );
    // cold-auto and goal are exactly the postures the old list silently dropped.
    expect(disagreements.sort()).toEqual(['cold-auto', 'goal']);
  });
});

/**
 * GOAL mode (goal-mode-2026-08-07 P-004/P-005/P-006/P-012).
 *
 * The contract is the whole deliverable — it is the only thing injected when an
 * agent enters GOAL — so the clauses that cost the most when absent are pinned
 * here by content. Each assertion below maps to a plan item, and dropping one
 * in a future edit should red this file rather than silently weaken the mode.
 */
describe('GOAL mode', () => {
  const goal = modeById('goal');

  it('is registered as a stackable overlay that implies AUTO', () => {
    expect(goal).not.toBeNull();
    expect(goal!.axis).toBe('overlay');
    expect(goal!.impliesAutonomy).toBe(true);
    // P-012: the implication has to be STATED in the contract too — the agent
    // reading it is the one who has to also mode:set auto.
    expect(goal!.contract).toContain('GOAL implies AUTO');
  });

  it('keeps its index one-liner to a single line (P-008)', () => {
    expect(goal!.oneLiner).not.toContain('\n');
  });

  it('carries the arbitration rule — one placer per pot (P-006)', () => {
    expect(goal!.contract).toContain('ONE PLACER PER POT');
    expect(goal!.contract).toContain('pauseNewWork');
    expect(goal!.contract).toMatch(/never both/i);
  });

  // P-013 / D-015. The item's premise was that taking a pot leaves its draft
  // queue with NO disposer. Verified false: the scout-draft-review backstop
  // never touches the steering gate (it goes sweep -> wakeMug, never pot:wake),
  // and pauseNewWork empties the frontier, which makes the Mug reach plan-review
  // SOONER rather than later. So the real hazard is the opposite one — two
  // disposers racing the same queue, both writing dispositions that feed the
  // Blender corpus. The clause has to say "do not double-dispose", and a clause
  // that drifted back to "you are now the sole disposer" must fail here.
  it('tells a goal agent that pausing placement does NOT pause draft disposal (P-013)', () => {
    const c = goal!.contract;
    expect(c).toMatch(/PAUSING PLACEMENT DOES NOT PAUSE DISPOSAL/);
    expect(c).toMatch(/EXACTLY ONE disposition/);
    // it must point at the Mug's rules rather than restate them (prompt weight)
    expect(c).toContain('mug.base.md');
    // and it must NOT claim the goal agent inherits sole ownership of the queue
    expect(c).not.toMatch(/sole disposer|only disposer/i);
  });

  it('gates child-executes proof on the cup ROLE, not the spawn-id prefix (P-002)', () => {
    expect(goal!.contract).toContain("adv_sessions.role = 'cup'");
    expect(goal!.contract).toMatch(/proves "spawned", NOT "cup"/);
  });

  it('carries a mandatory kickoff question with a kill criterion and a spend ceiling', () => {
    expect(goal!.contract).toContain('KICKOFF QUESTION (mandatory)');
    expect(goal!.contract).toContain('KILL CRITERION');
    expect(goal!.contract).toContain('SPEND CEILING');
  });

  it('carries the durability clause that keeps a weeks-long goal off the transcript (P-007)', () => {
    expect(goal!.contract).toContain('DURABILITY');
    expect(goal!.contract).toContain('loop:checkpoint');
    expect(goal!.contract).toContain('work_items:checkpoint');
  });

  it('points at the goal RECORD, not a pot, for the kill criterion and spend (P-009)', () => {
    // The goals:* table is the only place a MULTI-project goal's kill criterion
    // and ceiling can live — one goal spawns many pots, so no single pot can
    // hold them. The contract has to say so, or the agent files neither.
    expect(goal!.contract).toContain('goals:create');
    expect(goal!.contract).toContain('goals:update');
    expect(goal!.contract).toMatch(/goal record is NOT a pot/i);
    // and a cold wake must be told to re-read it rather than reconstruct
    expect(goal!.contract).toContain('goals:get');
  });

  it('carries the standing owner-report cadence (P-008 of the plan)', () => {
    expect(goal!.contract).toContain('coord:escalate');
  });

  it('keeps the remaining guidance clauses that have no other home', () => {
    const c = goal!.contract;
    expect(c).toContain('CAPACITY PREFLIGHT'); // 1
    expect(c).toContain('DEDUP BEFORE CREATING'); // 7
    expect(c).toContain('TEMPLATES MANDATE'); // 8
    expect(c).toContain('RUBRIC REUSE'); // 9
    expect(c).toMatch(/SHIPPED, NOT GREEN/); // 6 — flags ship ON
  });
});
