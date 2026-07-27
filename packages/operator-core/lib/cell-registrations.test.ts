import { describe, it, expect, beforeEach } from 'vitest';
import { validateCellSpec, getCell, listCellsUnchecked, __resetCellRegistryForTests } from './cell-registry';
import {
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  AGENT_GOAL_CELL,
  BUILTIN_CELLS,
  registerBuiltinCells,
} from './cell-registrations';

/**
 * P-006. The value of this suite is not "a cell is registered" — it is that the
 * FLAGSHIP cell, the one the contract was partly derived from, passes the contract's
 * own gate honestly rather than by declaring its way around it.
 */
describe('P-006: git.pipelinePosition registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(GIT_PIPELINE_POSITION_CELL)).toEqual([]);
  });

  it('registers and is retrievable', () => {
    registerBuiltinCells();
    // P-019: reads are audience-scoped. This cell is workspace-visible, so any
    // reader sees it — which is itself the assertion worth making here.
    expect(getCell('git.pipelinePosition', { ownerId: 'su-anyone' })?.resolver).toContain(
      'gitPipelinePosition()',
    );
  });

  it('is idempotent — registering the built-ins twice does not throw', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });

  /**
   * THE REGRESSION THAT MATTERS. `nullable: true` is only honest because the resolver
   * now HOISTS its unreadable legs. If someone later removes `positionsUnknown` from
   * the result and drops the declaration with it, this cell silently reverts to
   * claiming a two-valued headline that is in fact three-valued — which is precisely
   * the state P-006 found it in.
   */
  it('declares the unknown hoist, and is REJECTED without it', () => {
    expect(GIT_PIPELINE_POSITION_CELL.nullable).toBe(true);
    expect(GIT_PIPELINE_POSITION_CELL.unknownHoist).toBe('positionsUnknown');

    const withoutHoist = { ...GIT_PIPELINE_POSITION_CELL, unknownHoist: undefined };
    const rejections = validateCellSpec(withoutHoist);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ axis: 2, rule: 'unknown-not-hoisted' });
  });

  /**
   * Axis 1's independence rule, locked against the specific mistake P-006 nearly
   * made: pairing the headline with `stages[].health`, which for the serving stage is
   * COMPUTED FROM the falsifier and therefore adds no new information.
   */
  it('names a falsifier from an independent measurement, not a re-projection', () => {
    const f = GIT_PIPELINE_POSITION_CELL.falsifier;
    expect(f.field).not.toBe(GIT_PIPELINE_POSITION_CELL.headline);
    expect(f.measurement).not.toContain(GIT_PIPELINE_POSITION_CELL.headline);
    // A self-referential falsifier must be caught rather than merely discouraged.
    const selfFalsifying = {
      ...GIT_PIPELINE_POSITION_CELL,
      falsifier: { ...f, measurement: 'recomputed from positions.deployed' },
    };
    expect(validateCellSpec(selfFalsifying).some((r) => r.axis === 1)).toBe(true);
  });

  /** Axis 3: `parameter`, said out loud. Inference would have concluded `global`. */
  it('declares caller-relativity explicitly rather than leaving it inferred', () => {
    expect(GIT_PIPELINE_POSITION_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
  });
});

/**
 * P-007. Four sibling cells over the SAME resolver (#D-065). What is worth testing is
 * not that five specs validate — the constructor would have thrown at import time — but
 * the handful of properties that would silently regress into a confidently-wrong cell.
 */
describe('P-007: the four verdict cells', () => {
  beforeEach(() => __resetCellRegistryForTests());

  const NEW_CELLS = [GATE_VERDICT_CELL, GATE_CANDIDATE_CELL, DEPLOYED_SHA_CELL, MAIN_BEHIND_STAGING_CELL];

  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s validates with zero rejections', (_id, spec) => {
    expect(validateCellSpec(spec)).toEqual([]);
  });

  it('registers every built-in, and does so idempotently', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
    expect(listCellsUnchecked().map((c) => c.cell)).toEqual([
      // P-016. The first cell here that is about an AGENT rather than the tree.
      'agent.goal',
      'deploy.3070.sha',
      'gate.greenCheckpoint.candidate',
      'gate.greenCheckpoint.verdict',
      'git.mainBehindStaging',
      'git.pipelinePosition',
    ]);
  });

  /**
   * #D-065 IS THE ASSERTION. Five cells naming one resolver is axis 5 satisfied (many
   * lenses over one derivation), and the thing that would break it is someone "fixing"
   * a cell by pointing it at a second resolver — or at a hand-rolled re-derivation of
   * the same values, which is the failure axis 5 exists to prevent.
   *
   * ⚠ SCOPED TO THE PIPELINE FAMILY, not to BUILTIN_CELLS. P-016's `agent.goal`
   * legitimately has its OWN resolver — it derives a different thing from
   * different tables. Asserting "the registry has exactly one resolver" would
   * therefore be asserting that no second SUBJECT may ever be registered, which is
   * not what D-065 said and would block the registry from growing at all. The
   * invariant that matters is that the pipeline cells do not sprout a second
   * derivation among THEMSELVES.
   */
  it('the pipeline family are all lenses over the ONE gitPipelinePosition resolver', () => {
    const family = [GIT_PIPELINE_POSITION_CELL, ...NEW_CELLS];
    const resolvers = new Set(family.map((c) => c.resolver));
    expect(resolvers.size).toBe(1);
    expect([...resolvers][0]).toContain('gitPipelinePosition()');
  });

  /** Every registered cell still names exactly one resolver of its own — the
   *  per-cell half of axis 5, which the family assertion above no longer covers. */
  it('no two cells share a cell id, and every cell names a resolver', () => {
    expect(new Set(BUILTIN_CELLS.map((c) => c.cell)).size).toBe(BUILTIN_CELLS.length);
    for (const c of BUILTIN_CELLS) expect(c.resolver.trim()).not.toBe('');
  });

  /**
   * THE REGRESSION THAT MATTERS MOST, and the one this item nearly shipped wrong.
   *
   * `gate.consecutiveReds` is typed `number`, so `nullable: false` is literally true of
   * the shipped type and passes this gate with zero rejections — the exact incentive the
   * P-006 note records ("the gate rewarded the weaker cell"). It is nullable because
   * `git-pipeline-stats` applies `?? 0` to an absent counter, making a `0` that reads as
   * a passing gate. If someone later removes the hoist because "the type says number",
   * this fails.
   */
  it('declares the reds counter NULLABLE despite its non-null type, and is rejected without the hoist', () => {
    expect(GATE_VERDICT_CELL.nullable).toBe(true);
    expect(GATE_VERDICT_CELL.unknownHoist).toBe('verdictUnknown');

    const rejections = validateCellSpec({ ...GATE_VERDICT_CELL, unknownHoist: undefined });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ axis: 2, rule: 'unknown-not-hoisted' });
  });

  /** Every one of the four degrades into GOOD NEWS, so every one must hoist. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s hoists its unknown', (_id, spec) => {
    expect(spec.nullable).toBe(true);
    expect(spec.unknownHoist).toBeTruthy();
  });

  /**
   * Cells 1 and 4 are MUTUAL falsifiers — each is the other's headline. That is the
   * design (a test-verdict tally and a git ancestry check are different apparatus), and
   * it is worth pinning because it looks like a mistake to a later reader who might
   * "fix" it into a self-referential pairing.
   */
  it('pairs the gate tally and the ancestry check as mutual falsifiers', () => {
    expect(GATE_VERDICT_CELL.falsifier.field).toBe(MAIN_BEHIND_STAGING_CELL.headline);
    expect(MAIN_BEHIND_STAGING_CELL.falsifier.field).not.toBe(GATE_VERDICT_CELL.headline);
    // Independence is per-cell: neither may falsify itself.
    for (const spec of NEW_CELLS) {
      expect(spec.falsifier.field).not.toBe(spec.headline);
      expect(validateCellSpec(spec).some((r) => r.axis === 1)).toBe(false);
    }
  });

  /**
   * Axis 3 differs ACROSS cells that share a resolver, which is the concrete evidence
   * that relativity belongs to the cell and not the derivation: the candidate cell is
   * per-path, the other three are global. An author copying a spec would get this wrong.
   */
  it('declares caller-relativity per CELL, not per resolver', () => {
    expect(GATE_CANDIDATE_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
    expect(GATE_VERDICT_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(DEPLOYED_SHA_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(MAIN_BEHIND_STAGING_CELL.callerRelativity).toEqual({ kind: 'global' });
  });

  /**
   * EI-11012 / why-chain.ts: a nonzero staging buffer is the NORMAL steady state, and
   * the naive "behind = broken" reading made the deploy stage report degraded
   * essentially always, shadowing every real cause. The `kills` text is the only place
   * that correction is carried to a cell author, so pin its direction.
   */
  it('kills the "lag means stalled" misreading, not the naive inverse', () => {
    const kills = MAIN_BEHIND_STAGING_CELL.falsifier.kills.toLowerCase();
    expect(kills).toContain('normal steady state');
    expect(MAIN_BEHIND_STAGING_CELL.falsifier.measurement).toContain('SCHEDULER-LIVENESS');
  });

  /** Axis 4 admits no fixture-only registration, and every one of these four carries a
   *  verbatim live read rather than a promise that one happened. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s cites a real live exercise', (_id, spec) => {
    expect(spec.provenance.liveExercised).toBe(true);
    expect(spec.provenance.evidence).toContain('dev:pipeline_position');
    expect(spec.provenance.evidence).toMatch(/2026-07-27/);
  });
});

/**
 * P-016 — the agent goal cell.
 *
 * The assertions worth making here are the ones that would go red if someone
 * "simplified" the cell back to the plan item's literal wording. The precedence
 * sentence is under-determined on the live fleet, and the falsifier is what
 * carries that finding to the next author.
 */
describe('P-016: agent.goal registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(AGENT_GOAL_CELL)).toEqual([]);
  });

  it('registers and is retrievable by any reader — a blocked peer is the point', () => {
    registerBuiltinCells();
    expect(getCell('agent.goal', { ownerId: 'su-anyone' })?.resolver).toContain('resolveOwnerGoal()');
  });

  /**
   * Axis 3. The whole cell is "about WHICH agent", so a global or ambient
   * declaration would be a category error — and `cell-read.ts` names this cell as
   * the motivating example for the `subject` parameter.
   */
  it('is parameter-relative on ownerId, not global', () => {
    expect(AGENT_GOAL_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'ownerId' });
  });

  /**
   * Axis 1. The falsifier must be the LINK GRAPH, not staleness: staleness is
   * already carried by HolderContext rule (e), so reusing it would add
   * interpretation with no new information — which is what axis 1 rejects.
   */
  it('falsifies via the coord_links edge, and cites the measurement that earned it', () => {
    expect(AGENT_GOAL_CELL.falsifier.measurement).toContain('coord_links');
    expect(AGENT_GOAL_CELL.falsifier.measurement).not.toMatch(/stale/i);
    // The count is the load-bearing part: it is why precedence alone is not enough.
    expect(AGENT_GOAL_CELL.falsifier.kills).toContain('3 of 19');
  });

  /** Axis 2. A held-nothing agent has no goal, and the competing claims must be
   *  hoisted to the RESULT so a caller who skips `agreement` still cannot miss them. */
  it('is nullable and hoists the competing claims', () => {
    expect(AGENT_GOAL_CELL.nullable).toBe(true);
    expect(AGENT_GOAL_CELL.unknownHoist).toBe('goal.competing');
  });

  /**
   * P-019. Narrowing this cell would make it useless for the thing D-051 built it
   * for — a BLOCKED PEER reading the holder's goal — while promising a secrecy
   * the claim surfaces do not actually provide.
   */
  it('is workspace-visible and hive-local', () => {
    expect(AGENT_GOAL_CELL.visibility).toEqual({ kind: 'workspace' });
    expect(AGENT_GOAL_CELL.federation).toEqual({ kind: 'local' });
  });

  /**
   * A registered cell with no dispatchable poll tool is unreadable forever —
   * `readCell` would return insufficient-data — which is the "surface #29"
   * failure D-010's adoption gate exists to prevent.
   */
  it('names a poll resolver so the cell is actually readable', () => {
    expect(AGENT_GOAL_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'coord:goal',
      path: 'goal.ref',
    });
  });

  /** Axis 6 absent: the four SOURCES are a precedence, not a sequence. Declaring
   *  them as stages would invite reading `fleet-mission` as "further along". */
  it('declares no stage order', () => {
    expect(AGENT_GOAL_CELL.ordered).toBeUndefined();
  });

  it('is in BUILTIN_CELLS and does not collide with an existing resolver', () => {
    expect(BUILTIN_CELLS).toContain(AGENT_GOAL_CELL);
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });
});
