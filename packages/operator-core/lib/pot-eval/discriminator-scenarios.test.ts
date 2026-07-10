import { describe, it, expect } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import {
  DISCRIMINATOR_SCENARIOS,
  PERTURBATION_SENSITIVE_BETS,
  discriminatorsFor,
  getDiscriminator,
  type DiscriminatorKind,
} from './discriminator-scenarios';
import { getScenario } from './scenarios';

const FLAG_VALUES = new Set<string>(Object.values(FLAGS));

describe('discriminator scenarios', () => {
  it('has the three home-turf discriminators', () => {
    const kinds = DISCRIMINATOR_SCENARIOS.map((d) => d.kind).sort();
    expect(kinds).toEqual(['crash-recovery', 'multi-swarm', 'requirements-shift'] as DiscriminatorKind[]);
  });

  it('every discriminator perturbs a REAL base corpus scenario', () => {
    for (const d of DISCRIMINATOR_SCENARIOS) {
      expect(getScenario(d.baseScenarioId), `base '${d.baseScenarioId}' for ${d.id}`).toBeDefined();
    }
  });

  it('every perturbation fires within [0,1] of the run', () => {
    for (const d of DISCRIMINATOR_SCENARIOS) {
      expect(d.perturbation.atProgress).toBeGreaterThanOrEqual(0);
      expect(d.perturbation.atProgress).toBeLessThanOrEqual(1);
      expect(d.perturbation.action.length).toBeGreaterThan(0);
    }
  });

  it('every favorsBets entry is a real registered flag key', () => {
    for (const d of DISCRIMINATOR_SCENARIOS) {
      expect(d.favorsBets.length, `${d.id} favors at least one bet`).toBeGreaterThan(0);
      for (const f of d.favorsBets) expect(FLAG_VALUES.has(f), `${d.id} favors real flag ${f}`).toBe(true);
    }
  });

  it('is SYMMETRIC: every perturbation-sensitive bet has a home-turf discriminator', () => {
    for (const bet of PERTURBATION_SENSITIVE_BETS) {
      expect(discriminatorsFor(bet).length, `${bet} has a home-turf discriminator`).toBeGreaterThan(0);
    }
  });

  it('maps the exclusion bet to multi-swarm and the durable-record bets to crash/shift', () => {
    expect(discriminatorsFor(FLAGS.TOUCH_SET_EXCLUSION).map((d) => d.id)).toEqual(['multi-swarm']);
    expect(discriminatorsFor(FLAGS.WORKITEM_AMEND).map((d) => d.id).sort()).toEqual([
      'crash-recovery',
      'requirements-shift',
    ]);
  });

  it('getDiscriminator resolves by id', () => {
    expect(getDiscriminator('crash-recovery')?.kind).toBe('crash-recovery');
    expect(getDiscriminator('nope')).toBeUndefined();
  });
});
