/**
 * main-greening-question-coverage.test.ts — THE COVERAGE PROOF FOR
 * `main-green-status-visible-2026-09-03` P-013.
 *
 * ── WHY THIS FILE IS RED ON PURPOSE, AND WHY IT WAS WRITTEN FIRST ─────────────
 *
 * Plan decision **D-003 §3** rules that this test is written BEFORE the items it
 * measures, and that it is expected to FAIL until they land:
 *
 *   "A plan whose items each look reasonable can still leave questions unanswered,
 *    because coverage is a property of the SET and every item is reviewed alone.
 *    [...] Write P-013 FIRST and RED. Written afterwards it can only ratify
 *    whatever was built; written first it measures the gap and cannot be satisfied
 *    by a surface that merely exists."
 *
 * So a failure here is this file DOING ITS JOB. Each failure names one audited
 * question the state plane cannot answer today. The plan is finished when this
 * file is green — NOT when its items read `done` (D-003 §4: "the plan ships on
 * COVERAGE, not on items terminal").
 *
 * ⚠ DO NOT "fix" a failure by editing the table below to match what the code does.
 * That inverts the instrument: the table is the SPEC (what an agent must be able to
 * read), and the code is the subject. An entry may be RE-BOUND to a better-named
 * cell as work reveals one — D-003 §1 permits exactly that — but it may never
 * become UNBOUND, and its `status` may only move toward `answered`.
 *
 * ── THE QUESTION SET IS AUDITED, NOT DESIGNED ────────────────────────────────
 *
 * The 24 entries are the P-001 deliverable (WI-2143262, comment 82058), derived
 * under the owner-directed method in D-001: mined from real session history, live
 * `gate_health`, `cell-registrations.ts` code-truth, and the CLAUDE.md gate
 * sections — never theorised. That matters, because a DESIGNED list reflects what
 * its designer already understands and therefore omits precisely the questions
 * that were expensive to answer. Every ABSENT below rests on a measurement
 * (a `grep -c` over the cell registry, a jsonb `?` test against the live routine
 * row), not on an impression.
 *
 * ── THE FALSIFIER ────────────────────────────────────────────────────────────
 *
 * Stated on the plan item itself: **a red non-test leg must never produce a
 * "nothing failing" reading from any cell this checklist names.** That single
 * assertion would have caught every BROKEN entry in the audit. It is the last
 * describe block, and it drives the real composers with a fixture reproducing the
 * exact live condition — red on a lint leg, with a repair queue open — under which
 * four separate surfaces currently read as all-clear.
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_CELLS } from './cell-registrations';
import { pathExists } from './state-plane-stamp';
import { composeGateOwnerBrief, type GateOwnerBriefInput } from './gate-owner-brief';
import { gateFailingTestsMeasurement } from './git-pipeline-stats';

/* ═══════════════════════════════════════════════════════════════════════════════
 * THE AUDITED QUESTION SET
 * ══════════════════════════════════════════════════════════════════════════════ */

type Binding = {
  /** The registered cell id that must answer this question. */
  cell: string;
  /** The path INTO that cell's payload carrying the answer. */
  path: string;
};

type Entry = {
  id: number;
  cluster: string;
  question: string;
  /**
   * The cell that must answer this question.
   *
   * For an entry the audit found ANSWERED, this is the cell that answers it today,
   * and the job here is regression cover: a refactor for another entry must not
   * silently un-answer one that already worked (D-003 §1 — "They are not therefore
   * safe").
   *
   * For an entry the audit found ABSENT, this is the TARGET binding — a name
   * authored by P-013 so the owning item has a concrete surface to build rather
   * than a description to interpret. The owning item MAY rename it (record the
   * re-binding in the plan); it may NOT leave the entry unbound.
   */
  binding: Binding;
  /** The plan item that owes this entry, per D-003 §1's binding map. */
  owedBy: 'answered-today' | string;
  /**
   * What the P-001 audit measured. `answered` entries must stay answered;
   * every other value is a gap this file exists to keep visible.
   */
  status: 'answered' | 'partial' | 'broken' | 'absent';
};

/**
 * The 24 questions, verbatim from the P-001 audit (WI-2143262 comment 82058).
 *
 * Tally at audit time (2026-09-03T04:22–04:28Z): 15 answered · 2 partial ·
 * 2 broken · 5 absent — 9 of 24 not answerable, clustered entirely in
 * "which leg is failing" and "is the repair converging", which are the two
 * clusters the owner's directive named.
 */
const QUESTIONS: readonly Entry[] = [
  // ── A. Where my change is ──────────────────────────────────────────────────
  {
    id: 1,
    cluster: 'A. Where my change is',
    question: 'Did my work reach origin?',
    binding: { cell: 'git.pipelinePosition', path: 'gitSync.pushedRepos' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 2,
    cluster: 'A. Where my change is',
    question: 'Is the running process executing my code?',
    binding: { cell: 'deploy.3070.sha', path: 'serving.startedSinceCodeChange' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 3,
    cluster: 'A. Where my change is',
    question: 'Will the next sweep commit my half-finished refactor?',
    binding: { cell: 'git.pipelinePosition', path: 'sweepExposure' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 4,
    cluster: 'A. Where my change is',
    question: 'Is the gate judging MY code?',
    binding: { cell: 'gate.greenCheckpoint.candidate', path: 'changeInCandidate.judgingContainsPath' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 5,
    cluster: 'A. Where my change is',
    question: 'Same question for a path inside a SUBMODULE',
    // Was PARTIAL at audit time: dev:pipeline_position was submodule-aware for HISTORY,
    // but containment for a submodule path came back `not-applicable`, and CLAUDE.md
    // carried a 5-command gitlink recipe plus three documented false-negative traps.
    // ~37 submodules here, and EVERY db migration lives in one. P-011 closed it: the
    // containment leg resolves the gitlink each candidate pins and compares INSIDE the
    // submodule, and `changeInCandidate.submodule` surfaces the pins (see the P-011
    // describe block in git-pipeline-position.test.ts — contained / not-bumped /
    // unreadable-gitlink / marker-inside-the-pin).
    binding: { cell: 'gate.greenCheckpoint.candidate', path: 'changeInCandidate.submodule' },
    owedBy: 'P-011',
    status: 'answered',
  },

  // ── B. Which sha ───────────────────────────────────────────────────────────
  {
    id: 6,
    cluster: 'B. Which sha',
    question: 'Which sha is the run judging right now?',
    binding: { cell: 'gate.greenCheckpoint.candidate', path: 'judgingSha' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 7,
    cluster: 'B. Which sha',
    question: 'Is that reading authoritative, or inferred?',
    // The plane's best existing work: a cell that states how much to trust itself.
    binding: { cell: 'gate.greenCheckpoint.candidate', path: 'source.authoritative' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 8,
    cluster: 'B. Which sha',
    question: 'Is main behind staging, and did it fast-forward?',
    binding: { cell: 'git.mainBehindStaging', path: 'behindBy' },
    owedBy: 'answered-today',
    status: 'answered',
  },

  // ── C. The verdict ─────────────────────────────────────────────────────────
  {
    id: 9,
    cluster: 'C. The verdict',
    question: 'Is main green?',
    binding: { cell: 'gate.greenCheckpoint.ownerBrief', path: 'mainGreen.value' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 10,
    cluster: 'C. The verdict',
    question: 'How many consecutive reds, and when was the last green?',
    binding: { cell: 'gate.greenCheckpoint.verdict', path: 'consecutiveReds' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 11,
    cluster: 'C. The verdict',
    question: 'Is this red STALE or CURRENT?',
    binding: { cell: 'gate.greenCheckpoint.verdict', path: 'verdictStale' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 12,
    cluster: 'C. The verdict',
    question: 'Is the gate even firing?',
    binding: { cell: 'gate.greenCheckpoint.verdict', path: 'fireStale' },
    owedBy: 'answered-today',
    status: 'answered',
  },

  // ── D. Why is it red — the owner's actual question, and the weakest area ────
  {
    id: 13,
    cluster: 'D. Why is it red',
    question: 'WHICH LEGS ARE FAILING?',
    // BROKEN. Measured 04:26Z and again live at 05:41Z: returns [] while
    // gate_health.failingTests names two lint legs with failingTestsMeasured:true.
    // Cause: git-pipeline-stats.ts `gateFailingTestsMeasurement` discards a MEASURED,
    // POPULATED list whenever `inconclusive !== null` — which it is for the whole
    // duration of a frozen repair, i.e. exactly when you need the list most.
    binding: { cell: 'gate.greenCheckpoint.ownerBrief', path: 'whyNot.failingLegs' },
    owedBy: 'P-005',
    status: 'broken',
  },
  {
    id: 14,
    cluster: 'D. Why is it red',
    question: 'How many test FILES fail on the frozen candidate, and did their fixes land?',
    binding: { cell: 'gate.greenCheckpoint.candidateFailures', path: 'stillBrokenCount' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 15,
    cluster: 'D. Why is it red',
    question: 'Did the non-test legs even RUN?',
    // ANSWERED by P-003. `postSuiteMeasured` was broken twice over — one tri-state boolean
    // for four unrelated legs, AND never actually supplied (computed in green-checkpoint.ts,
    // consumed only for a prose note in a log file, never persisted, so it resolved `null`
    // forever while looking like a measurement that came back empty). Independently
    // diagnosed by a peer in WI-2142763: two agents reached it separately, which is
    // corroboration rather than an echo. It is now DELETED, and this binds to a two-value
    // reading derived from data the resolver really holds — with no fabricable third state.
    binding: { cell: 'gate.greenCheckpoint.candidateFailures', path: 'nonTestLegsMeasured' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 16,
    cluster: 'D. Why is it red',
    question: 'WHICH non-test leg, by name?',
    // ANSWERED by P-003, over the P-002 lifecycle. `nonTestLegs.perLeg` is one row per leg
    // across the UNION of this tick's measurement and the cycle's lifecycle, so a leg the
    // tick did not run is still named (with `measuredNow: 'not-measured'`) instead of
    // silently vanishing from the list — not looking is not a pass (D-005 rule 4).
    binding: { cell: 'gate.greenCheckpoint.candidateFailures', path: 'nonTestLegs.perLeg' },
    owedBy: 'answered-today',
    status: 'answered',
  },

  // ── E. Convergence / repair — nothing is on the plane ───────────────────────
  {
    id: 17,
    cluster: 'E. Convergence / repair',
    question: 'IS THE QUEUE CONVERGING — is the failing set shrinking?',
    // ABSENT: `shrink` appears 0x in cell-registrations.ts. Measured cost of this gap:
    // an hour spent watching shrinkTotal:0 before diagnosing why (-> WI-2143253).
    binding: { cell: 'gate.greenCheckpoint.convergence', path: 'shrinkTotal' },
    owedBy: 'P-004',
    status: 'absent',
  },
  {
    id: 18,
    cluster: 'E. Convergence / repair',
    question: 'How long has the freeze been open, and which round is it on?',
    binding: { cell: 'gate.greenCheckpoint.convergence', path: 'ageMs' },
    owedBy: 'P-004',
    status: 'absent',
  },
  {
    id: 19,
    cluster: 'E. Convergence / repair',
    question: 'IS FREEZE-AND-CONVERGE ON, AND IF NOT WHY?',
    // ABSENT THOUGH DOCUMENTED — the single highest-value gap in the set. CLAUDE.md says
    // this "is a READ", and guard-rail:gate-lane-boundaries-wi212675 names the same path as
    // its recheck probe — but `metadata->'gate_health' ? 'freezeAndConverge'` measured FALSE
    // (32 keys, not one of them). The writer exists and is called, but swallows every error.
    // P-008 must make the WRITE land before P-004 registers a cell over it, or the cell
    // resolves `unknown` forever while looking complete.
    binding: { cell: 'gate.greenCheckpoint.freezeDisposition', path: 'state' },
    owedBy: 'P-008 then P-004',
    status: 'absent',
  },
  {
    id: 20,
    cluster: 'E. Convergence / repair',
    question: 'Is the fixer alive, or is this a zero-attempt stall?',
    // Fired correctly at audit time: red-owned-stalled with fixerAlive:false.
    binding: { cell: 'gate.greenCheckpoint.ownerBrief', path: 'remediation.fixerAlive' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 21,
    cluster: 'E. Convergence / repair',
    question: 'Is an auto-refire / re-triage IN FLIGHT — must I stand down?',
    // ABSENT: answerable only from release:checkpoint-run's own refusal payload. CLAUDE.md
    // gives it a standalone alarm block ("discards the rescue and costs a full suite"), which
    // is a question important enough to warrant a read rather than a refusal you must provoke.
    binding: { cell: 'gate.greenCheckpoint.retriage', path: 'inFlight' },
    owedBy: 'P-009',
    status: 'absent',
  },

  // ── F. Ownership ───────────────────────────────────────────────────────────
  {
    id: 22,
    cluster: 'F. Ownership',
    question: 'Who owns the red, are they live, and may I act?',
    binding: { cell: 'gate.greenCheckpoint.ownership', path: 'claimState' },
    owedBy: 'answered-today',
    status: 'answered',
  },
  {
    id: 23,
    cluster: 'F. Ownership',
    question: 'What is the safe next action / qualification phase?',
    binding: { cell: 'gate.greenCheckpoint.qualification', path: 'safeNextAction' },
    owedBy: 'answered-today',
    status: 'answered',
  },

  // ── G. Can I trust the reading itself ──────────────────────────────────────
  {
    id: 24,
    cluster: 'G. Can I trust the reading',
    question: 'How old is each number, and are they mutually consistent?',
    // PARTIAL: `vintageSpreadMs` exists and read 1h57m at audit time (3h14m live at 05:41Z) —
    // the brief fuses values hours apart. But the per-field attestations live in gate_health
    // only: `attestation` appears 0x in cell-registrations.ts.
    binding: { cell: 'gate.greenCheckpoint.ownerBrief', path: 'attestations' },
    owedBy: 'P-010',
    status: 'partial',
  },
];

/**
 * Entries deliberately excluded from the coverage requirement, each with a reason.
 *
 * D-003 §1: "An entry may be re-bound as work reveals a better home. It may NOT
 * become unbound: dropping an entry requires saying so here, with a reason, exactly
 * as `plans:set-status dropped` requires one."
 *
 * EMPTY BY DESIGN, and it should stay that way. This exists so that dropping a
 * question is a visible, reasoned act rather than a quiet deletion from the table
 * above — the same reason `cell-live-matrix.ts` keeps a named `KNOWN_GAPS` record
 * instead of letting an unexplained square pass.
 */
const OUT_OF_SCOPE: Readonly<Record<number, string>> = {};

const inScope = (e: Entry): boolean => !(e.id in OUT_OF_SCOPE);
const registeredCellIds = new Set(BUILTIN_CELLS.map((c) => c.cell));

/* ═══════════════════════════════════════════════════════════════════════════════
 * 1. THE TABLE ITSELF IS WELL-FORMED
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('P-013: the audited question set is intact', () => {
  it('carries all 24 audited questions, with unique contiguous ids', () => {
    expect(QUESTIONS).toHaveLength(24);
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(24);
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it('binds every question to a cell and a path — no entry is unbound', () => {
    const unbound = QUESTIONS.filter(
      (q) => !q.binding || !q.binding.cell.trim() || !q.binding.path.trim(),
    );
    expect(
      unbound.map((q) => `#${q.id} ${q.question}`),
      'D-003 §1: an entry may be RE-BOUND but never UNBOUND. Bind it, or drop it in ' +
        'OUT_OF_SCOPE with a stated reason.',
    ).toEqual([]);
  });

  it('states a reason for every out-of-scope entry, and excludes nothing silently', () => {
    for (const [id, reason] of Object.entries(OUT_OF_SCOPE)) {
      expect(QUESTIONS.some((q) => q.id === Number(id)), `#${id} is not an audited question`).toBe(
        true,
      );
      expect(reason.trim().length, `#${id} is excluded with an empty reason`).toBeGreaterThan(20);
    }
  });

  it('owes every unanswered entry to a named plan item', () => {
    const orphaned = QUESTIONS.filter(
      (q) => inScope(q) && q.status !== 'answered' && q.owedBy === 'answered-today',
    );
    expect(
      orphaned.map((q) => `#${q.id} ${q.question}`),
      'a gap with no owning item is a gap nobody is going to close',
    ).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * 2. COVERAGE — EVERY QUESTION'S CELL ACTUALLY EXISTS
 *
 * This is the block that goes RED today. Entries 17, 18, 19 and 21 name cells that
 * the registry does not contain, which is precisely the audit's ABSENT finding
 * restated as a machine check rather than as prose in a work-item comment.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('P-013: every audited question is answerable from a REGISTERED cell', () => {
  it.each(QUESTIONS.filter(inScope).map((q) => [q.id, q.question, q.binding.cell, q.owedBy] as const))(
    '#%s %s -> %s',
    (id, question, cell, owedBy) => {
      expect(
        registeredCellIds.has(cell),
        `Q#${id} ("${question}") is bound to cell "${cell}", which is NOT registered in ` +
          `cell-registrations.ts. Owed by ${owedBy}. This is a COVERAGE GAP, not a typo: ` +
          `an agent asking this question today has no cell to read. Register the cell (or ` +
          `re-bind the entry to one that answers it) — do not delete the question.`,
      ).toBe(true);
    },
  );

  it('reports the full coverage tally so progress is visible in one line', () => {
    const scoped = QUESTIONS.filter(inScope);
    const missing = scoped.filter((q) => !registeredCellIds.has(q.binding.cell));
    const answered = scoped.filter((q) => q.status === 'answered');
    // Not an assertion about the count — an assertion that the plan is not finished
    // while any audited question lacks a cell. D-003 §4: ships on coverage, not items.
    expect(
      missing.map((q) => `#${q.id} -> ${q.binding.cell} (owed by ${q.owedBy})`),
      `COVERAGE: ${answered.length}/${scoped.length} answered at audit time; ` +
        `${missing.length} question(s) still have no registered cell.`,
    ).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * 3. THE FIXTURE — the exact live condition four surfaces read as all-clear
 * ══════════════════════════════════════════════════════════════════════════════ */

const T0 = 1_788_400_000_000;

/**
 * A gate that is RED ON A NON-TEST LEG with a repair queue OPEN.
 *
 * Every value mirrors a real reading taken from this workspace's live gate on
 * 2026-09-03 (routines:list green-checkpoint @04:22Z; state:read @04:26Z and
 * again @05:41Z), so this is a reproduction of an observed state rather than an
 * invented one. Two lint legs failing, `failingTestsMeasured: true`, and
 * `inconclusive.status: 'repair-in-progress'` — the combination under which the
 * owner brief currently reports nothing failing at all.
 */
const RED_LINT_LEG_WITH_OPEN_REPAIR = {
  failingTests: ['lint:design-primitives', 'lint:plane-integrity'],
  failingTestsMeasured: true,
  inconclusive: {
    status: 'repair-in-progress',
    detail: 'frozen candidate held for repair',
    observedAtMs: T0,
  },
} as const;

/**
 * ⚠ THE COMPOSER IS FED THROUGH `gateFailingTestsMeasurement`, EXACTLY AS PRODUCTION
 * DOES IT (`git-pipeline-stats.ts` — `gateFailingTestsMeasurement(...)` then
 * `failingTestsMeasurement.failingTests` into the brief).
 *
 * Handing `composeGateOwnerBrief` the raw failing list instead would route AROUND the
 * defect: the composer itself renders `failingLegs: inp.failingTests ?? []` faithfully,
 * so a fixture that pre-supplies the list makes the brief look correct and the falsifier
 * pass while the shipped read still returns []. That mistake was made in this file's
 * first draft and caught by running it — recorded here because the next author editing
 * this fixture will be tempted by the same shortcut. Reproduce the WIRING, not just the
 * inputs.
 */
const productionFailingTests = () =>
  gateFailingTestsMeasurement({
    failingTests: [...RED_LINT_LEG_WITH_OPEN_REPAIR.failingTests],
    measured: RED_LINT_LEG_WITH_OPEN_REPAIR.failingTestsMeasured,
    inconclusive: { ...RED_LINT_LEG_WITH_OPEN_REPAIR.inconclusive } as never,
  });

const ownerBriefInput = (): GateOwnerBriefInput => ({
  nowMs: T0 + 60_000,
  consecutiveReds: 101,
  failingTests: productionFailingTests().failingTests,
  failingTestsMeasured: productionFailingTests().measured,
  lastGreenAtMs: T0 - 13 * 24 * 3_600_000,
  verdictObservedAtMs: T0,
  fireStale: false,
  verdictStale: false,
  inconclusive: { ...RED_LINT_LEG_WITH_OPEN_REPAIR.inconclusive },
  repairQueue: {
    phase: 'awaiting-fixer',
    attempts: 3,
    updatedAtMs: T0,
    ageMs: 3_600_000,
    fixerSpawnId: 'spawn-abc',
    fixerAlive: true,
    zeroAttemptStalled: false,
  },
  // `assessment` is the ownership oracle's closed string union, not an object — a
  // held claim whose holder is POSITIVELY live. No cast: if the oracle's vocabulary
  // changes, this fixture should fail to compile rather than quietly describe a state
  // that no longer exists.
  ownership: {
    claimState: 'held',
    takenBy: 'su-peer',
    workItem: 'WI-212675',
    assessment: 'held-live',
  },
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * 4. THE FALSIFIER
 *
 * "A red non-test leg must never produce a `none-failing` reading from any cell the
 * checklist names." Stated on plan item P-013; ruled load-bearing by D-003 §3.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('P-013 FALSIFIER: a red non-test leg is never rendered as "nothing failing"', () => {
  it('does not blank a MEASURED failing-leg list just because a repair is open', () => {
    const measurement = gateFailingTestsMeasurement({
      failingTests: [...RED_LINT_LEG_WITH_OPEN_REPAIR.failingTests],
      measured: true,
      inconclusive: { ...RED_LINT_LEG_WITH_OPEN_REPAIR.inconclusive } as never,
    });

    expect(
      measurement.failingTests,
      'A list that was MEASURED and POPULATED must survive an open repair. Discarding it ' +
        'renders "we measured two failing lint legs" identically to "nothing is failing" — ' +
        'the exact confusion this plan exists to remove. If the list must be qualified as ' +
        'carried-not-current, LABEL it (that is what `measured` is for); do not erase it.',
    ).toEqual(['lint:design-primitives', 'lint:plane-integrity']);
  });

  it('names the failing legs on the owner brief while the gate is red and repairing', () => {
    const brief = composeGateOwnerBrief(ownerBriefInput());

    expect(brief.whyNot, 'a red gate must explain itself').not.toBeNull();
    expect(
      brief.whyNot?.failingLegs ?? [],
      'gate.greenCheckpoint.ownerBrief is THE headline cell (D-002), and it is the one an ' +
        'agent reads first. Reporting an empty failingLegs list on a red gate is a false ' +
        'all-clear, not a cautious omission.',
    ).toContain('lint:design-primitives');
  });

  it('never reports mainGreen:false with an empty explanation', () => {
    const brief = composeGateOwnerBrief(ownerBriefInput());
    if (brief.mainGreen?.value === false) {
      const legs = brief.whyNot?.failingLegs ?? [];
      const measured = brief.whyNot?.measured ?? null;
      // Either name the legs, or state positively that they were NOT measured. What is
      // forbidden is the third reading: an empty list presented as a measurement.
      expect(
        legs.length > 0 || measured === false || measured === null,
        'an empty failingLegs list stamped `measured: true` claims a measurement showing ' +
          'nothing failing, on a gate that is red. "Measured empty" and "not measured" must ' +
          'be structurally distinguishable (P-012).',
      ).toBe(true);
      expect(
        legs.length > 0,
        `mainGreen=false with failingLegs=[] and measured=${String(measured)}. A reader ` +
          `cannot act on this: the gate says it is red and simultaneously names nothing. ` +
          `This is the live 2026-09-03 reading, reproduced.`,
      ).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * 5. THE ANSWERED ENTRIES ARE REGRESSION-COVERED
 *
 * D-003 §1: the 15 questions answered today "are not therefore safe: P-013 must
 * assert they still resolve, so a refactor for another entry cannot silently break
 * one." The owner brief carries four of them, and it is the surface most likely to
 * be re-shaped by P-005/P-010 — so its paths are walked with the SAME `pathExists`
 * that `assessmentFrom` uses, making "the test can find the path" and "the read can
 * find the path" one claim rather than two that can disagree.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('P-013: entries answered today keep resolving', () => {
  const answeredBriefPaths = QUESTIONS.filter(
    (q) => inScope(q) && q.status === 'answered' && q.binding.cell === 'gate.greenCheckpoint.ownerBrief',
  );

  it.each(answeredBriefPaths.map((q) => [q.id, q.question, q.binding.path] as const))(
    '#%s %s -> ownerBrief.%s still resolves',
    (id, question, path) => {
      const brief = composeGateOwnerBrief(ownerBriefInput());
      const found = pathExists(brief as unknown as Record<string, unknown>, path);
      expect(
        found.exists,
        `Q#${id} ("${question}") was ANSWERED at audit time via ownerBrief.${path}, and that ` +
          `path no longer resolves (missing at "${found.missingAt ?? path}"). An entry may be ` +
          `re-bound, but it may not silently stop being answerable — update the binding in ` +
          `this table if the surface moved.`,
      ).toBe(true);
    },
  );

  /**
   * The gap entries that name an EXISTING cell but a path it does not yet carry (#24's
   * per-field attestations). The registration block above cannot see these — the cell is
   * registered, so it passes — which is why coverage needs a path-level check too. This is
   * the "a surface that merely exists" case D-003 §3 warns the test must not be satisfied by.
   */
  const gapBriefPaths = QUESTIONS.filter(
    (q) => inScope(q) && q.status !== 'answered' && q.binding.cell === 'gate.greenCheckpoint.ownerBrief',
  );

  it.each(gapBriefPaths.map((q) => [q.id, q.question, q.binding.path, q.owedBy] as const))(
    '#%s %s -> ownerBrief.%s resolves',
    (id, question, path, owedBy) => {
      const brief = composeGateOwnerBrief(ownerBriefInput());
      const found = pathExists(brief as unknown as Record<string, unknown>, path);
      expect(
        found.exists,
        `Q#${id} ("${question}") is bound to ownerBrief.${path}, which the composed brief ` +
          `does not carry (missing at "${found.missingAt ?? path}"). Owed by ${owedBy}. The ` +
          `CELL exists, so cell-level coverage passes — this is the path-level gap that ` +
          `check cannot see.`,
      ).toBe(true);
    },
  );
});
