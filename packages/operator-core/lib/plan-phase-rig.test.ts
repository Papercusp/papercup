import { describe, expect, it } from 'vitest';
import { phaseRequiresTwoMachineRig } from './plan-phase-rig';

describe('phaseRequiresTwoMachineRig', () => {
  it('recognizes the live Phase 3 two-machine lane', () => {
    expect(
      phaseRequiresTwoMachineRig(
        'Phase 3 — Live 2-machine hive-git drill (LIVE-G gate — in-process green != live green)',
      ),
    ).toBe(true);
  });

  it.each([
    [null, 'null phase'],
    [undefined, 'missing phase'],
    ['Phase 2 — Live 2-machine preparation', 'different phase'],
    ['Phase 3 — Single-machine verification', 'no two-machine marker'],
    ['ordinary plan section', 'ordinary section'],
  ])('rejects %s (%s)', (phase) => {
    expect(phaseRequiresTwoMachineRig(phase)).toBe(false);
  });
});
