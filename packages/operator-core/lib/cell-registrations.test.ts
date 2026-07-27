import { describe, it, expect, beforeEach } from 'vitest';
import { validateCellSpec, getCell, listCellsUnchecked, __resetCellRegistryForTests } from './cell-registry';
import {
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
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

  it('registers all five built-ins, and does so idempotently', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
    expect(listCellsUnchecked().map((c) => c.cell)).toEqual([
      'deploy.3070.sha',
      'gate.greenCheckpoint.candidate',
      'gate.greenCheckpoint.verdict',
      'git.mainBehindStaging',
      'git.pipelinePosition',
    ]);
  });

  /**
   * #D-065 IS THE ASSERTION. Four cells naming one resolver is axis 5 satisfied (many
   * lenses over one derivation), and the thing that would break it is someone "fixing"
   * a cell by pointing it at a second resolver — or at a hand-rolled re-derivation of
   * the same values, which is the failure axis 5 exists to prevent.
   */
  it('all five are lenses over the ONE gitPipelinePosition resolver', () => {
    const resolvers = new Set(BUILTIN_CELLS.map((c) => c.resolver));
    expect(resolvers.size).toBe(1);
    expect([...resolvers][0]).toContain('gitPipelinePosition()');
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
