import { describe, it, expect, beforeEach } from 'vitest';
import { validateCellSpec, getCell, __resetCellRegistryForTests } from './cell-registry';
import { GIT_PIPELINE_POSITION_CELL, registerBuiltinCells } from './cell-registrations';

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
    expect(getCell('git.pipelinePosition')?.resolver).toContain('gitPipelinePosition()');
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
