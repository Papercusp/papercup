import { describe, expect, it } from 'vitest';
import { EMPTY_GENOME, type Genome } from '../instance-spec/genome';
import {
  applyArmGenome,
  isSafetyExcluded,
  knobAxis,
  type KnobArm,
  partitionArm,
  validateArm,
} from './knob-space';

const arm = (knobs: Record<string, unknown>): KnobArm => ({ id: 'b', knobs });

describe('isSafetyExcluded', () => {
  it('rejects an excluded prefix exactly and dot-nested', () => {
    expect(isSafetyExcluded('budget')).toBe(true);
    expect(isSafetyExcluded('budget.cap')).toBe(true);
    expect(isSafetyExcluded('learning-governor.loop')).toBe(true);
    expect(isSafetyExcluded('auth.token')).toBe(true);
  });
  it('does not over-match a non-dot prefix collision', () => {
    expect(isSafetyExcluded('budgets')).toBe(false); // not 'budget' nor 'budget.*'
    expect(isSafetyExcluded('model.worker')).toBe(false);
    expect(isSafetyExcluded('genome.prompts.queen')).toBe(false);
  });
});

describe('knobAxis', () => {
  it('returns the first dot-segment', () => {
    expect(knobAxis('genome.config.placement.queen')).toBe('genome');
    expect(knobAxis('model')).toBe('model');
  });
});

describe('validateArm', () => {
  const slice = ['genome.prompts', 'overlay', 'model'];
  it('accepts an arm fully inside the slice', () => {
    expect(validateArm(arm({ 'genome.prompts.queen': 'x', 'model.worker': 'claude-opus-4-8' }), slice)).toEqual({
      ok: true,
      outOfSlice: [],
      excluded: [],
    });
  });
  it('flags an out-of-slice knob', () => {
    const v = validateArm(arm({ 'genome.config.wake.minSleepSec': 30 }), slice);
    expect(v.ok).toBe(false);
    expect(v.outOfSlice).toEqual(['genome.config.wake.minSleepSec']);
  });
  it('flags a safety-excluded knob even if it would match a broad slice', () => {
    const v = validateArm(arm({ 'budget.cap': 999 }), ['budget']);
    expect(v.ok).toBe(false);
    expect(v.excluded).toEqual(['budget.cap']);
    expect(v.outOfSlice).toEqual([]); // excluded takes precedence — never reaches the slice check
  });
});

describe('partitionArm', () => {
  it('folds genome.prompts and genome.config into a GenomeDelta', () => {
    const p = partitionArm(
      arm({ 'genome.prompts.queen.placement': 'overlay-text', 'genome.config.placement.queen': 'dedicated' }),
    );
    expect(p.genomeDelta).toEqual({
      prompts: { 'queen.placement': 'overlay-text' },
      config: { placement: { queen: 'dedicated' } },
    });
  });
  it('routes overlay.* and model.* to their own records', () => {
    const p = partitionArm(arm({ 'overlay.prompts.worker': 'be terse', 'model.validator': 'claude-haiku-4-5-20251001' }));
    expect(p.overlay).toEqual({ 'prompts.worker': 'be terse' });
    expect(p.models).toEqual({ validator: 'claude-haiku-4-5-20251001' });
  });
  it('supports prompt removal via null', () => {
    const p = partitionArm(arm({ 'genome.prompts.queen': null }));
    expect(p.genomeDelta.prompts).toEqual({ queen: null });
  });
  it('throws on a safety-excluded knob (defense in depth)', () => {
    expect(() => partitionArm(arm({ 'deploy.gate': 'off' }))).toThrow(/safety-excluded knob: deploy.gate/);
  });
  it('throws on an unknown axis', () => {
    expect(() => partitionArm(arm({ 'wat.x': 1 }))).toThrow(/unknown knob axis: wat/);
  });
  it('throws on a non-string model id and an unknown genome config axis', () => {
    expect(() => partitionArm(arm({ 'model.worker': 7 }))).toThrow(/must be a model-id string/);
    expect(() => partitionArm(arm({ 'genome.config.nope.k': 1 }))).toThrow(/unknown genome.config axis: nope/);
  });
});

describe('applyArmGenome', () => {
  it('merges the arm onto a base genome', () => {
    const base: Genome = { prompts: { queen: 'base' }, config: { wake: { minSleepSec: 60 } } };
    const out = applyArmGenome(base, arm({ 'genome.prompts.worker': 'new', 'genome.config.placement.queen': 'dedicated' }));
    expect(out.prompts).toEqual({ queen: 'base', worker: 'new' });
    expect(out.config).toEqual({ placement: { queen: 'dedicated' }, wake: { minSleepSec: 60 } });
  });
  it('an empty arm leaves the genome unchanged (the champion baseline)', () => {
    expect(applyArmGenome(EMPTY_GENOME, arm({}))).toEqual(EMPTY_GENOME);
  });
});
