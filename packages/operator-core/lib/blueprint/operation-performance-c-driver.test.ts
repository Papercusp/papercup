import { describe, expect, it } from 'vitest';
import { BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import { P013C_PROGRAM_STEPS, P013C_SOURCE, programStepNames } from './operation-performance-c-driver';

describe('P-013 workload C driver helpers', () => {
  it('keeps only program step names, in recorded order, dropping settlement and child steps', () => {
    expect(programStepNames([
      { name: 'op-s1' }, { name: 'op-s2' }, { name: 'op-s3' }, { name: 'op-s4' },
      { name: 'gate-resolve' }, { name: 'settle-accepted-root' }, { name: 'DBOS.getResult' },
    ])).toEqual([...P013C_PROGRAM_STEPS]);
  });

  it('declares a 4-step program with a conditional step, a conditional gate and stable ids', () => {
    const blueprint = BlueprintSchema.parse(P013C_SOURCE);
    const steps = blueprint.spine.steps ?? [];
    expect(steps.map((step) => `op-${step.id}`)).toEqual(P013C_PROGRAM_STEPS.slice(0, 4));
    expect(steps.filter((step) => step.when).map((step) => step.id)).toEqual(['s3']);
    expect(blueprint.spine.gate?.map((branch) => branch.op)).toEqual(['resolve', 'resolve']);
    expect(blueprint.operations?.[0]?.execution).toMatchObject({ kind: 'program' });
  });
});
