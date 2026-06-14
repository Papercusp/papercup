import { beforeEach, describe, expect, it } from 'vitest';
import {
  TestRegistry,
  knobInSlice,
  listTests,
  registerTest,
  requireTest,
  resetTestRegistry,
  type TestDescriptor,
} from './registry';

function fakeDescriptor(over: Partial<TestDescriptor> = {}): TestDescriptor {
  return {
    id: 'replay',
    summary: 'counterfactual replay over history',
    kind: 'replay',
    fidelityTier: 'offline',
    costClass: 'free',
    knobSlice: ['genome.prompts', 'overlay'],
    metrics: { signals: ['divergence'], rubricDimensions: ['fidelity'] },
    run: async () => ({ ok: true }),
    ...over,
  };
}

describe('TestRegistry', () => {
  it('registers and resolves a descriptor', () => {
    const reg = new TestRegistry();
    const d = fakeDescriptor();
    reg.register(d);
    expect(reg.size).toBe(1);
    expect(reg.get('replay')).toBe(d);
    expect(reg.require('replay')).toBe(d);
  });

  it('throws on a duplicate id (a double-register is a wiring bug)', () => {
    const reg = new TestRegistry();
    reg.register(fakeDescriptor());
    expect(() => reg.register(fakeDescriptor())).toThrow(/already registered: replay/);
  });

  it('require() throws with the known ids on an unknown descriptor', () => {
    const reg = new TestRegistry();
    reg.register(fakeDescriptor({ id: 'gym' }));
    expect(reg.get('nope')).toBeUndefined();
    expect(() => reg.require('nope')).toThrow(/unknown test descriptor: nope \(registered: gym\)/);
  });

  it('list() returns metadata only (no run) in id order', () => {
    const reg = new TestRegistry();
    reg.register(fakeDescriptor({ id: 'instance', kind: 'whole-instance' }));
    reg.register(fakeDescriptor({ id: 'gym', kind: 'component' }));
    const entries = reg.list();
    expect(entries.map((e) => e.id)).toEqual(['gym', 'instance']);
    expect(entries[0]).not.toHaveProperty('run');
    expect(entries[0]).toMatchObject({ id: 'gym', kind: 'component', fidelityTier: 'offline' });
  });

  it('the opaque run adapter delegates unchanged', async () => {
    const reg = new TestRegistry();
    reg.register(fakeDescriptor({ run: async (req) => ({ echoed: req }) }));
    const out = await reg.require('replay').run({ arm: 'b' }, {});
    expect(out).toEqual({ echoed: { arm: 'b' } });
  });

  it('reset() clears registrations', () => {
    const reg = new TestRegistry();
    reg.register(fakeDescriptor());
    reg.reset();
    expect(reg.size).toBe(0);
  });
});

describe('the module-level default registry', () => {
  beforeEach(() => resetTestRegistry());

  it('registerTest / listTests / requireTest operate on the default', () => {
    registerTest(fakeDescriptor());
    expect(listTests().map((e) => e.id)).toEqual(['replay']);
    expect(requireTest('replay').id).toBe('replay');
  });
});

describe('knobInSlice', () => {
  const slice = ['genome.prompts', 'genome.config.placement', 'model'];

  it('matches an exact address', () => {
    expect(knobInSlice('model', slice)).toBe(true);
    expect(knobInSlice('genome.prompts', slice)).toBe(true);
  });

  it('matches a dot-prefixed child', () => {
    expect(knobInSlice('genome.prompts.queen', slice)).toBe(true);
    expect(knobInSlice('genome.config.placement.queen', slice)).toBe(true);
    expect(knobInSlice('model.worker', slice)).toBe(true);
  });

  it('rejects a knob outside the slice (incl. a non-dot prefix collision)', () => {
    expect(knobInSlice('genome.config.wake', slice)).toBe(false);
    expect(knobInSlice('models', slice)).toBe(false); // not 'model' nor 'model.*'
    expect(knobInSlice('budget.cap', slice)).toBe(false); // safety-excluded never in any slice
  });
});
