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
  modeRequiresSubject,
  subjectRequiringModeIds,
  resolveImpliedModes,
  modeIndexMarkdown,
} from './registry';

/**
 * THE `implies` DECLARATION (D-003) — the field the cascade writes from and the
 * autonomy predicate now derives from.
 *
 * The population is PINNED, not merely spot-checked. A guard that only asserts
 * "goal implies auto" keeps passing after someone deletes `implies` from drain,
 * and a guard that iterates whatever it finds passes vacuously over an empty
 * set. Both failures look identical to a green run.
 */
describe('mode implications', () => {
  const declaring = MODES.filter((m) => m.implies?.length);

  it('pins the known-good population — the whole set, not a sample', () => {
    expect(declaring.map((m) => m.id).sort()).toEqual(['drain', 'goal']);
    expect(resolveImpliedModes('goal')).toEqual(['auto', 'ideate']);
    expect(resolveImpliedModes('drain')).toEqual(['auto']);
    expect(resolveImpliedModes('auto')).toEqual([]);
    expect(resolveImpliedModes('nonexistent')).toEqual([]);
  });

  it('only ever names modes that exist', () => {
    for (const m of declaring) {
      for (const id of m.implies!) expect(modeById(id), `${m.id} implies '${id}'`).not.toBeNull();
    }
  });

  /**
   * A mode that is ABOUT something cannot be implied — the cascade has no
   * subject to give it, and entering it unattributed silently zeroes the goal
   * stamping and attribution paths (EI-20015592992797890). The store refuses at
   * runtime; this is what stops the declaration existing at all.
   */
  it('never implies a mode that requires a subject', () => {
    for (const m of declaring) {
      for (const id of m.implies!) {
        expect(modeRequiresSubject(id), `${m.id} implies subject-requiring '${id}'`).toBe(false);
      }
    }
  });

  it('is acyclic — the closure terminates and never contains the mode itself', () => {
    for (const m of MODES) {
      const closure = resolveImpliedModes(m.id);
      expect(closure, m.id).not.toContain(m.id);
      expect(new Set(closure).size, `${m.id} closure has duplicates`).toBe(closure.length);
    }
  });

  /**
   * D-003's OTHER half: the contract states the implication as a FACT about the
   * agent's posture. The old wording — "if the autonomy axis is empty, also
   * mode:set auto" — instructed the agent to perform the write, which is exactly
   * the directive a compaction drops. If that phrasing comes back, the cascade
   * and the prose disagree about who is responsible, and the prose loses.
   */
  it('states each implication in the contract as done, never as an instruction to go do it', () => {
    for (const m of declaring) {
      expect(m.contract, `${m.id} tells the agent to set the mode itself`).not.toMatch(/also mode:set/i);
      for (const id of m.implies!) {
        expect(m.contract.toLowerCase(), `${m.id} contract never mentions '${id}'`).toContain(id);
      }
    }
  });

  /**
   * The derivation that makes drift impossible: `modeImpliesAutonomy` reads the
   * same field the cascade writes from, so "guards treat this session as
   * autonomous" and "this session actually holds an autonomy row" cannot be
   * separately true — which they were, for every GOAL session, until D-003.
   */
  it('derives modeImpliesAutonomy from implies, for every overlay that declares one', () => {
    for (const m of declaring) {
      const impliesAnAutonomyMode = m.implies!.some((id) => modeById(id)?.axis === 'autonomy');
      expect(modeImpliesAutonomy(m.id), m.id).toBe(impliesAnAutonomyMode);
    }
    // and the derived set still matches the standalone accessor
    expect([...autonomousModeIds()].sort()).toEqual(['auto', 'cold-auto', 'drain', 'goal']);
  });
});

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
    expect(modeImpliesAutonomy('goal')).toBe(true);
    // D-003: the autonomy reading is DERIVED from the same `implies` the cascade
    // writes from, so a session guards treat as autonomous is one that actually
    // holds the row. The old boolean `impliesAutonomy` could disagree with the
    // contract's "also mode:set auto" sentence; one field cannot.
    expect(goal!.implies).toEqual(['auto', 'ideate']);
    // P-012: the implication is STATED in the contract too — but as a FACT about
    // the agent's current posture (D-003), never as a step for it to perform.
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

/**
 * TEST mode (goal-mode-hardening-2026-08-10 P-006).
 *
 * Same reasoning as the GOAL block above: the contract IS the deliverable, so
 * the clauses that cost the most when absent are pinned by content and dropping
 * one reds this file. Each maps to a failure shape observed on this box rather
 * than to a testing platitude — see the per-assertion notes.
 */
describe('TEST mode', () => {
  const testMode = modeById('test');

  it('is registered as a stackable overlay', () => {
    expect(testMode).not.toBeNull();
    expect(testMode!.axis).toBe('overlay');
  });

  /**
   * D-010. TEST declares NO implications, and that is a decision, not an
   * omission: testing is not an autonomy posture. A future edit that "helpfully"
   * adds implies:['auto'] would silently make every TEST session autonomous —
   * including ones an owner is sitting in front of — so it must red here.
   */
  it('implies nothing, so entering it never changes the autonomy posture', () => {
    expect(testMode!.implies).toBeUndefined();
    expect(resolveImpliedModes('test')).toEqual([]);
    expect(modeImpliesAutonomy('test')).toBe(false);
    expect(autonomousModeIds()).not.toContain('test');
  });

  /**
   * D-010's other half. `subject` exists because downstream consumers JOIN on it
   * (work_items.goal_id is stamped FROM it); nothing joins on a test's subject,
   * so requiring one would gate the door on a value no consumer reads. Scope
   * belongs in mode:set's own instructions instead.
   */
  it('requires no subject — nothing downstream joins on a test subject', () => {
    expect(testMode!.requiresSubject).toBeUndefined();
    expect(modeRequiresSubject('test')).toBe(false);
    expect(subjectRequiringModeIds()).not.toContain('test');
  });

  it('keeps its index one-liner to a single line (P-008)', () => {
    expect(testMode!.oneLiner).not.toContain('\n');
  });

  it('carries INDEPENDENCE — test the contract, not the implementation', () => {
    const c = testMode!.contract;
    expect(c).toContain('INDEPENDENCE');
    // the specific trap: a test derived from the code ratifies the bug
    expect(c).toMatch(/restates the bug as the expectation/i);
  });

  /**
   * RED BEFORE GREEN has a repo-specific hazard attached, and the hazard is the
   * half that matters: the obvious way to prove falsifiability (mutate the file,
   * run, restore) races git-sync's whole-tree sweep and has already committed a
   * mutant. A clause that drifted back to bare "prove it can fail" would leave
   * the agent reaching for exactly that, so the sweep warning is pinned too.
   */
  it('carries RED BEFORE GREEN with the shared-tree mutation hazard attached', () => {
    const c = testMode!.contract;
    expect(c).toContain('RED BEFORE GREEN');
    expect(c).toMatch(/never by\s+mutating the shared tree/i);
    expect(c).toMatch(/git-sync sweeps/i);
    // and it must offer the safe alternative, not just forbid the unsafe one
    expect(c).toMatch(/in memory|scratch copy/i);
  });

  /**
   * The most-repeated local failure: a well-formed answer to a question nobody
   * asked — a suite that selected no files, a mock that dropped the column under
   * test, a grep whose pattern never appeared. Each reads as a pass.
   */
  it('carries ZERO WORK IS NOT A PASS with the population assertion', () => {
    const c = testMode!.contract;
    expect(c).toContain('ZERO WORK IS NOT A PASS');
    expect(c).toMatch(/POPULATION/);
    expect(c).toMatch(/matched no files|empty set/i);
  });

  it('carries REPORT, DON’T FIX — a defect is filed, not silently repaired', () => {
    const c = testMode!.contract;
    expect(c).toMatch(/REPORT, DON’T FIX|REPORT, DON'T FIX/);
    expect(c).toMatch(/destroys the evidence/i);
  });

  it('carries VERDICT WITH EVIDENCE including what could NOT be determined', () => {
    const c = testMode!.contract;
    expect(c).toContain('VERDICT WITH EVIDENCE');
    expect(c).toMatch(/could NOT determine/);
    expect(c).toMatch(/bounded measurement/i);
  });

  it('carries LEAVE THE TESTS BEHIND — committed tests, not a transcript', () => {
    const c = testMode!.contract;
    expect(c).toContain('LEAVE THE TESTS BEHIND');
    expect(c).toMatch(/committed tests/i);
  });
});

/**
 * Index completeness (P-008).
 *
 * The su playbooks' hand-written mode index had drifted to 5 entries against a
 * registry of 6, so two real modes were invisible to every agent that only ever
 * reads the index. modeIndexMarkdown() derives from MODES precisely so that
 * cannot happen — this is what keeps the derivation honest as MODES grows.
 */
describe('modeIndexMarkdown', () => {
  it('lists EVERY registered mode — no mode can be invisible to the index', () => {
    const md = modeIndexMarkdown();
    for (const def of MODES) {
      expect(md, `${def.id} missing from the index`).toContain(`**${def.id}**`);
      expect(md, `${def.id} one-liner missing`).toContain(def.oneLiner);
    }
    // the population is asserted, not just iterated: an empty MODES would pass
    // every loop above while listing nothing at all.
    expect(MODES.length).toBeGreaterThanOrEqual(7);
    expect(md.split('\n').filter((l) => l.startsWith('- **'))).toHaveLength(MODES.length);
  });
});
